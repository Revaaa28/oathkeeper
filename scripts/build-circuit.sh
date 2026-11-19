#!/usr/bin/env bash
# Build the OATHKEEPER circuit: install deps, fetch powers-of-tau,
# compile, Groth16 setup (local ceremony, dev only), export vkey.
set -euo pipefail
cd "$(dirname "$0")/.."
CIRCOM=~/workspace/tools/bin/circom

echo "== npm install =="
npm install --no-audit --no-fund 2>&1 | tail -2

echo "== powers of tau (local ceremony, pot12 — circuit is only 516 constraints) =="
# The public hermez S3 bucket now returns AccessDenied (verified 2026-11-19),
# so generate the ceremony locally — the same local-dev flow the official
# zkVerify tutorials document. NOT a production trusted setup.
if [ ! -f circuits/build/pot12_final.ptau ]; then
  npx snarkjs powersoftau new bn128 12 circuits/build/pot12_0000.ptau -v 2>&1 | tail -1
  npx snarkjs powersoftau contribute circuits/build/pot12_0000.ptau circuits/build/pot12_0001.ptau --name="oathkeeper dev" -e="oathkeeper pot entropy 2026-11-19" -v 2>&1 | tail -1
  npx snarkjs powersoftau prepare phase2 circuits/build/pot12_0001.ptau circuits/build/pot12_final.ptau -v 2>&1 | tail -1
fi
ls -la circuits/build/pot12_final.ptau

echo "== compile =="
$CIRCOM circuits/oathkeeper.circom --r1cs --wasm --sym -o circuits/build -l node_modules
snarkjs_info=$(npx snarkjs r1cs info circuits/build/oathkeeper.r1cs | grep -E "Constraints|Wire" || true)
echo "$snarkjs_info"

echo "== groth16 setup =="
npx snarkjs groth16 setup circuits/build/oathkeeper.r1cs circuits/build/pot12_final.ptau circuits/build/oathkeeper_0000.zkey
npx snarkjs zkey contribute circuits/build/oathkeeper_0000.zkey circuits/build/oathkeeper_final.zkey --name="oathkeeper dev ceremony" -e="oathkeeper spike entropy 2026-11-19" -v 2>&1 | tail -2
npx snarkjs zkey export verificationkey circuits/build/oathkeeper_final.zkey circuits/build/verification_key.json
echo "== circuit build done =="
ls -la circuits/build/
