#!/usr/bin/env bash
# Deposit FIL into the mainnet OpenModelSettlement contract (prepaid balance for API use).
#
#   ./scripts/deposit-mainnet.sh [amount_fil]
#
# Asks for the depositing wallet's private key (input hidden, never written to disk or
# the shell history), shows the wallet, the contract and the amount, and sends only
# after you type "yes". The API key that should spend this balance must be bound to the
# same wallet. Optional environment: CONTRACT (defaults to deployments/mainnet.json),
# EXPECTED_WALLET (refuse any other key), MAINNET_RPC_URL.
set -euo pipefail
cd "$(dirname "$0")/.."

AMOUNT="${1:-}"
if [ -z "$AMOUNT" ]; then printf "Amount to deposit (FIL): "; read -r AMOUNT; fi
[[ "$AMOUNT" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "not a number: $AMOUNT"; exit 1; }

command -v node >/dev/null || { echo "node is required (v18 or later)"; exit 1; }
[ -d node_modules ] || npm ci --no-audit --no-fund
npx hardhat compile --quiet

printf "Depositing wallet private key (hidden): "
IFS= read -rs KEY; echo
KEY="${KEY#0x}"
[[ "$KEY" =~ ^[0-9a-fA-F]{64}$ ]] || { unset KEY; echo "not a 32-byte hex private key"; exit 1; }
WALLET=$(KEY="$KEY" node -e 'console.log(new (require("ethers").Wallet)("0x"+process.env.KEY).address)')
CONTRACT_ADDR="${CONTRACT:-$(node -e 'console.log(require("./deployments/mainnet.json").address)')}"
echo
echo "  wallet:   $WALLET"
echo "  contract: $CONTRACT_ADDR"
echo "  amount:   $AMOUNT FIL"
printf "Type yes to send: "; read -r OK
[ "$OK" = yes ] || { unset KEY; echo "cancelled"; exit 1; }

export DEPOSITOR_PRIVATE_KEY="0x$KEY"; unset KEY
trap 'unset DEPOSITOR_PRIVATE_KEY' EXIT
CONTRACT="$CONTRACT_ADDR" DEPOSIT_FIL="$AMOUNT" npx hardhat run scripts/mainnet-deposit.js --network mainnet
