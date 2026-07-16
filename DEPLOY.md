# Deploy ValuePacket to Base Sepolia

## Prerequisites

You're working in `/Users/williamweishuhn/Documents/New OpenCode Project/contracts/`.
The deployer private key is in `contracts/.env` as `DEPLOYER_PRIVATE_KEY`.
The deployer address is `0x9bAF5bDbE827ea13e85630DA9daAdEf016dFc89B`.

## Step 1: Get Base Sepolia ETH

Go to https://www.alchemy.com/faucets/base-sepolia in a browser.
Sign in (free account). Paste the deployer address: `0x9bAF5bDbE827ea13e85630DA9daAdEf016dFc89B`.
Click request. Wait 30 seconds.

Verify it arrived:
```bash
source contracts/.env
cast balance 0x9bAF5bDbE827ea13e85630DA9daAdEf016dFc89B --rpc-url https://sepolia.base.org
```
Expected: something > 0.

## Step 2: Deploy contracts

```bash
cd /Users/williamweishuhn/Documents/New\ OpenCode\ Project/contracts
source .env
forge script script/DeploySepolia.s.sol --rpc-url https://sepolia.base.org --broadcast
```

This deploys ServiceRegistry, PaymentChannel, and SpendingPolicy.
It writes addresses to `deployments/base-sepolia.json`.

## Step 3: Verify

```bash
cat deployments/base-sepolia.json
```

Should contain serviceRegistry, paymentChannel, spendingPolicy addresses.

## Step 4: Update GitHub

```bash
cd /Users/williamweishuhn/Documents/New\ OpenCode\ Project
git add -f contracts/deployments/base-sepolia.json
git commit -m "Deploy ValuePacket contracts to Base Sepolia"
git push
```

## Step 5: Start price feed server

```bash
cd /Users/williamweishuhn/Documents/New\ OpenCode\ Project/services/price-feed
export RPC_URL=https://sepolia.base.org
export PAYMENT_CHANNEL_ADDRESS=<paste from base-sepolia.json>
export PORT=3000
npx tsx src/server.ts
```

The server will be live at http://localhost:3000.

Test it:
```bash
curl http://localhost:3000/health
```
Expected: `{"status":"ok","service":"price-feed","version":"0.1.0"}`
