'use strict';

/**
 * OATHKEEPER — an AI agent that proves it obeyed its owner's private
 * rules, without revealing them.
 *
 * The owner sets a private policy (per-transaction cap + blocked
 * categories). Only a Poseidon commitment to that policy is public.
 * Every autonomous ALLOW/BLOCK decision is shipped with a Groth16 proof
 * (verified locally with snarkjs, and on zkVerify via Kurier when a
 * Kurier API key is configured) that the decision is exactly the one
 * the committed policy dictates.
 *
 * Public API never returns the private policy fields (limit, blocked
 * list, salt) — see /api/state and /api/audit. The single exception is
 * the deliberate owner reveal at POST /api/reveal, a demo feature that
 * lets judges audit, after the fact, that the hidden rules were real.
 */

const crypto = require('crypto');
const express = require('express');
const path = require('path');

const policyEngine = require('./src/policy');
const prover = require('./src/prover');
const kurier = require('./src/kurier');
const store = require('./src/store');
const agentgames = require('./src/agentgames');

const PORT = process.env.PORT || 10000;

// ---------------------------------------------------------------- state
let state = store.load();
if (!state || !state.policy) {
  state = {
    // Fixed salt for the built-in default policy only: its terms are
    // public (README), and a deterministic salt keeps the boot
    // commitment stable across free-tier restarts. Policies sealed by
    // an owner through /api/policy always get a fresh random salt.
    policy: { ...policyEngine.DEFAULT_POLICY, salt: 20261119 },
    commitment: null,
    vkHash: null,
    audit: [],
  };
}

async function refreshCommitment() {
  state.commitment = await prover.computeCommitment(state.policy);
  store.save(state);
}

// ------------------------------------------------------- kurier (async)
async function submitToKurier(entry) {
  if (!kurier.configured()) {
    entry.kurier = { status: 'not_configured' };
    store.save(state);
    return;
  }
  try {
    entry.kurier = { status: 'submitting' };
    store.save(state);
    if (!state.vkHash) {
      state.vkHash = await kurier.registerVk(prover.getVkey());
      store.save(state);
    }
    const submitted = await kurier.submitProof(entry.proof, entry.publicSignals, state.vkHash);
    entry.kurier = {
      status: 'submitted',
      jobId: submitted.jobId,
      optimisticVerify: submitted.optimisticVerify ?? null,
      vkHash: state.vkHash,
    };
    store.save(state);
    const final = await kurier.waitForFinalized(submitted.jobId);
    entry.kurier = { ...entry.kurier, status: final.status, detail: final.detail };
    store.save(state);
  } catch (err) {
    entry.kurier = { status: 'error', error: String(err.message || err).slice(0, 300) };
    store.save(state);
  }
}

// ------------------------------------------------------------------ app
const app = express();

// Agent Games platform endpoint. The platform signs requests over the
// RAW body, so these routes take express.raw() and are registered
// BEFORE the JSON parser. The agent is registered with the bare domain,
// so POST / is handled identically to POST /agent.
const agentRaw = express.raw({ type: '*/*', limit: '256kb' });
app.post('/agent', agentRaw, agentgames.handleAgentPost);
app.post('/', agentRaw, agentgames.handleAgentPost);

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function publicAuditEntry(e) {
  return {
    id: e.id,
    ts: e.ts,
    amountCents: e.amountCents,
    category: e.category,
    decision: e.decision,
    rule: e.rule,
    reason: e.reason,
    commitment: e.commitment,
    publicSignals: e.publicSignals,
    verifiedLocally: e.verifiedLocally,
    kurier: e.kurier,
    proofUrl: `/api/proof/${e.id}`,
  };
}

// Agent Games health check: the platform requires EXACTLY this shape.
// (The OATHKEEPER demo's own state lives at /api/state.)
app.get('/health', (req, res) =>
  agentgames.sendSigned(res, agentgames.getSecret(), 200, { ok: true, protocolVersion: 'v1' }));

