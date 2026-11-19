pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

/**
 * OATHKEEPER circuit — proves an agent's ALLOW/BLOCK decision was forced by
 * the owner's committed private policy, without revealing that policy.
 *
 * Private inputs (known only to the agent / owner):
 *   limit       — per-transaction cap, in integer cents
 *   salt        — random blinding value for the commitment
 *   blockedCats — exactly 8 blocked category codes, zero-padded
 *                 (real category codes start at 1, so 0 never matches)
 *
 * Public inputs (anyone can see and check):
 *   amount      — proposed transaction amount, in integer cents
 *   category    — proposed transaction category code
 *   decision    — 1 = ALLOW, 0 = BLOCK
 *   commitment  — Poseidon(limit, blockedCats[0..7], salt), published by the
 *                 owner when the policy is set; changing any rule changes it
 *
 * Constraints force:
 *   decision == 1  iff  amount <= limit AND category not in blockedCats
 * A prover cannot produce a valid proof for a decision the committed
 * policy does not dictate.
 */
template Oathkeeper() {
    signal input limit;
    signal input salt;
    signal input blockedCats[8];

    signal input amount;
    signal input category;
    signal input decision;
    signal input commitment;

    // 1. The private policy must hash to the published commitment.
    component hasher = Poseidon(10);
    hasher.inputs[0] <== limit;
    for (var i = 0; i < 8; i++) {
        hasher.inputs[1 + i] <== blockedCats[i];
    }
    hasher.inputs[9] <== salt;
    commitment === hasher.out;

    // 2. Is the category blocked? (OR over the 8 slots)
    component eq[8];
    signal blockedAcc[9];
    blockedAcc[0] <== 0;
    for (var i = 0; i < 8; i++) {
        eq[i] = IsEqual();
        eq[i].in[0] <== category;
        eq[i].in[1] <== blockedCats[i];
        blockedAcc[i + 1] <== blockedAcc[i] + eq[i].out * (1 - blockedAcc[i]);
    }
    signal blocked <== blockedAcc[8];

    // 3. Is the amount within the private cap?
    component leq = LessEqThan(32);
    leq.in[0] <== amount;
    leq.in[1] <== limit;

    // 4. ALLOW exactly when within cap and not blocked; decision must match.
    signal allow <== leq.out * (1 - blocked);
    decision === allow;
}

component main {public [amount, category, decision, commitment]} = Oathkeeper();
