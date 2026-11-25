#!/usr/bin/env bash
# Deploy the v1.4 OpenModelSettlement contract to Filecoin mainnet.
#
#   ./scripts/deploy-mainnet.sh
#
# Asks for the owner's private key (input hidden, never written to disk or the
# shell history), then: installs dependencies if needed, compiles, runs the test
# suite, deploys, configures (earnings freeze, USDFC, operator), checks the
# contract's on-chain state, writes deployments/mainnet-v14.json and verifies the
# source on Blockscout. Re-running is safe: give the address it printed in
# SETTLEMENT_ADDRESS to resume on the same contract instead of deploying another.
#
# Optional overrides (environment): MAINNET_RPC_URL, EXPECTED_OWNER,
# EXPECTED_OPERATOR, USDFC, EARNINGS_FREEZE_SEC, SETTLEMENT_ADDRESS.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "node is required (v18 or later)"; exit 1; }
[ -d node_modules ] || npm ci --no-audit --no-fund
npx hardhat compile --quiet
echo "Running the contract test suite ..."
npx hardhat test >/tmp/openmodel-contract-tests.log 2>&1 || {
  tail -30 /tmp/openmodel-contract-tests.log; echo "tests failed — not deploying"; exit 1; }
tail -2 /tmp/openmodel-contract-tests.log

printf "Owner private key (hidden): "
IFS= read -rs KEY; echo
KEY="${KEY#0x}"
if ! [[ "$KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
  unset KEY; echo "not a 32-byte hex private key"; exit 1
fi
export DEPLOYER_PRIVATE_KEY="0x$KEY"
unset KEY
trap 'unset DEPLOYER_PRIVATE_KEY' EXIT

LOG=$(mktemp)
set +e
npx hardhat run scripts/mainnet-deploy.js --network mainnet 2>&1 | tee "$LOG"
RC=${PIPESTATUS[0]}
set -e
unset DEPLOYER_PRIVATE_KEY
ADDR=$(grep -o 'CONTRACT_ADDRESS=0x[0-9a-fA-F]\{40\}' "$LOG" | tail -1 | cut -d= -f2)
if [ "$RC" -ne 0 ]; then
  echo
  if [ -n "$ADDR" ] && [ -z "${SETTLEMENT_ADDRESS:-}" ]; then
    echo "The contract was deployed at $ADDR but a later step failed."
    echo "Resume on the SAME contract (do not deploy again):"
    echo "  SETTLEMENT_ADDRESS=$ADDR ./scripts/deploy-mainnet.sh"
  else
    echo "Deployment did not complete (see the error above)."
  fi
  exit "$RC"
fi

if [ -n "$ADDR" ]; then
  echo "Verifying the source on Blockscout ..."
  npx hardhat verify --network mainnet "$ADDR" 0 3600 || \
    echo "(source verification did not complete — re-run: npx hardhat verify --network mainnet $ADDR 0 3600)"
  echo
  echo "Deployed and configured: $ADDR"
  echo "Record: deployments/mainnet-v14.json"
fi
