'use strict';

/**
 * OATHKEEPER tests — policy engine, live server, proof integrity,
 * and the privacy invariant: no public endpoint ever leaks the sealed
 * policy (limit, block list, salt).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const snarkjs = require('snarkjs');

const policy = require('../src/policy');

const PORT = 10099;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc = null;

async function waitForHealth(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

before(async () => {
  serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
  });
  await waitForHealth();
});

after(() => { if (serverProc) serverProc.kill('SIGTERM'); });

// ------------------------------------------------------------ policy unit
test('policy engine: cap and blocklist verdicts', () => {
  const p = { limitCents: 5000, blockedCategories: ['gambling'] };
  assert.equal(policy.evaluate({ amountCents: 3000, category: 'groceries' }, p).decision, 'ALLOW');
  assert.equal(policy.evaluate({ amountCents: 5000, category: 'games' }, p).decision, 'ALLOW');
  assert.equal(policy.evaluate({ amountCents: 6000, category: 'groceries' }, p).decision, 'BLOCK');
  assert.equal(policy.evaluate({ amountCents: 100, category: 'gambling' }, p).decision, 'BLOCK');
  assert.equal(policy.evaluate({ amountCents: -5, category: 'groceries' }, p).decision, 'BLOCK');
  assert.deepEqual(policy.blockedSlots(p), [3, 0, 0, 0, 0, 0, 0, 0]);
});

// ------------------------------------------------------------- live server
test('server: seal policy, evaluate with proofs, no private leak', async () => {
  // Seal a policy: cap $50, block gambling + subscriptions.
  const sealRes = await fetch(`${BASE}/api/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limitUsd: 50, blockedCategories: ['gambling', 'subscriptions'] }),
  });
  const seal = await sealRes.json();
  assert.ok(seal.ok && seal.commitment, 'sealing returns a commitment');
  assert.ok(!JSON.stringify(seal).includes('salt'), 'seal response must not leak salt');

  // Public state must not contain private fields.
  const state = await (await fetch(`${BASE}/api/state`)).json();
  const stateStr = JSON.stringify(state);
  assert.equal(state.commitment, seal.commitment);
  assert.ok(!stateStr.includes('"limitCents"'), 'state leaks limitCents');
  assert.ok(!stateStr.includes('"salt"'), 'state leaks salt');
  assert.ok(!stateStr.includes('"blockedCategories"'), 'state leaks blockedCategories');

  // Honest ALLOW with a locally verified proof.
  const allow = await (await fetch(`${BASE}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountUsd: 30, category: 'groceries' }),
  })).json();
  assert.equal(allow.decision, 'ALLOW');
  assert.equal(allow.verifiedLocally, true);
  assert.equal(allow.publicSignals.length, 4);
  assert.equal(allow.publicSignals[2], '1', 'decision signal must be ALLOW=1');

  // BLOCK over the cap.
  const overCap = await (await fetch(`${BASE}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountUsd: 60, category: 'groceries' }),
  })).json();
  assert.equal(overCap.decision, 'BLOCK');
  assert.equal(overCap.rule, 'above-cap');
  assert.equal(overCap.verifiedLocally, true);

  // BLOCK a blocked category under the cap.
  const blocked = await (await fetch(`${BASE}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountUsd: 10, category: 'gambling' }),
  })).json();
  assert.equal(blocked.decision, 'BLOCK');
  assert.equal(blocked.rule, 'blocked-category');

  // Audit log: 3 entries, still no private leak.
  const audit = await (await fetch(`${BASE}/api/audit`)).json();
  assert.equal(audit.entries.length, 3);
  const auditStr = JSON.stringify(audit);
  assert.ok(!auditStr.includes('"salt"'), 'audit leaks salt');
  assert.ok(!auditStr.includes('"limitCents"'), 'audit leaks limitCents');

  // Independent verification: anyone can re-verify the ALLOW proof
  // from the public proof + vkey endpoints alone.
  const proofDoc = await (await fetch(`${BASE}${allow.proofUrl}`)).json();
  const vkey = await (await fetch(`${BASE}/api/vkey`)).json();
  const ok = await snarkjs.groth16.verify(vkey, proofDoc.publicSignals, proofDoc.proof);
  assert.equal(ok, true, 'independent snarkjs verification of the ALLOW proof');

  // Owner reveal matches the policy we sealed.
  const reveal = await (await fetch(`${BASE}/api/reveal`, { method: 'POST' })).json();
  assert.equal(reveal.limitUsd, 50);
  assert.deepEqual([...reveal.blockedCategories].sort(), ['gambling', 'subscriptions']);
});
