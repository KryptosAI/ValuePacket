#!/usr/bin/env bash
set -euo pipefail

ANVIL_PORT=8545
RPC_URL="http://localhost:${ANVIL_PORT}"
ANVIL_PID=""
PRICE_FEED_PID=""
AUDIT_PID=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
  echo ""
  echo -e "${YELLOW}[cleanup] Stopping services...${NC}"
  for pid in "$PRICE_FEED_PID" "$AUDIT_PID" "$ANVIL_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

echo "============================================"
echo "  ValuePacket Protocol — Docker Demo"
echo "============================================"
echo ""

# ── Step 1: Start anvil ──────────────────────────────────────────
echo -e "${YELLOW}[1/8] Starting anvil...${NC}"
anvil --host 0.0.0.0 --port "$ANVIL_PORT" --chain-id 31337 > /tmp/anvil.log 2>&1 &
ANVIL_PID=$!
echo "  anvil PID: $ANVIL_PID"

# ── Step 2: Wait for anvil ───────────────────────────────────────
echo -e "${YELLOW}[2/8] Waiting for anvil...${NC}"
MAX_RETRIES=30
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
  if curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
    "$RPC_URL" 2>/dev/null | grep -q '"result"'; then
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

# ── Step 3: Deploy base contracts ────────────────────────────────
echo -e "${YELLOW}[3/8] Deploying base contracts...${NC}"

DEPLOYMENTS_FILE="/app/contracts/deployments/local.json"
mkdir -p "$(dirname "$DEPLOYMENTS_FILE")"

FORGE_OUTPUT=$(cd /app/contracts && forge script script/Deploy.s.sol \
  --broadcast \
  --rpc-url "$RPC_URL" \
  2>&1)
FORGE_EXIT=$?

if [ $FORGE_EXIT -ne 0 ]; then
  echo -e "${RED}  Forge script failed:${NC}"
  echo "$FORGE_OUTPUT"
  exit 1
fi

echo "  Forge deployment complete."

