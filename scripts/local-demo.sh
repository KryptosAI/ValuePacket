#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CONTRACTS_DIR="$ROOT_DIR/contracts"
CLI_DIR="$ROOT_DIR/cli"
DEPLOYMENTS_FILE="$CONTRACTS_DIR/deployments/local.json"
ANVIL_PORT=8545
ANVIL_PID=""
SKIP_ANVIL_START=false

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
  if [ "$SKIP_ANVIL_START" = false ] && [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    echo ""
    echo -e "${YELLOW}[cleanup] Killing anvil (PID $ANVIL_PID)...${NC}"
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "============================================"
echo "  ValuePacket Protocol — Local Demo"
echo "============================================"
echo ""

# ── Step 1: Check for existing anvil ──────────────────────────────────
echo -e "${YELLOW}[1/9] Checking for existing anvil on port $ANVIL_PORT...${NC}"
SKIP_ANVIL_START=false
if curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  "http://localhost:$ANVIL_PORT" 2>/dev/null | grep -q '31337'; then
  echo -e "${GREEN}  Reusing existing anvil on port $ANVIL_PORT (chain 31337)${NC}"
  SKIP_ANVIL_START=true
elif lsof -ti "tcp:$ANVIL_PORT" >/dev/null 2>&1; then
  echo -e "${RED}  Port $ANVIL_PORT is in use by a non-anvil process. Aborting.${NC}"
  exit 1
else
  echo "  No existing anvil found, will start a new one."
fi
echo -e "${GREEN}  Done${NC}"

# ── Step 2: Start anvil (if needed) ───────────────────────────────────
if [ "$SKIP_ANVIL_START" = false ]; then
  echo -e "${YELLOW}[2/9] Starting anvil in background...${NC}"
  anvil --host 0.0.0.0 --port "$ANVIL_PORT" --chain-id 31337 > /tmp/anvil-local.log 2>&1 &
  ANVIL_PID=$!
  echo "  anvil PID: $ANVIL_PID"
else
  echo -e "${YELLOW}[2/9] Using existing anvil (skipping start)${NC}"
fi

# ── Step 3: Wait for anvil to be ready ────────────────────────────────
if [ "$SKIP_ANVIL_START" = false ]; then
  echo -e "${YELLOW}[3/9] Waiting for anvil to be ready...${NC}"
  MAX_RETRIES=30
  RETRY=0
  while [ $RETRY -lt $MAX_RETRIES ]; do
    if curl -s "http://localhost:$ANVIL_PORT" \
         -X POST \
         -H 'Content-Type: application/json' \
         -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
         2>/dev/null | grep -q '"result"'; then
      echo -e "${GREEN}  anvil is ready${NC}"
      break
    fi
    RETRY=$((RETRY + 1))
    sleep 1
  done

  if [ $RETRY -eq $MAX_RETRIES ]; then
    echo -e "${RED}  anvil failed to start within ${MAX_RETRIES}s${NC}"
    exit 1
  fi
else
  echo -e "${YELLOW}[3/9] anvil already running (skipping wait)${NC}"
fi

# ── Step 4: Deploy contracts ──────────────────────────────────────────
echo -e "${YELLOW}[4/9] Deploying contracts via forge script...${NC}"

ANVIL_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
export DEPLOYER_PRIVATE_KEY="$ANVIL_PRIVATE_KEY"

mkdir -p "$(dirname "$DEPLOYMENTS_FILE")"

FORGE_OUTPUT=$(cd "$CONTRACTS_DIR" && forge script script/Deploy.s.sol \
  --broadcast \
  --rpc-url "http://localhost:$ANVIL_PORT" \
  2>&1)
FORGE_EXIT=$?

if [ $FORGE_EXIT -ne 0 ]; then
  echo -e "${RED}  Forge script failed:${NC}"
  echo "$FORGE_OUTPUT"
  exit 1
fi

echo "  Forge deployment complete."

# Parse addresses from forge output (silence stderr for macOS grep -P compatibility)
MOCK_USDC_ADDRESS=$(echo "$FORGE_OUTPUT" | grep -oP 'MOCK_USDC=\s*\K(0x[a-fA-F0-9]{40})' 2>/dev/null || true)
SERVICE_REGISTRY_ADDRESS=$(echo "$FORGE_OUTPUT" | grep -oP 'SERVICE_REGISTRY=\s*\K(0x[a-fA-F0-9]{40})' 2>/dev/null || true)
PAYMENT_CHANNEL_ADDRESS=$(echo "$FORGE_OUTPUT" | grep -oP 'PAYMENT_CHANNEL=\s*\K(0x[a-fA-F0-9]{40})' 2>/dev/null || true)
SPENDING_POLICY_ADDRESS=$(echo "$FORGE_OUTPUT" | grep -oP 'SPENDING_POLICY=\s*\K(0x[a-fA-F0-9]{40})' 2>/dev/null || true)

# Fallback parsing (macOS grep doesn't support -P)
if [ -z "$MOCK_USDC_ADDRESS" ]; then
  MOCK_USDC_ADDRESS=$(echo "$FORGE_OUTPUT" | grep 'MOCK_USDC=' | sed -E 's/.*MOCK_USDC=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
fi
if [ -z "$SERVICE_REGISTRY_ADDRESS" ]; then
  SERVICE_REGISTRY_ADDRESS=$(echo "$FORGE_OUTPUT" | grep 'SERVICE_REGISTRY=' | sed -E 's/.*SERVICE_REGISTRY=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
fi
if [ -z "$PAYMENT_CHANNEL_ADDRESS" ]; then
  PAYMENT_CHANNEL_ADDRESS=$(echo "$FORGE_OUTPUT" | grep 'PAYMENT_CHANNEL=' | sed -E 's/.*PAYMENT_CHANNEL=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
fi
if [ -z "$SPENDING_POLICY_ADDRESS" ]; then
  SPENDING_POLICY_ADDRESS=$(echo "$FORGE_OUTPUT" | grep 'SPENDING_POLICY=' | sed -E 's/.*SPENDING_POLICY=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
fi

echo "  MockUSDC:        $MOCK_USDC_ADDRESS"
echo "  ServiceRegistry: $SERVICE_REGISTRY_ADDRESS"
echo "  PaymentChannel:  $PAYMENT_CHANNEL_ADDRESS"
echo "  SpendingPolicy:  $SPENDING_POLICY_ADDRESS"

# ── Step 5: Write deployment addresses ────────────────────────────────
echo -e "${YELLOW}[5/9] Writing deployment addresses to $DEPLOYMENTS_FILE...${NC}"

if command -v jq &>/dev/null; then
  jq -n \
    --arg mockUSDC "$MOCK_USDC_ADDRESS" \
    --arg registry "$SERVICE_REGISTRY_ADDRESS" \
    --arg channels "$PAYMENT_CHANNEL_ADDRESS" \
    --arg policy "$SPENDING_POLICY_ADDRESS" \
    '{
      mockUSDC: $mockUSDC,
      serviceRegistry: $registry,
      paymentChannel: $channels,
      spendingPolicy: $policy
    }' > "$DEPLOYMENTS_FILE"
else
  cat > "$DEPLOYMENTS_FILE" <<JSON
{
  "mockUSDC": "$MOCK_USDC_ADDRESS",
  "serviceRegistry": "$SERVICE_REGISTRY_ADDRESS",
  "paymentChannel": "$PAYMENT_CHANNEL_ADDRESS",
  "spendingPolicy": "$SPENDING_POLICY_ADDRESS"
}
JSON
fi

echo -e "${GREEN}  Wrote $DEPLOYMENTS_FILE${NC}"

# ── Step 6: Deploy extension contracts ─────────────────────────────────
echo -e "${YELLOW}[6/9] Deploying extension contracts via forge script...${NC}"

# DeployExtensions.s.sol reads PAYMENT_CHANNEL_ADDRESS via vm.envAddress
export PAYMENT_CHANNEL_ADDRESS

EXTENSIONS_FILE="$CONTRACTS_DIR/deployments/extensions.json"

FORGE_EXT_OUTPUT=$(cd "$CONTRACTS_DIR" && forge script script/DeployExtensions.s.sol \
  --broadcast \
  --rpc-url "http://localhost:$ANVIL_PORT" \
  2>&1)
FORGE_EXT_EXIT=$?

if [ $FORGE_EXT_EXIT -ne 0 ]; then
  echo -e "${RED}  Forge extensions script failed:${NC}"
  echo "$FORGE_EXT_OUTPUT"
  exit 1
fi

echo "  Extension deployment complete."

AGENT_REPUTATION_ADDRESS=$(echo "$FORGE_EXT_OUTPUT" | grep 'AGENT_REPUTATION=' | sed -E 's/.*AGENT_REPUTATION=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
SUBSCRIPTION_MANAGER_ADDRESS=$(echo "$FORGE_EXT_OUTPUT" | grep 'SUBSCRIPTION_MANAGER=' | sed -E 's/.*SUBSCRIPTION_MANAGER=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
CROSS_CHAIN_SETTLEMENT_ADDRESS=$(echo "$FORGE_EXT_OUTPUT" | grep 'CROSS_CHAIN_SETTLEMENT=' | sed -E 's/.*CROSS_CHAIN_SETTLEMENT=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
EAS_ADDRESS_EXT=$(echo "$FORGE_EXT_OUTPUT" | grep 'EAS_ADDRESS=' | sed -E 's/.*EAS_ADDRESS=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
AXELAR_GATEWAY_ADDRESS=$(echo "$FORGE_EXT_OUTPUT" | grep 'AXELAR_GATEWAY=' | sed -E 's/.*AXELAR_GATEWAY=\s*//;s/[^a-fA-F0-9x]//g' | head -1)

echo "  AgentReputation:      $AGENT_REPUTATION_ADDRESS"
echo "  SubscriptionManager:  $SUBSCRIPTION_MANAGER_ADDRESS"
echo "  CrossChainSettlement: $CROSS_CHAIN_SETTLEMENT_ADDRESS"
echo "  EAS:                  $EAS_ADDRESS_EXT"
echo "  AxelarGateway:        $AXELAR_GATEWAY_ADDRESS"

if command -v jq &>/dev/null; then
  jq -n \
    --arg agentReputation "$AGENT_REPUTATION_ADDRESS" \
    --arg subscriptionManager "$SUBSCRIPTION_MANAGER_ADDRESS" \
    --arg crossChainSettlement "$CROSS_CHAIN_SETTLEMENT_ADDRESS" \
    --arg easAddress "$EAS_ADDRESS_EXT" \
    --arg paymentChannel "$PAYMENT_CHANNEL_ADDRESS" \
    --arg axelarGateway "$AXELAR_GATEWAY_ADDRESS" \
    '{
      agentReputation: $agentReputation,
      subscriptionManager: $subscriptionManager,
      crossChainSettlement: $crossChainSettlement,
      easAddress: $easAddress,
      paymentChannel: $paymentChannel,
      axelarGateway: $axelarGateway
    }' > "$EXTENSIONS_FILE"
else
  cat > "$EXTENSIONS_FILE" <<JSON
{
  "agentReputation": "$AGENT_REPUTATION_ADDRESS",
  "subscriptionManager": "$SUBSCRIPTION_MANAGER_ADDRESS",
  "crossChainSettlement": "$CROSS_CHAIN_SETTLEMENT_ADDRESS",
  "easAddress": "$EAS_ADDRESS_EXT",
  "paymentChannel": "$PAYMENT_CHANNEL_ADDRESS",
  "axelarGateway": "$AXELAR_GATEWAY_ADDRESS"
}
JSON
fi

echo -e "${GREEN}  Wrote $EXTENSIONS_FILE${NC}"

# ── Step 7: Export env vars ───────────────────────────────────────────
echo -e "${YELLOW}[7/9] Exporting environment variables...${NC}"
export SERVICE_REGISTRY_ADDRESS
export PAYMENT_CHANNEL_ADDRESS
export SPENDING_POLICY_ADDRESS
export MOCK_USDC_ADDRESS
export USDC_TOKEN_ADDRESS="$MOCK_USDC_ADDRESS"
export RPC_URL="http://localhost:$ANVIL_PORT"

echo "  SERVICE_REGISTRY_ADDRESS=$SERVICE_REGISTRY_ADDRESS"
echo "  PAYMENT_CHANNEL_ADDRESS=$PAYMENT_CHANNEL_ADDRESS"
echo "  USDC_TOKEN_ADDRESS=$USDC_TOKEN_ADDRESS"
echo "  RPC_URL=$RPC_URL"

# ── Step 8: Run the CLI demo ──────────────────────────────────────────
echo -e "${YELLOW}[8/9] Running CLI demo...${NC}"

cd "$CLI_DIR"
npx tsx src/index.ts demo \
  --rpc "$RPC_URL" \
  --registry "$SERVICE_REGISTRY_ADDRESS" \
  --channels "$PAYMENT_CHANNEL_ADDRESS" \
  --token "$USDC_TOKEN_ADDRESS"
DEMO_EXIT=$?
cd "$ROOT_DIR"

if [ $DEMO_EXIT -ne 0 ]; then
  echo -e "${RED}  Demo exited with code $DEMO_EXIT${NC}"
fi

# ── Step 9: Cleanup ───────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[9/9] Cleaning up...${NC}"
if [ "$SKIP_ANVIL_START" = false ] && [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
  kill "$ANVIL_PID" 2>/dev/null || true
  wait "$ANVIL_PID" 2>/dev/null || true
  echo "  anvil stopped"
else
  echo "  Leaving existing anvil running"
fi

# ── Summary ────────────────────────────────────────────────────────────
echo ""
if [ $FORGE_EXIT -eq 0 ] && [ $DEMO_EXIT -eq 0 ]; then
  echo -e "${GREEN}============================================${NC}"
  echo -e "${GREEN}  Local demo completed successfully!${NC}"
  echo -e "${GREEN}============================================${NC}"
else
  echo -e "${RED}============================================${NC}"
  echo -e "${RED}  Local demo finished with errors.${NC}"
  echo -e "${RED}  Forge exit: $FORGE_EXIT | Demo exit: $DEMO_EXIT${NC}"
  echo -e "${RED}============================================${NC}"
  exit 1
fi
