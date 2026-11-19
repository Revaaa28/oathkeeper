'use strict';

/**
 * agentgames.js — zkVerify Agent Games platform protocol for OATHKEEPER.
 *
 * The platform delivers signed tasks to the registered agent endpoint:
 *
 *   GET  /health  -> exactly { ok: true, protocolVersion: "v1" }
 *   POST /agent   -> every platform message (also POST / — the agent is
 *                    registered with the bare domain)
 *
 * Every request carries `x-agent-games-signature` =
 * HMAC-SHA256(secret, raw body); the secret is the agent's HMAC secret
 * from env AGENT_GAMES_HMAC_SECRET (raw utf8 string). Signatures are
 * verified over the RAW body BEFORE JSON parsing, timing-safe; a
 * missing/invalid signature (or no secret configured) -> HTTP 401.
 * Every response is signed the same way over its raw body.
 *
 * Message types:
 *   agent-games.preflight.v1        -> { ok: true, protocolVersion: "v1" }
 *   agent-games.proof-gatekeeper.v1 -> deterministic ALLOW/BLOCK-style
 *     verdict (APPROVE/REJECT + reason_code) over the task's verification
 *     condition, plus a Groth16 decision proof from the OFFICIAL
 *     Gatekeeper circuit (circuits/gatekeeper/, see SOURCES.md there),
 *     submitted to zkVerify through Kurier with the fixed, already
 *     registered Gatekeeper vk (vkRegistered: true — no register call).
 *
 * Decision check order (deterministic; mirrors the circuit's verdict so
 * a proof always exists for the decision we return):
 *   MISSING_VERIFICATION -> VK_SUBSTITUTION -> THRESHOLD_MISMATCH ->
 *   RECIPIENT_MISMATCH -> PROOF_REPLAY -> EXPIRED_CONDITION ->
 *   AMOUNT_OVERFLOW -> APPROVE / VALID_PROOF.
 * PROOF_REPLAY and MISSING_VERIFICATION responses carry no proof.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');

const kurier = require('./kurier');

const SIG_HEADER = 'x-agent-games-signature';
const PROTOCOL_VERSION = 'v1';

// The official Gatekeeper verification key, already registered on
// zkVerify — submissions reference it by hash with vkRegistered: true.
const GATEKEEPER_VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

const WASM = path.join(__dirname, '..', 'circuits', 'gatekeeper', 'gatekeeper.wasm');
const ZKEY = path.join(__dirname, '..', 'circuits', 'gatekeeper', 'gatekeeper_final.zkey');
const SEEN_FILE = process.env.AGENT_GAMES_SEEN_FILE ||
  path.join(__dirname, '..', 'data', 'seen_gatekeeper.json');

const PROOF_TIMEOUT_MS = parseInt(process.env.AGENT_GAMES_PROOF_TIMEOUT_MS || '20000', 10);
const PROOF_POLL_MS = parseInt(process.env.AGENT_GAMES_PROOF_POLL_MS || '1000', 10);

// ------------------------------------------------------------------ HMAC
function getSecret() {
  const s = process.env.AGENT_GAMES_HMAC_SECRET;
  return s ? Buffer.from(s, 'utf8') : null;
}

function sign(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifySignature(secret, rawBody, headerValue) {
  const got = (headerValue || '').toString().replace(/^sha256=/, '').trim().toLowerCase();
  if (!got) return false;
  const want = sign(secret, rawBody);
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(want, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Send a JSON response, signed over its raw body when a secret exists. */
function sendSigned(res, secret, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.status(status);
  res.set('Content-Type', 'application/json');
  if (secret) res.set(SIG_HEADER, sign(secret, body));
  return res.send(body);
}

// ------------------------------------------------------------- seen-set
// proof_tx values already presented, for replay detection. Persisted so
// a restart cannot reopen the replay window.
const seen = new Set();
try {
  const parsed = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  if (Array.isArray(parsed)) for (const tx of parsed) seen.add(tx);
} catch { /* first boot: no file yet */ }

