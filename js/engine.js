'use strict';

/**
 * OATHKEEPER — static mirror engine.
 *
 * The identical policy engine, Poseidon commitment and Groth16 proving
 * as the server build (src/policy.js + src/prover.js + server.js),
 * running entirely in the visitor's browser. The server keeps its state
 * in a JSON file; this mirror keeps it in localStorage. Response shapes
 * match the server's API exactly — the page's own script is unchanged
 * apart from asset paths, because a fetch shim answers its /api/* calls
 * locally. Kurier was never configured on the public demo, so proofs are
 * verified locally with snarkjs, exactly as the server demo reported.
 */

(function () {
  const realFetch = window.fetch.bind(window);

  // ---------------------------------------------------------- policy
  // src/policy.js, verbatim semantics.
  const CATEGORIES = {
    groceries: 1, games: 2, gambling: 3, subscriptions: 4,
    software: 5, transfers: 6, dining: 7, other: 8,
  };
  const DEFAULT_POLICY = { limitCents: 5000, blockedCategories: ['gambling', 'subscriptions'] };

  function blockedSlots(policy) {
    const codes = (policy.blockedCategories || [])
      .map((name) => CATEGORIES[name])
      .filter((code) => Number.isInteger(code));
    const slots = [...new Set(codes)].slice(0, 8);
    while (slots.length < 8) slots.push(0);
    return slots;
  }

  function verdict(decision, decisionBit, rule, reason) {
    return { decision, decisionBit, rule, reason };
  }

  function evaluate(tx, policy) {
    const amount = Number(tx.amountCents);
    const categoryName = tx.category;
    const code = CATEGORIES[categoryName];
    if (!Number.isInteger(amount) || amount <= 0) {
      return verdict('BLOCK', 0, 'invalid-amount', 'Amount must be a positive integer number of cents.');
    }
    if (code === undefined) {
      return verdict('BLOCK', 0, 'unknown-category', `Category "${categoryName}" is not a recognised category.`);
    }
    if ((policy.blockedCategories || []).includes(categoryName)) {
      return verdict('BLOCK', 0, 'blocked-category',
        `Category "${categoryName}" is on the owner's private block list.`);
    }
    if (amount > policy.limitCents) {
      return verdict('BLOCK', 0, 'above-cap',
        `$${(amount / 100).toFixed(2)} is above the owner's private per-transaction cap.`);
    }
    return verdict('ALLOW', 1, 'within-limits',
      `$${(amount / 100).toFixed(2)} is within the owner's private cap and "${categoryName}" is not blocked.`);
  }

  // ----------------------------------------------------------- store
  // localStorage mirror of src/store.js + server.js boot state.
  const STORE_KEY = 'oathkeeper.demo.v1';
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ policy: state.policy, audit: state.audit }));
    } catch { /* storage full/blocked — the demo still works in-memory */ }
  }
  let state = load();
  if (!state || !state.policy) {
    // Same fixed-salt default policy as a fresh server boot (server.js).
    state = { policy: { ...DEFAULT_POLICY, salt: 20261119 }, audit: [] };
  }
  state.commitment = null;

  // ---------------------------------------------------------- prover
  // src/prover.js, browser edition (snarkjs UMD + circomlibjs bundle).
  let poseidon = null;
  let vkey = null;
  async function init() {
    if (!poseidon) poseidon = await window.OKCrypto.buildPoseidon();
    if (!vkey) vkey = await (await realFetch('verification_key.json')).json();
  }
  async function computeCommitment(policy) {
    await init();
    const inputs = [policy.limitCents, ...blockedSlots(policy), policy.salt];
    return poseidon.F.toString(poseidon(inputs));
  }
  async function proveDecision(policy, tx, decisionBit) {
    await init();
    const commitment = await computeCommitment(policy);
    const input = {
      limit: policy.limitCents,
      salt: policy.salt,
      blockedCats: blockedSlots(policy),
      amount: tx.amountCents,
      category: CATEGORIES[tx.category],
      decision: decisionBit,
      commitment,
    };
    const { proof, publicSignals } = await window.snarkjs.groth16.fullProve(
      input, 'circuits/oathkeeper.wasm', 'circuits/oathkeeper_final.zkey');
    const verifiedLocally = await window.snarkjs.groth16.verify(vkey, publicSignals, proof);
    return { proof, publicSignals, commitment, verifiedLocally };
  }

  const ready = (async () => {
    state.commitment = await computeCommitment(state.policy);
  })();

  // ------------------------------------------------------------- api
  function publicEntry(e) {
    return {
      id: e.id, ts: e.ts, amountCents: e.amountCents, category: e.category,
      decision: e.decision, rule: e.rule, reason: e.reason,
      commitment: e.commitment, publicSignals: e.publicSignals,
      verifiedLocally: e.verifiedLocally, kurier: e.kurier,
      proofUrl: `/api/proof/${e.id}`,
    };
  }
  function json(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  function randomSalt() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return 1 + (buf[0] % (2 ** 31 - 1));
  }

  const handlers = {
    async state() {
      await ready;
      return json({
        commitment: state.commitment,
        categories: Object.keys(CATEGORIES),
        kurier: { configured: false, apiUrl: 'https://api-testnet.kurier.xyz/api/v1', vkHash: null },
        auditCount: state.audit.length,
        privatePolicyExposed: false,
      });
    },
    async audit() {
      await ready;
      return json({ commitment: state.commitment, entries: state.audit.map(publicEntry) });
    },
    async policy(body) {
      await ready;
      const { limitUsd, blockedCategories } = body || {};
      const limitCents = Math.round(Number(limitUsd) * 100);
      if (!Number.isInteger(limitCents) || limitCents <= 0 || limitCents > 100_000_000) {
        return json({ error: 'limitUsd must be a positive amount up to 1,000,000' }, 400);
      }
      const blocked = Array.isArray(blockedCategories) ? blockedCategories : [];
      for (const c of blocked) {
        if (!(c in CATEGORIES)) return json({ error: `unknown category: ${c}` }, 400);
      }
      state.policy = { limitCents, blockedCategories: [...new Set(blocked)], salt: randomSalt() };
      state.audit = []; // a new oath starts a clean audit log
      state.commitment = await computeCommitment(state.policy);
      save();
      return json({
        ok: true,
        commitment: state.commitment,
        message: 'Policy sealed. Only its commitment is public — the cap and block list stay private.',
      });
    },
    async evaluate(body) {
      await ready;
      const { amountUsd, category } = body || {};
      const amountCents = Math.round(Number(amountUsd) * 100);
      const tx = { amountCents, category };
      const v = evaluate(tx, state.policy);
      const { proof, publicSignals, commitment, verifiedLocally } =
        await proveDecision(state.policy, tx, v.decisionBit);
      const entry = {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        amountCents, category,
        decision: v.decision, rule: v.rule, reason: v.reason,
        commitment, publicSignals, verifiedLocally, proof,
        kurier: { status: 'not_configured' },
      };
      state.audit.unshift(entry);
      state.audit = state.audit.slice(0, 100);
      save();
      return json(publicEntry(entry));
    },
    async reveal() {
      await ready;
      return json({
        limitUsd: state.policy.limitCents / 100,
        blockedCategories: state.policy.blockedCategories,
        commitment: state.commitment,
        note: 'This is the first time these values are shown. Every proof above was generated while they were sealed.',
      });
    },
  };

  window.fetch = function (input, opts) {
    const rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
    let pathname = '';
    try { pathname = new URL(rawUrl, window.location.href).pathname; } catch { /* fall through */ }
    const m = pathname.match(/\/api\/(state|audit|policy|evaluate|reveal)$/);
    if (!m) return realFetch(input, opts);
    const method = ((opts && opts.method) || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
    const name = m[1];
    const route = { GET: { state: 1, audit: 1 }, POST: { policy: 1, evaluate: 1, reveal: 1 } };
    if (!route[method] || !route[method][name]) return realFetch(input, opts);
    let body = null;
    if (opts && typeof opts.body === 'string') {
      try { body = JSON.parse(opts.body); } catch { body = null; }
    }
    return handlers[name](body).catch((err) => json({ error: String((err && err.message) || err) }, 500));
  };

  // ------------------------------------------- proof links (was /api/proof/:id)
  document.addEventListener('click', (ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest('a[data-proof]') : null;
    if (!a) return;
    ev.preventDefault();
    const entry = state.audit.find((e) => e.id === a.getAttribute('data-proof'));
    if (!entry) return;
    const doc = {
      id: entry.id,
      decision: entry.decision,
      publicSignals: entry.publicSignals,
      publicSignalMeaning: ['amount (cents)', 'category (code)', 'decision (1=ALLOW, 0=BLOCK)', 'policy commitment (Poseidon)'],
      proof: entry.proof,
      verifiedLocally: entry.verifiedLocally,
      kurier: entry.kurier,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
})();
