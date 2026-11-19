'use strict';

/**
 * kurier.js — submit OATHKEEPER proofs to zkVerify via Kurier (REST).
 *
 * Implements the official flow from docs.zkverify.io:
 *   1. POST {API_URL}/register-vk/{API_KEY}   — once per verification key
 *   2. POST {API_URL}/submit-proof/{API_KEY}  — per proof, vkRegistered:true
 *   3. GET  {API_URL}/job-status/{API_KEY}/{jobId} — poll until Finalized
 *
 * API_URL defaults to testnet (https://api-testnet.kurier.xyz/api/v1);
 * set KURIER_API_URL=https://api.kurier.xyz/api/v1 for mainnet.
 * Without KURIER_API_KEY this module reports "not_configured" and the
 * server falls back to local snarkjs verification as the evidence.
 */

const API_URL = process.env.KURIER_API_URL || 'https://api-testnet.kurier.xyz/api/v1';
const API_KEY = process.env.KURIER_API_KEY || '';

function configured() {
  return Boolean(API_KEY);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Kurier ${url.split('/').slice(-2, -1)[0]} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return data;
}

async function registerVk(vkey) {
  const data = await postJson(`${API_URL}/register-vk/${API_KEY}`, {
    proofType: 'groth16',
    vk: vkey,
    proofOptions: { library: 'snarkjs', curve: 'bn128' },
  });
  const vkHash = data.vkHash || data.meta?.vkHash || data.hash || data.uniq_vk_hash;
  if (!vkHash) throw new Error(`register-vk returned no vk hash: ${JSON.stringify(data).slice(0, 200)}`);
  return vkHash;
}

async function submitProof(proof, publicSignals, vkHash) {
  const data = await postJson(`${API_URL}/submit-proof/${API_KEY}`, {
    proofType: 'groth16',
    vkRegistered: true,
    proofOptions: { library: 'snarkjs', curve: 'bn128' },
    proofData: { proof, publicSignals, vk: vkHash },
  });
  if (!data.jobId) throw new Error(`submit-proof returned no jobId: ${JSON.stringify(data).slice(0, 200)}`);
  return data; // { jobId, optimisticVerify, ... }
}

async function jobStatus(jobId) {
  const res = await fetch(`${API_URL}/job-status/${API_KEY}/${jobId}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: 'Unknown', raw: text }; }
}

/** Poll until Finalized / IncludedInBlock / Failed or timeout. */
async function waitForFinalized(jobId, { timeoutMs = 120000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await jobStatus(jobId);
    const status = String(last.status || '');
    if (/finalized/i.test(status)) return { status: 'Finalized', detail: last };
    if (/includedinblock/i.test(status)) {
      // Included is strong, but keep polling briefly for Finalized.
      if (Date.now() + intervalMs >= deadline) return { status: 'IncludedInBlock', detail: last };
    }
    if (/fail|invalid|error/i.test(status)) return { status: 'Failed', detail: last };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: last?.status || 'Timeout', detail: last };
}

module.exports = { configured, registerVk, submitProof, jobStatus, waitForFinalized, API_URL };