function markSeen(tx) {
  if (!tx || seen.has(tx)) return;
  seen.add(tx);
  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    const tmp = `${SEEN_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...seen], null, 2));
    fs.renameSync(tmp, SEEN_FILE);
  } catch (err) {
    console.error('[agentgames] seen persist failed:', err.message);
  }
}

// -------------------------------------------------------------- decision
function toBig(x) {
  if (x === undefined || x === null || x === '') return null;
  try { return BigInt(x); } catch { return null; }
}

/** Equality for VK hashes / addresses: numeric when both parse (hex or
 *  decimal — the same value may arrive in either form), else
 *  case-insensitive string equality. */
function fieldEq(a, b) {
  const ba = toBig(a);
  const bb = toBig(b);
  if (ba !== null && bb !== null) return ba === bb;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function decide(input, seenSet) {
  if (!input || typeof input !== 'object' ||
      !input.registered_vk || !input.proof_vk || !input.proof_tx) {
    return { decision: 'REJECT', reason_code: 'MISSING_VERIFICATION' };
  }
  if (!fieldEq(input.proof_vk, input.registered_vk)) {
    return { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' };
  }
  const bal = toBig(input.public_balance);
  const min = toBig(input.minimum);
  if (bal === null || min === null || bal < min) {
    return { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' };
  }
  if (!fieldEq(input.recipient, input.condition_recipient)) {
    return { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' };
  }
  if (seenSet.has(input.proof_tx)) {
    return { decision: 'REJECT', reason_code: 'PROOF_REPLAY' };
  }
  const cur = toBig(input.current_block);
  const exp = toBig(input.expiry_block);
  if (cur === null || exp === null || cur > exp) {
    return { decision: 'REJECT', reason_code: 'EXPIRED_CONDITION' };
  }
  const amt = toBig(input.amount);
  const cap = toBig(input.max_transfer);
  if (amt === null || cap === null || amt > cap) {
    return { decision: 'REJECT', reason_code: 'AMOUNT_OVERFLOW' };
  }
  return { decision: 'APPROVE', reason_code: 'VALID_PROOF' };
}

// ----------------------------------------------------------------- proof
// task_id -> circuit taskId: first integer group of the id
// ("gk_24_9d1" -> 24). The platform's exact mapping is unpublished;
// this matches the public worked example (see circuits/gatekeeper/
// SOURCES.md).
function taskIdOf(taskId) {
  const m = String(taskId || '').match(/\d+/);
  return m ? m[0] : '0';
}

function circuitField(x) {
  const b = toBig(x);
  if (b === null) throw new Error('unprovable: non-numeric circuit field');
  return b.toString();
}

function buildCircuitInput(task, input, verdict) {
  return {
    taskId: taskIdOf(task.task_id),
    minimum: circuitField(input.minimum),
    publicBalance: circuitField(input.public_balance),
    expiryBlock: circuitField(input.expiry_block),
    currentBlock: circuitField(input.current_block),
    recipient: circuitField(input.recipient),
    conditionRecipient: circuitField(input.condition_recipient),
    amount: circuitField(input.amount),
    maxTransfer: circuitField(input.max_transfer),
    registeredVkHash: circuitField(input.registered_vk),
    proofVkHash: circuitField(input.proof_vk),
    salt: BigInt('0x' + crypto.randomBytes(16).toString('hex')).toString(), // private, fresh per task
    decision: verdict.decision === 'APPROVE' ? '1' : '0',
  };
}

/** Poll a Kurier job until it carries a tx hash at IncludedInBlock /
 *  Finalized. Returns as soon as a tx hash exists — the platform's
 *  delivery window does not leave time to wait for Finalized. */
async function waitForTxHash(jobId, { timeoutMs = PROOF_TIMEOUT_MS, intervalMs = PROOF_POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let seenTx = null;
  for (;;) {
    last = await kurier.jobStatus(jobId);
    const status = String(last.status || last.state || '');
    const tx = last.txHash || last.transactionHash || last.proofTx || null;
    if (tx) seenTx = tx;
    if ((/includedinblock/i.test(status) || /finalized/i.test(status)) && seenTx) {
      return { status, txHash: seenTx };
    }
    if (/fail|invalid|error/i.test(status)) return { status, txHash: null };
    if (Date.now() >= deadline) return { status: status || 'Timeout', txHash: seenTx };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Generate the decision proof with the official Gatekeeper circuit and,
 * when Kurier is configured, submit it (vkRegistered: true, fixed
 * Gatekeeper vk) and poll for the zkVerify tx hash.
 * Throws only when the proof itself cannot be generated.
 */
async function proveDecision(task, input, verdict) {
  const circuitInput = buildCircuitInput(task, input, verdict);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput, WASM, ZKEY);
  if (!kurier.configured()) {
    return { proof, publicSignals, proofTx: null, submissionStatus: 'not_configured' };
  }
  let jobId;
  try {
    const submitted = await kurier.submitProof(proof, publicSignals, GATEKEEPER_VK);
    jobId = submitted.jobId;
  } catch (err) {
    // Submission failed but the proof itself is valid — keep it in the
    // response (the platform can verify it directly); only proof_tx is
    // lost. Mirrors the proven competitor behaviour.
    console.error('[agentgames] kurier submit failed:', String(err.message || err).slice(0, 200));
    return { proof, publicSignals, proofTx: null, submissionStatus: 'submit_failed' };
  }
  const polled = await waitForTxHash(jobId);
  if (!polled.txHash) {
    console.error(`[agentgames] kurier job ${jobId} ended ${polled.status} without a tx hash`);
  }
  return { proof, publicSignals, proofTx: polled.txHash, submissionStatus: polled.status };
}

// --------------------------------------------------------------- handler
/**
 * Express handler for POST /agent and POST /. Expects req.body to be the
 * RAW request body Buffer (mount with express.raw() before any JSON
 * parser). Fails closed: no secret configured -> 401 for everything.
 */
async function handleAgentPost(req, res) {
  const secret = getSecret();
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!secret || !verifySignature(secret, raw, req.headers[SIG_HEADER])) {
    return sendSigned(res, secret, 401, { error: 'bad signature' });
  }

  let msg;
  try {
    msg = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendSigned(res, secret, 400, { error: 'invalid json' });
  }

  if (msg && msg.type === 'agent-games.preflight.v1') {
    return sendSigned(res, secret, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
  }
  if (!msg || msg.type !== 'agent-games.proof-gatekeeper.v1' || !msg.input) {
    return sendSigned(res, secret, 400, { error: 'unsupported type' });
  }

  const input = msg.input;
  const verdict = decide(input, seen);
  const replay = verdict.reason_code === 'PROOF_REPLAY';
  const missing = verdict.reason_code === 'MISSING_VERIFICATION';

  // Decision proof: every decision except PROOF_REPLAY (excluded by the
  // scoring rules) and MISSING_VERIFICATION (no complete statement to
  // prove). A proof/submission failure never swallows the decision.
  let proof = null;
  let publicSignals = null;
  let proofTx = null;
  let proofError = null;
  let submissionStatus = null;
  if (!replay && !missing) {
    try {
      const r = await proveDecision(msg, input, verdict);
      proof = r.proof;
      publicSignals = r.publicSignals;
      proofTx = r.proofTx;
      submissionStatus = r.submissionStatus;
    } catch (err) {
      proofError = String(err.message || err).slice(0, 200);
      console.error('[agentgames] proof generation failed:', proofError);
    }
  }

  // Record every presented proof_tx after the replay check, so any
  // later task reusing it is caught as PROOF_REPLAY.
  if (input.proof_tx && !replay) markSeen(input.proof_tx);

  const out = {
    decision: verdict.decision,
    reason_code: verdict.reason_code,
    proof_tx: proofTx,
    proof,
    public_signals: publicSignals,
  };
  if (proofError) out.proof_error = proofError;
  else if (missing) out.proof_error = 'missing_verification';
  if (submissionStatus) out.submission_status = submissionStatus;
  return sendSigned(res, secret, 200, out);
}

module.exports = {
  SIG_HEADER,
  PROTOCOL_VERSION,
  GATEKEEPER_VK,
  getSecret,
  sign,
  verifySignature,
  sendSigned,
  decide,
  taskIdOf,
  buildCircuitInput,
  proveDecision,
  waitForTxHash,
  handleAgentPost,
  _seen: seen,
};
