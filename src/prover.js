'use strict';

/**
 * prover.js — Groth16 proving for OATHKEEPER decisions.
 *
 * Wraps snarkjs + circomlibjs Poseidon. The commitment computed here with
 * circomlibjs is the same Poseidon the Circom circuit enforces in-circuit
 * (verified by scripts/spike.js: honest decisions prove, cheats cannot).
 */

const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const { buildPoseidon } = require('circomlibjs');
const { blockedSlots, CATEGORIES } = require('./policy');

const BUILD = path.join(__dirname, '..', 'circuits', 'build');
const WASM = path.join(BUILD, 'oathkeeper_js', 'oathkeeper.wasm');
const ZKEY = path.join(BUILD, 'oathkeeper_final.zkey');
const VKEY_PATH = path.join(BUILD, 'verification_key.json');

let poseidon = null;
let vkey = null;

async function init() {
  if (!poseidon) poseidon = await buildPoseidon();
  if (!vkey) vkey = JSON.parse(fs.readFileSync(VKEY_PATH, 'utf8'));
}

/** Poseidon(limit, blockedCats[0..7], salt) — the public commitment. */
async function computeCommitment(policy) {
  await init();
  const inputs = [policy.limitCents, ...blockedSlots(policy), policy.salt];
  return poseidon.F.toString(poseidon(inputs));
}

/**
 * Generate (and locally verify) a proof that `decisionBit` is the decision
 * the committed private policy dictates for (amountCents, category).
 * Throws if the decision does not match the policy — by construction the
 * engine only ever asks for proofs of its own decisions.
 */
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
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const verifiedLocally = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  return { proof, publicSignals, commitment, verifiedLocally };
}

function getVkey() {
  if (!vkey) vkey = JSON.parse(fs.readFileSync(VKEY_PATH, 'utf8'));
  return vkey;
}

module.exports = { computeCommitment, proveDecision, getVkey };
