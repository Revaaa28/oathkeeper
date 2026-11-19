'use strict';
/**
 * spike.js — the kill/pivot gate for OATHKEEPER.
 *
 * Proves the riskiest assumption end to end, locally:
 *   1. an honest ALLOW decision produces a valid Groth16 proof
 *   2. an honest BLOCK (over the private cap) produces a valid proof
 *   3. an honest BLOCK (blocked category, under the cap) produces a valid proof
 *   4. a CHEATING decision (over cap, claimed ALLOW) cannot be proven
 *
 * The private policy (limit, blocked list, salt) never appears in the
 * public signals — only its Poseidon commitment does.
 */
const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const { buildPoseidon } = require('circomlibjs');

const BUILD = path.join(__dirname, '..', 'circuits', 'build');
const WASM = path.join(BUILD, 'oathkeeper_js', 'oathkeeper.wasm');
const ZKEY = path.join(BUILD, 'oathkeeper_final.zkey');
const VKEY = JSON.parse(fs.readFileSync(path.join(BUILD, 'verification_key.json'), 'utf8'));

// The owner's private policy — never published, only its commitment is.
const POLICY = {
  limit: 5000, // $50.00 per transaction, in cents
  blockedCats: [3, 4, 0, 0, 0, 0, 0, 0], // 3 = gambling, 4 = subscriptions
  salt: 987654321,
};
// Category codes: 1 = groceries, 2 = games, 3 = gambling, 4 = subscriptions

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const commitment = F.toString(poseidon([POLICY.limit, ...POLICY.blockedCats, POLICY.salt]));
  console.log('policy commitment (public):', commitment);

  const base = {
    limit: POLICY.limit,
    salt: POLICY.salt,
    blockedCats: POLICY.blockedCats,
    commitment,
  };

  const cases = [
    { name: 'honest ALLOW  ($30 groceries, under $50 cap)', input: { ...base, amount: 3000, category: 1, decision: 1 }, shouldProve: true },
    { name: 'honest BLOCK  ($60 groceries, over $50 cap)', input: { ...base, amount: 6000, category: 1, decision: 0 }, shouldProve: true },
    { name: 'honest BLOCK  ($10 gambling, blocked category)', input: { ...base, amount: 1000, category: 3, decision: 0 }, shouldProve: true },
    { name: 'honest ALLOW  ($50 exactly at cap)', input: { ...base, amount: 5000, category: 2, decision: 1 }, shouldProve: true },
    { name: 'CHEAT         ($60 claimed ALLOW, over cap)', input: { ...base, amount: 6000, category: 1, decision: 1 }, shouldProve: false },
    { name: 'CHEAT         ($10 gambling claimed ALLOW)', input: { ...base, amount: 1000, category: 3, decision: 1 }, shouldProve: false },
    { name: 'CHEAT         (wrong limit, commitment mismatch)', input: { ...base, limit: 999999, amount: 6000, category: 1, decision: 1 }, shouldProve: false },
  ];

  let passed = 0;
  for (const c of cases) {
    try {
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(c.input, WASM, ZKEY);
      const ok = await snarkjs.groth16.verify(VKEY, publicSignals, proof);
      // Public signals must expose amount/category/decision/commitment only.
      if (c.shouldProve && ok) {
        console.log(`PASS  ${c.name} — proof valid, public signals: [${publicSignals.join(', ')}]`);
        passed++;
      } else if (c.shouldProve) {
        console.log(`FAIL  ${c.name} — proof generated but verification returned false`);
      } else {
        console.log(`FAIL  ${c.name} — cheating input produced a ${ok ? 'VALID' : 'generated'} proof`);
      }
    } catch (err) {
      if (!c.shouldProve) {
        console.log(`PASS  ${c.name} — proving correctly impossible (${String(err.message || err).split('\n')[0].slice(0, 80)})`);
        passed++;
      } else {
        console.log(`FAIL  ${c.name} — honest input failed to prove: ${err.message || err}`);
      }
    }
  }

  console.log(`\nSPIKE RESULT: ${passed}/${cases.length} cases as expected`);
  process.exit(passed === cases.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
