<p align="center"><img src="assets/logo/oathkeeper-lockup-1800.png" width="620" alt="OATHKEEPER — proof of obedience"></p>

# OATHKEEPER

**The agent that can prove it obeyed you — without revealing your rules.**

**Live demo: [oathkeeper-production.up.railway.app](https://oathkeeper-production.up.railway.app)** — seal a policy, try to break it, watch the proof. This is the full server demo, redeployed on Railway after the original Render host was suspended mid-judging (its free-tier hours ran out; it revives Dec 1). A static mirror of the same demo — identical policy engine and circuit, running entirely in your browser — is on [GitHub Pages](https://revaaa28.github.io/oathkeeper/).

Built for the [zkVerify Agent Games](https://agentgames.zkverify.io/) — Wildcard track.

## The problem

AI agents are getting wallets. An owner who gives an agent money must give it
rules: a per-transaction cap, a list of forbidden categories. Those rules are
a dilemma:

- **Publish the rules** and every attacker (and every prompt-injection) knows
  exactly how far it can push — spend one cent under the cap, route around
  the published block list.
- **Hide the rules** and nobody — not users, not counterparties, not auditors —
  can verify the agent actually obeyed them. "Trust me" is not a control.

## The solution

OATHKEEPER seals the owner's policy into a **Poseidon commitment** and proves
every autonomous decision against it with a **Groth16 zero-knowledge proof**:

1. **Seal** — the owner sets a private policy (per-transaction cap + blocked
   categories, up to 8). The server stores it privately and publishes only
   `commitment = Poseidon(limit, blockedCats, salt)`.
2. **Decide** — a deterministic policy engine (plain code, not the LLM)
   answers `ALLOW` or `BLOCK` for each proposed transaction, citing the rule
   that fired. The engine's logic is exactly the statement the circuit proves.
3. **Prove** — every decision is generated with a Groth16 proof (Circom 2 +
   snarkjs) and verified — locally with snarkjs, and on **zkVerify via
   Kurier** — that the decision is the one the committed policy dictates.

The public learns exactly four signals per decision: the amount, the category,
the decision, and the commitment. The cap, the block list and the salt never
appear — yet a proof that violates them **cannot be produced**: the spike
suite (`npm run spike`) shows honest ALLOW/BLOCK decisions proving cleanly
while three cheating decisions (over-cap claimed as ALLOW, blocked category
claimed as ALLOW, secretly swapped limit) are mathematically unprovable.

## The checkable claim

> *This decision was forced by the policy committed in `commitment` — not by
> the model's mood, not by a prompt injection, not by the server operator.*

Anyone can check it without trusting this server: fetch a proof from
`/api/proof/:id`, the verification key from `/api/vkey`, and verify with
plain snarkjs — or look up the Kurier job that carried the same proof to
zkVerify finalization.

## Run it

```bash
npm install
npm start            # http://localhost:10000
npm test             # policy + live-server + privacy-invariant tests
npm run spike        # circuit kill-gate: 4 honest proofs, 3 impossible cheats
```

To rebuild the circuit from source (needs the `circom` 2.1.9 binary):

```bash
bash scripts/build-circuit.sh
```

To verify proofs on zkVerify, set a free Kurier API key
([testnet](https://testnet.kurier.xyz) or [mainnet](https://kurier.xyz)):

```bash
KURIER_API_KEY=... KURIER_API_URL=https://api-testnet.kurier.xyz/api/v1 npm start
```

The server then registers the verification key once and submits every
decision's proof, polling each job to `Finalized` and recording the result
in the audit log.

## API

| Endpoint | What it does |
|---|---|
| `GET /api/state` | Public state: commitment, categories, Kurier status. Never the policy. |
| `POST /api/policy` | Owner seals a new policy `{limitUsd, blockedCategories[]}`. Returns only the new commitment. |
| `POST /api/evaluate` | Propose `{amountUsd, category}` → decision + proof + public signals. |
| `GET /api/audit` | Every decision with its proof link and zkVerify status. |
| `GET /api/proof/:id` | Full proof + public signals for independent verification. |
| `GET /api/vkey` | The Groth16 verification key. |
| `POST /api/reveal` | **Deliberate owner reveal (demo):** discloses the sealed policy so judges can audit that it was real all along. |

Categories: `groceries, games, gambling, subscriptions, software, transfers,
dining, other`. Amounts are handled in integer cents end to end.

## Honest disclosures

- **Trusted setup:** the Groth16 keys come from a *local development
  ceremony* (the public powers-of-tau bucket used by the tutorials no longer
  serves files, so `scripts/build-circuit.sh` generates a pot-12 ceremony
  locally — the same local-dev flow the official zkVerify tutorials
  document). A production deployment must use a real multi-party ceremony.
  The circuit constraints — the part that makes cheating unprovable — are
  unaffected by who ran the ceremony, but key-generation trust is a real
  caveat and we state it rather than hide it.
- **Scope of the proof:** proofs cover the agent's *autonomous* decisions
  (cap + block list). Decisions escalated to a human owner need no proof —
  the human is the check.
- **Policy privacy:** the policy lives server-side. The commitment scheme
  means the *operator* knows the rules; what OATHKEEPER removes is the need
  for everyone else to trust that the operator's agent followed them.

## Layout

```
circuits/oathkeeper.circom   the ZK circuit (516 constraints)
src/policy.js                 deterministic policy engine (mirrors the circuit)
src/prover.js                 Poseidon commitment + Groth16 proving/verify
src/kurier.js                 zkVerify verification via the Kurier REST API
server.js                     agent API + audit log
public/index.html             the demo: seal → attack → prove → reveal
scripts/spike.js              the kill-gate test suite for the circuit
test/oathkeeper.test.js       engine, server, and privacy-invariant tests
```
