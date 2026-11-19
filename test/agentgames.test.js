'use strict';

/**
 * Agent Games protocol tests — HMAC envelope, preflight, the
 * deterministic Gatekeeper decision ladder, replay protection, and
 * real decision proofs from the official Gatekeeper circuit.
 *
 * The server is spawned with a test HMAC secret and NO Kurier API key,
 * so proofs are generated locally but never submitted (no network).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const snarkjs = require('snarkjs');

const { decide, taskIdOf } = require('../src/agentgames');

const PORT = 10098;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-secret-agentgames';
const SEEN_FILE = path.join(os.tmpdir(), `seen_gatekeeper_test_${process.pid}.json`);
const RUN = crypto.randomBytes(4).toString('hex');

const VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const RECIP = '0x1234567890AbcdEF1234567890aBcdef12345678';
const BASE_INPUT = {
  registered_vk: VK,
  proof_vk: VK,
  minimum: '1000',
  public_balance: '1460',
  expiry_block: 8430000,
  current_block: 8420000,
  recipient: RECIP,
  condition_recipient: RECIP,
  amount: '500',
  max_transfer: '1000',
};

let serverProc = null;
let n = 0;

function task(overrides = {}) {
  n += 1;
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: `gk_${100 + n}_t${n}`,
    mode: 'practice',
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 30000).toISOString(),
    input: { ...BASE_INPUT, proof_tx: `0xtestproof_${RUN}_${n}`, ...overrides },
  };
}

function sign(raw) {
  return crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(raw).digest('hex');
}

async function post(pathname, bodyObj, { signed = true, badSig = false, secret = SECRET } = {}) {
  const raw = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const headers = { 'Content-Type': 'application/json' };
  if (signed) {
    const s = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'));
    headers['x-agent-games-signature'] = badSig ? s.update(Buffer.from('tampered')).digest('hex') : s.update(raw).digest('hex');
  }
  const r = await fetch(`${BASE}${pathname}`, { method: 'POST', headers, body: raw });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, rawText: text, respSig: r.headers.get('x-agent-games-signature') };
}

function assertResponseSig(r) {
  assert.ok(r.respSig, 'response must carry x-agent-games-signature');
  assert.equal(r.respSig, sign(Buffer.from(r.rawText, 'utf8')), 'response signature must verify over the raw body');
}

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
  try { fs.unlinkSync(SEEN_FILE); } catch { /* fresh */ }
  serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENT_GAMES_HMAC_SECRET: SECRET,
      AGENT_GAMES_SEEN_FILE: SEEN_FILE,
      KURIER_API_KEY: '', // disabled: no network in tests
    },
    stdio: 'pipe',
  });
  await waitForHealth();
});

after(() => {
  if (serverProc) serverProc.kill('SIGTERM');
  try { fs.unlinkSync(SEEN_FILE); } catch { /* gone */ }
});

// ------------------------------------------------------------ unit: decide
test('decide: check order and reason codes', () => {
  const seen = new Set();
  const ok = { ...BASE_INPUT, proof_tx: '0xunit1' };
  assert.deepEqual(decide(ok, seen), { decision: 'APPROVE', reason_code: 'VALID_PROOF' });

  // Missing data beats every other trap.
  assert.equal(decide({ ...ok, proof_tx: undefined }, seen).reason_code, 'MISSING_VERIFICATION');
  assert.equal(decide({ ...ok, proof_vk: '' }, seen).reason_code, 'MISSING_VERIFICATION');
  assert.equal(decide(null, seen).reason_code, 'MISSING_VERIFICATION');

  // VK substitution beats threshold.
  assert.equal(decide({ ...ok, proof_vk: '0x' + 'aa'.repeat(32), public_balance: '1' }, seen).reason_code, 'VK_SUBSTITUTION');
  // Same VK in decimal form is the same key, not a substitution.
  assert.equal(decide({ ...ok, proof_vk: BigInt(VK).toString() }, seen).reason_code, 'VALID_PROOF');

  assert.equal(decide({ ...ok, public_balance: '999' }, seen).reason_code, 'THRESHOLD_MISMATCH');
  assert.equal(decide({ ...ok, public_balance: '1000' }, seen).reason_code, 'VALID_PROOF'); // boundary: >= minimum

  assert.equal(
    decide({ ...ok, condition_recipient: '0x000000000000000000000000000000000000dEaD' }, seen).reason_code,
    'RECIPIENT_MISMATCH');

  // Replay beats expiry.
  const seen2 = new Set(['0xunit1']);
  assert.equal(decide({ ...ok, current_block: 99999999 }, seen2).reason_code, 'PROOF_REPLAY');

  assert.equal(decide({ ...ok, current_block: 8430001 }, seen).reason_code, 'EXPIRED_CONDITION');
  assert.equal(decide({ ...ok, current_block: 8430000 }, seen).reason_code, 'VALID_PROOF'); // boundary: not yet expired

  assert.equal(decide({ ...ok, amount: '1001' }, seen).reason_code, 'AMOUNT_OVERFLOW');
  assert.equal(decide({ ...ok, amount: '1000' }, seen).reason_code, 'VALID_PROOF'); // boundary: at cap

  // Hex case differences in addresses are not a mismatch.
  assert.equal(decide({ ...ok, recipient: RECIP.toUpperCase().replace('0X', '0x') }, seen).reason_code, 'VALID_PROOF');
});