MOCK_USDC_ADDRESS=$(echo "$FORGE_OUTPUT" | grep 'MOCK_USDC=' | sed -E 's/.*MOCK_USDC=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
SERVICE_REGISTRY_ADDRESS=$(echo "$FORGE_OUTPUT" | grep 'SERVICE_REGISTRY=' | sed -E 's/.*SERVICE_REGISTRY=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
PAYMENT_CHANNEL_ADDRESS=$(echo "$FORGE_OUTPUT" | grep 'PAYMENT_CHANNEL=' | sed -E 's/.*PAYMENT_CHANNEL=\s*//;s/[^a-fA-F0-9x]//g' | head -1)
SPENDING_POLICY_ADDRESS=$(echo "$FORGE_OUTPUT" | grep 'SPENDING_POLICY=' | sed -E 's/.*SPENDING_POLICY=\s*//;s/[^a-fA-F0-9x]//g' | head -1)

echo "  MockUSDC:        $MOCK_USDC_ADDRESS"
echo "  ServiceRegistry: $SERVICE_REGISTRY_ADDRESS"
echo "  PaymentChannel:  $PAYMENT_CHANNEL_ADDRESS"
echo "  SpendingPolicy:  $SPENDING_POLICY_ADDRESS"

jq -n \
  --arg mockUSDC "$MOCK_USDC_ADDRESS" \
  --arg serviceRegistry "$SERVICE_REGISTRY_ADDRESS" \
  --arg paymentChannel "$PAYMENT_CHANNEL_ADDRESS" \
  --arg spendingPolicy "$SPENDING_POLICY_ADDRESS" \
  --arg chainId "31337" \
  '{
    mockUSDC: $mockUSDC,
    serviceRegistry: $serviceRegistry,
    paymentChannel: $paymentChannel,
    spendingPolicy: $spendingPolicy,
    chainId: ($chainId | tonumber)
  }' > "$DEPLOYMENTS_FILE"

echo -e "${GREEN}  Wrote $DEPLOYMENTS_FILE${NC}"

# ── Step 4: Deploy extension contracts ───────────────────────────
echo -e "${YELLOW}[4/8] Deploying extension contracts...${NC}"

EXTENSIONS_FILE="/app/contracts/deployments/extensions.json"
export PAYMENT_CHANNEL_ADDRESS

FORGE_EXT_OUTPUT=$(cd /app/contracts && forge script script/DeployExtensions.s.sol \
  --broadcast \
  --rpc-url "$RPC_URL" \
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
EAS_ADDRESS=$(echo "$FORGE_EXT_OUTPUT" | grep 'EAS_ADDRESS=' | sed -E 's/.*EAS_ADDRESS=\s*//;s/[^a-fA-F0-9x]//g' | head -1)

echo "  AgentReputation:      $AGENT_REPUTATION_ADDRESS"
echo "  SubscriptionManager:  $SUBSCRIPTION_MANAGER_ADDRESS"
echo "  CrossChainSettlement: $CROSS_CHAIN_SETTLEMENT_ADDRESS"

if [ -f "$EXTENSIONS_FILE" ]; then
  echo "  Extensions file already written by forge."
else
  jq -n \
    --arg agentReputation "$AGENT_REPUTATION_ADDRESS" \
    --arg subscriptionManager "$SUBSCRIPTION_MANAGER_ADDRESS" \
    --arg crossChainSettlement "$CROSS_CHAIN_SETTLEMENT_ADDRESS" \
    --arg easAddress "$EAS_ADDRESS" \
    --arg paymentChannel "$PAYMENT_CHANNEL_ADDRESS" \
    '{
      agentReputation: $agentReputation,
      subscriptionManager: $subscriptionManager,
      crossChainSettlement: $crossChainSettlement,
      easAddress: $easAddress,
      paymentChannel: $paymentChannel
    }' > "$EXTENSIONS_FILE"
fi

echo -e "${GREEN}  Extensions ready${NC}"

# ── Step 5: Export env vars ──────────────────────────────────────
export SERVICE_REGISTRY_ADDRESS
export PAYMENT_CHANNEL_ADDRESS
export SPENDING_POLICY_ADDRESS
export MOCK_USDC_ADDRESS
export USDC_TOKEN_ADDRESS="$MOCK_USDC_ADDRESS"
export RPC_URL="$RPC_URL"
export REPUTATION_ADDRESS="$AGENT_REPUTATION_ADDRESS"
export SUBSCRIPTION_MANAGER_ADDRESS="$SUBSCRIPTION_MANAGER_ADDRESS"
export EAS_ADDRESS="$EAS_ADDRESS"

echo -e "${YELLOW}[5/8] Environment:${NC}"
echo "  SERVICE_REGISTRY_ADDRESS=$SERVICE_REGISTRY_ADDRESS"
echo "  PAYMENT_CHANNEL_ADDRESS=$PAYMENT_CHANNEL_ADDRESS"
echo "  USDC_TOKEN_ADDRESS=$USDC_TOKEN_ADDRESS"
echo "  RPC_URL=$RPC_URL"

# ── Step 6: Start price-feed service ─────────────────────────────
echo -e "${YELLOW}[6/8] Starting price-feed server...${NC}"
cd /app/services/price-feed
CHAIN=local \
RPC_URL="$RPC_URL" \
PORT="${PORT_PRICE_FEED:-3000}" \
PAYMENT_CHANNEL_ADDRESS="$PAYMENT_CHANNEL_ADDRESS" \
npx tsx src/server.ts > /tmp/price-feed.log 2>&1 &
PRICE_FEED_PID=$!
echo "  price-feed PID: $PRICE_FEED_PID"

# Wait for price-feed to be healthy
for i in $(seq 1 20); do
  if curl -sf "http://localhost:${PORT_PRICE_FEED:-3000}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}  price-feed is healthy${NC}"
    break
  fi
  sleep 1
done

# ── Step 7: Start contract-audit service ─────────────────────────
echo -e "${YELLOW}[7/8] Starting contract-audit server...${NC}"
cd /app/services/contract-audit
CHAIN=local \
RPC_URL="$RPC_URL" \
PORT="${PORT_CONTRACT_AUDIT:-3001}" \
PAYMENT_CHANNEL_ADDRESS="$PAYMENT_CHANNEL_ADDRESS" \
npx tsx src/server.ts > /tmp/contract-audit.log 2>&1 &
AUDIT_PID=$!
echo "  contract-audit PID: $AUDIT_PID"

for i in $(seq 1 20); do
  if curl -sf "http://localhost:${PORT_CONTRACT_AUDIT:-3001}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}  contract-audit is healthy${NC}"
    break
  fi
  sleep 1
done

# ── Step 8: Run the CLI demo ─────────────────────────────────────
echo -e "${YELLOW}[8/8] Running CLI demo...${NC}"
cd /app/cli

npx tsx src/index.ts demo \
  --rpc "$RPC_URL" \
  --registry "$SERVICE_REGISTRY_ADDRESS" \
  --channels "$PAYMENT_CHANNEL_ADDRESS" \
  --token "$USDC_TOKEN_ADDRESS"
DEMO_EXIT=$?

echo ""
if [ $DEMO_EXIT -eq 0 ]; then
  echo -e "${GREEN}============================================${NC}"
  echo -e "${GREEN}  Demo completed successfully!${NC}"
  echo -e "${GREEN}============================================${NC}"
else
  echo -e "${RED}============================================${NC}"
  echo -e "${RED}  Demo finished with errors (exit $DEMO_EXIT)${NC}"
  echo -e "${RED}============================================${NC}"
fi

echo ""
echo -e "${GREEN}Services running:${NC}"
echo "  anvil:            http://localhost:8545"
echo "  price-feed:       http://localhost:${PORT_PRICE_FEED:-3000}  (GET /health)"
echo "  contract-audit:   http://localhost:${PORT_CONTRACT_AUDIT:-3001}  (GET /health)"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services.${NC}"

# Keep running so user can interact
wait
