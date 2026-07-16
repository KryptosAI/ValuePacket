# Contract Audit Agent

An HTTP microservice that performs rule-based smart contract security audits in exchange for ValuePacket micropayments. Agents pay ~$2 per audit via on-chain payment channels.

## How it works

1. A payer agent opens a ValuePacket payment channel with a minimum $5.00 USDC deposit
2. The agent sends `POST /audit` with `{ chainId: number, address: "0x..." }` and EIP-712 payment proof headers
3. The server verifies the proof on-chain, fetches the contract source from a block explorer, and runs static analysis
4. Results are cached for 1 hour per contract address

## Static analysis checks

| Check | Severity |
|-------|----------|
| `selfdestruct` — contract can be destroyed | high |
| `tx.origin` — vulnerable to phishing | high |
| `delegatecall` — arbitrary code execution in contract context | medium |
| `bytes calldata` in external functions — arbitrary call data | medium |
| `block.timestamp` — miner manipulable | low |
| `blockhash` — predictable randomness | low |
| `onlyOwner` modifier — centralization risk | low |
| `.transfer()` — fixed gas stipend issues | low |
| `extcodesize` — unreliable contract detection | low |
| Proxy pattern (>= 2 delegatecall) | info |

## Quick start

```bash
# From the project root, install dependencies
npm install

# Set environment variables
cp services/contract-audit/.env.example services/contract-audit/.env
# Edit .env with your RPC_URL and PAYMENT_CHANNEL_ADDRESS

# Start the server
npm -w @valuepacket/service-contract-audit start
```

## Endpoints

### `GET /health`

Returns service status. No payment required.

```json
{
  "status": "ok",
  "service": "contract-audit",
  "version": "0.2.1"
}
```

### `POST /audit`

Returns a structured risk report. Requires a valid payment proof.

**Request body:**

```json
{
  "chainId": 8453,
  "address": "0x1234567890123456789012345678901234567890"
}
```

**Request headers:**

| Header | Description |
|--------|-------------|
| `X-Channel-Id` | Payment channel ID (uint256 as string) |
| `X-Cumulative-Spent` | Total spent including this request |
| `X-Payment-Proof` | EIP-712 signature over the PaymentProof message |
| `X-Request-Nonce` | Request counter for this channel |
| `X-Request-Hash` | keccak256 hash of the request body |

**Response:**

```json
{
  "address": "0x...",
  "chain": 8453,
  "verified": true,
  "riskScore": 3,
  "findings": [
    { "severity": "high", "description": "Uses tx.origin for authorization", "line": 42 },
    { "severity": "medium", "description": "Contains delegatecall", "line": 128 }
  ],
  "summary": "3 findings: 1 high, 1 medium, 1 low"
}
```

## Pricing

| Parameter | Value |
|-----------|-------|
| Price per request | $2.00 (2,000,000 USDC wei) |
| Minimum channel deposit | $5.00 (5,000,000 USDC wei) |

## Supported chains

| Chain ID | Network | Explorer API |
|----------|---------|-------------|
| 1 | Ethereum Mainnet | api.etherscan.io |
| 11155111 | Sepolia | api-sepolia.etherscan.io |
| 8453 | Base | api.basescan.org |
| 84532 | Base Sepolia | api-sepolia.basescan.org |

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | Yes | `http://localhost:8545` | Ethereum JSON-RPC endpoint |
| `PAYMENT_CHANNEL_ADDRESS` | Yes | — | Deployed PaymentChannel contract |
| `ETHERSCAN_API_KEY` | No | — | Etherscan API key |
| `BASESCAN_API_KEY` | No | — | BaseScan API key |
| `PORT` | No | `3001` | HTTP server port |