test('taskIdOf: first integer group of the task id', () => {
  assert.equal(taskIdOf('gk_24_9d1'), '24');
  assert.equal(taskIdOf('gk_101_t3'), '101');
  assert.equal(taskIdOf('no-digits'), '0');
  assert.equal(taskIdOf(undefined), '0');
});

// ------------------------------------------------------------------- HTTP
test('health: exact protocol shape', async () => {
  const r = await fetch(`${BASE}/health`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(j, { ok: true, protocolVersion: 'v1' });
});

test('agent: unsigned and wrongly-signed posts are 401', async () => {
  const unsigned = await post('/agent', task(), { signed: false });
  assert.equal(unsigned.status, 401);

  const badSig = await post('/agent', task(), { badSig: true });
  assert.equal(badSig.status, 401);

  const wrongSecret = await post('/agent', task(), { secret: 'not-the-secret' });
  assert.equal(wrongSecret.status, 401);
});

test('agent: signed preflight answers and is itself signed (both paths)', async () => {
  const pf = { type: 'agent-games.preflight.v1', agent_id: 'test-agent', issued_at: new Date().toISOString(), nonce: 'nonce-1' };
  for (const pathname of ['/agent', '/']) {
    const r = await post(pathname, pf);
    assert.equal(r.status, 200, `${pathname} preflight status`);
    assert.deepEqual(r.json, { ok: true, protocolVersion: 'v1' });
    assertResponseSig(r);
  }
});

test('agent: valid task -> APPROVE/VALID_PROOF with a real, verifiable proof', async () => {
  const r = await post('/agent', task());
  assert.equal(r.status, 200);
  assertResponseSig(r);
  assert.equal(r.json.decision, 'APPROVE');
  assert.equal(r.json.reason_code, 'VALID_PROOF');
  assert.equal(r.json.proof_tx, null, 'Kurier disabled in tests -> no tx hash');
  assert.equal(r.json.submission_status, 'not_configured');
  assert.ok(r.json.proof, 'proof must be present');
  assert.equal(r.json.public_signals.length, 13);
  assert.equal(r.json.public_signals[11], '1', 'decision public signal must be APPROVE=1');

  const vkey = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'circuits', 'gatekeeper', 'verification_key.json'), 'utf8'));
  const ok = await snarkjs.groth16.verify(vkey, r.json.public_signals, r.json.proof);
  assert.equal(ok, true, 'decision proof must verify against the official vkey');
});

const TRAPS = [
  ['VK_SUBSTITUTION', { proof_vk: '0x' + 'aa'.repeat(32) }],
  ['THRESHOLD_MISMATCH', { public_balance: '900' }],
  ['RECIPIENT_MISMATCH', { condition_recipient: '0x000000000000000000000000000000000000dEaD' }],
  ['EXPIRED_CONDITION', { current_block: 8430001 }],
  ['AMOUNT_OVERFLOW', { amount: '1500' }],
];
for (const [code, overrides] of TRAPS) {
  test(`agent: trap ${code} -> REJECT with a proof of the rejection`, async () => {
    const r = await post('/agent', task(overrides));
    assert.equal(r.status, 200);
    assert.equal(r.json.decision, 'REJECT');
    assert.equal(r.json.reason_code, code);
    assert.ok(r.json.proof, `${code} decision must carry a proof`);
    assert.equal(r.json.public_signals[11], '0', 'decision public signal must be REJECT=0');
  });
}

test('agent: missing proof_tx -> MISSING_VERIFICATION, no proof, proof_error set', async () => {
  const t = task();
  delete t.input.proof_tx;
  const r = await post('/agent', t);
  assert.equal(r.status, 200);
  assert.equal(r.json.decision, 'REJECT');
  assert.equal(r.json.reason_code, 'MISSING_VERIFICATION');
  assert.equal(r.json.proof, null);
  assert.equal(r.json.proof_tx, null);
  assert.ok(r.json.proof_error, 'missing-verification must carry proof_error');
});

test('agent: replayed proof_tx -> PROOF_REPLAY with no proof and no proof_error', async () => {
  const t = task();
  const first = await post('/agent', t);
  assert.equal(first.json.decision, 'APPROVE');

  const second = await post('/agent', t);
  assert.equal(second.status, 200);
  assert.equal(second.json.decision, 'REJECT');
  assert.equal(second.json.reason_code, 'PROOF_REPLAY');
  assert.equal(second.json.proof, null);
  assert.equal(second.json.proof_tx, null);
  assert.ok(!('proof_error' in second.json), 'replay must not carry proof_error');

  // The seen-set is persisted to disk.
  const persisted = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  assert.ok(persisted.includes(t.input.proof_tx), 'proof_tx must be persisted in the seen file');
});
