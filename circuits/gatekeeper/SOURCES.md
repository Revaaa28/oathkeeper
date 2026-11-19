# Gatekeeper circuit artifacts — provenance

Official zkVerify Agent Games "Proof Gatekeeper" circuit artifacts, as
redistributed by a live competitor's public repository (the platform serves
the originals from agentgames.zkverify.io/circuits; the competitor's
CIRCUIT.md records that download, dated 2026-11-15).

Source repository: https://github.com/ridaharsana/agentgames-gatekeeper
(commit dd0592a6e071bf14d1225286eaa47813ab603299, fetched 2026-11-19)

| file | source URL | bytes | sha256 |
|---|---|---|---|
| gatekeeper.wasm | https://raw.githubusercontent.com/ridaharsana/agentgames-gatekeeper/main/circuits/gatekeeper.wasm | 1,755,820 | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| gatekeeper_final.zkey | https://raw.githubusercontent.com/ridaharsana/agentgames-gatekeeper/main/circuits/gatekeeper_final.zkey | 309,750 | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |
| verification_key.json | https://raw.githubusercontent.com/ridaharsana/agentgames-gatekeeper/main/verification_key.json | 5,118 | `62e9c10c24bf5f934a7ec6d10e8833145c1169b593879d4903f74b150b6611ae` |

Cross-checks performed locally (2026-11-19):

- wasm + zkey sizes and sha256 match the values recorded in the source
  repo's CIRCUIT.md, which in turn match values published independently
  by @saifulsidik801 (Medium, 2026-11-15).
- verification_key.json was exported by the source repo from the zkey
  (`snarkjs zkey export verificationkey`): groth16 / bn128, nPublic 13.
  Its sha256 above is computed locally (no upstream hash published).
- End-to-end: proving the repo's test/input_valid.json witness inputs
  (salt 987654321, taskId 24) yields public signal [0] =
  `4538591768452999874275481926009620849813943225939850916630922448132760538048`
  = Poseidon(987654321, 24), exactly the independently published value,
  and the proof verifies against verification_key.json with snarkjs.

## Circuit interface (from the source repo's CIRCUIT.md + lib/proof.js)

13 input signals, all size 1: `taskId`, `minimum`, `publicBalance`,
`expiryBlock`, `currentBlock`, `recipient`, `conditionRecipient`,
`amount`, `maxTransfer`, `registeredVkHash`, `proofVkHash`, `salt`
(private — the only private input), `decision` (1 = approve, 0 = reject).

Public signals order:
`[commitment, registeredVkHash, proofVkHash, minimum, publicBalance,
expiryBlock, currentBlock, recipient, conditionRecipient, amount,
maxTransfer, decision, taskId]`, with `commitment = Poseidon(salt, taskId)`.

The circuit enforces decision == computed verdict (VK equality,
balance >= minimum, recipient match, currentBlock <= expiryBlock,
amount <= maxTransfer): a wrong decision has no witness.

Task-field mapping (lib/proof.js): task input fields map 1:1
(`public_balance` -> `publicBalance`, etc.); hex VK hashes / addresses
are fed as their integer value (BigInt parses `0x…`) and reduced mod the
BN128 field prime inside the witness. `taskId` is derived from the
platform `task_id` by taking its first integer group ("gk_24_9d1" -> 24)
— the platform's exact mapping is unpublished; this heuristic matches
the public worked example in the source repo (lib/decision.js).