app.get('/api/state', async (req, res) => {
  if (!state.commitment) await refreshCommitment();
  res.json({
    commitment: state.commitment,
    categories: Object.keys(policyEngine.CATEGORIES),
    kurier: { configured: kurier.configured(), apiUrl: kurier.API_URL, vkHash: state.vkHash },
    auditCount: state.audit.length,
    // Deliberately absent: limitCents, blockedCategories, salt.
    privatePolicyExposed: false,
  });
});

// Owner sets a new private policy. The values are stored server-side
// only; the response contains nothing but the new public commitment.
app.post('/api/policy', async (req, res) => {
  try {
    const { limitUsd, blockedCategories } = req.body || {};
    const limitCents = Math.round(Number(limitUsd) * 100);
    if (!Number.isInteger(limitCents) || limitCents <= 0 || limitCents > 100_000_000) {
      return res.status(400).json({ error: 'limitUsd must be a positive amount up to 1,000,000' });
    }
    const blocked = Array.isArray(blockedCategories) ? blockedCategories : [];
    for (const c of blocked) {
      if (!(c in policyEngine.CATEGORIES)) {
        return res.status(400).json({ error: `unknown category: ${c}` });
      }
    }
    state.policy = {
      limitCents,
      blockedCategories: [...new Set(blocked)],
      salt: crypto.randomInt(1, 2 ** 31),
    };
    state.audit = []; // a new oath starts a clean audit log
    await refreshCommitment();
    res.json({
      ok: true,
      commitment: state.commitment,
      message: 'Policy sealed. Only its commitment is public — the cap and block list stay private.',
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/evaluate', async (req, res) => {
  try {
    const { amountUsd, category } = req.body || {};
    const amountCents = Math.round(Number(amountUsd) * 100);
    const tx = { amountCents, category };
    const verdict = policyEngine.evaluate(tx, state.policy);

    const { proof, publicSignals, commitment, verifiedLocally } =
      await prover.proveDecision(state.policy, tx, verdict.decisionBit);

    const entry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      amountCents,
      category,
      decision: verdict.decision,
      rule: verdict.rule,
      reason: verdict.reason,
      commitment,
      publicSignals,
      verifiedLocally,
      proof,
      kurier: { status: 'pending' },
    };
    state.audit.unshift(entry);
    state.audit = state.audit.slice(0, 100);
    store.save(state);
    submitToKurier(entry); // async — updates the audit entry in place

    res.json(publicAuditEntry(entry));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/audit', (req, res) => {
  res.json({ commitment: state.commitment, entries: state.audit.map(publicAuditEntry) });
});

app.get('/api/proof/:id', (req, res) => {
  const entry = state.audit.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'proof not found' });
  res.json({
    id: entry.id,
    decision: entry.decision,
    publicSignals: entry.publicSignals,
    publicSignalMeaning: ['amount (cents)', 'category (code)', 'decision (1=ALLOW, 0=BLOCK)', 'policy commitment (Poseidon)'],
    proof: entry.proof,
    verifiedLocally: entry.verifiedLocally,
    kurier: entry.kurier,
  });
});

app.get('/api/vkey', (req, res) => res.json(prover.getVkey()));

// Deliberate owner reveal (demo): lets a judge confirm, after trying to
// break the rules, what the sealed policy actually was — and that none
// of it ever appeared in a public signal or API response before now.
app.post('/api/reveal', (req, res) => {
  res.json({
    limitUsd: state.policy.limitCents / 100,
    blockedCategories: state.policy.blockedCategories,
    commitment: state.commitment,
    note: 'This is the first time these values leave the server. Every proof above was generated while they were sealed.',
  });
});

(async () => {
  await refreshCommitment();
  app.listen(PORT, () => {
    console.log(`OATHKEEPER listening on :${PORT}`);
    console.log(`policy commitment: ${state.commitment}`);
    console.log(`kurier configured: ${kurier.configured()} (${kurier.API_URL})`);
    console.log(`agent games endpoint: ${agentgames.getSecret() ? 'armed (HMAC secret set)' : 'unarmed — /agent answers 401 until AGENT_GAMES_HMAC_SECRET is set'}`);
  });
})();
