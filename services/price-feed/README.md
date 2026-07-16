# Price Feed Agent

An HTTP microservice that serves live cryptocurrency prices in exchange for ValuePacket micropayments. Any AI agent can open a payment channel and subscribe to real-time price data.

## How it works

1. A payer agent opens a ValuePacket payment channel with a minimum $1.00 USDC deposit
2. The agent sends `POST /price/eth-usdc` with EIP-712 payment proof headers
3. The server verifies the proof on-chain, deducts $0.001 from the channel, and returns the live price
4. Prices are cached for 30 seconds to avoid CoinGecko rate limits

## Prerequisites

- Node.js >= 18
- A running Ethereum JSON-RPC endpoint (local Anvil, testnet, or mainnet)
- The ValuePacket protocol contracts deployed to that chain

## Quick start

```bash
# From the project root, install dependencies
npm install

# Set environment variables
cp services/price-feed/.env.example services/price-feed/.env
# Edit .env with your RPC_URL and PAYMENT_CHANNEL_ADDRESS

# Start the server
npm -w @valuepacket/service-price-feed start
```

## Endpoints

### `GET /health`

Returns service status. No payment required.

```json
{
  "status": "ok",
  "service": "price-feed",
  "version": "0.1.0"
}
```

### `POST /price/eth-usdc`

Returns the current ETH/USD price. Requires a valid payment proof.

**Request headers:**

| Header | Description |
|--------|-------------|
| `X-Channel-Id` | Payment channel ID (uint256 as string) |
| `X-Cumulative-Spent` | Total spent so far including this request |
| `X-Payment-Proof` | EIP-712 signature over the PaymentProof message |
| `X-Request-Nonce` | Request counter for this channel |
| `X-Request-Hash` | keccak256 hash of the request body |

**Response:**

```json
{
  "price": 1847.32,
  "timestamp": "2026-07-15T12:00:00.000Z",
  "source": "coingecko"
}
```

### `POST /price/btc-usdc`

Returns the current BTC/USD price. Same payment requirements as above.

## Pricing

| Parameter | Value |
|-----------|-------|
| Price per request | $0.001 (1,000 USDC wei) |
| Minimum channel deposit | $1.00 (1,000,000 USDC wei) |

## Agent integration (payer side)

```typescript
import { AgentPay } from '@valuepacket/sdk';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const agent = new AgentPay({
  wallet: createWalletClient({
    account: privateKeyToAccount('0x...'),
    transport: http(RPC_URL),
  }),
  publicClient: createPublicClient({ transport: http(RPC_URL) }),
  serviceRegistryAddress: '0x...',
  paymentChannelAddress: '0x...',
});

const channel = await agent.openChannel({
  provider: PRICE_FEED_PROVIDER_ADDRESS,
  token: USDC_ADDRESS,
  deposit: 1_000_000n,
  expiresIn: 3600,
});

channel.setEndpoint('http://localhost:3000/price/eth-usdc');
channel.setPricePerRequest(1_000n);

const { price, timestamp } = await channel.request({});
console.log(`ETH price: $${price}`);

await channel.close();
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | Yes | `http://localhost:8545` | Ethereum JSON-RPC endpoint |
| `PAYMENT_CHANNEL_ADDRESS` | Yes | — | Deployed PaymentChannel contract |
| `PORT` | No | `3000` | HTTP server port |
