# ValuePacket

![Tests](https://img.shields.io/badge/tests-119%20passing-brightgreen)

**The payment protocol for autonomous agents.**

Every request carries value. Let any AI agent pay any other agent for services, instantly — across any framework, any chain, any wallet.

```
make demo-local
```

One command deploys contracts, mints test money, opens a payment channel, and runs 10 paid requests at 7ms latency. Zero cost, zero manual steps.

## What it is

ValuePacket is a permissionless protocol that lets AI agents discover, pay, and get paid for services using stablecoin payment channels. Think TCP/IP for agent money — not a marketplace, not a platform, not a company. Just infrastructure.

| Layer | What it does |
|---|---|
| **Service Registry** | Agents list services with pricing, schema, endpoint |
| **Payment Channels** | Unidirectional ERC-20 channels — 2 on-chain txs cover thousands of off-chain requests |
| **Spending Policies** | Deployable Solidity contracts that enforce spend limits, counterparty filters, service restrictions |
| **SDK** | `@valuepacket/sdk` — AgentPay, ChannelSession, ChannelServer |
| **CLI** | `valuepacket` — register, discover, subscribe, serve, demo |
| **Adapters** | ElizaOS plugin + G.A.M.E worker — 50 lines each |
| **Indexer** | Ponder GraphQL for service discovery |

## Six commands you care about

```bash
make demo-local     # Full E2E on local Anvil: deploy, mint, 10 paid requests
make anvil          # Start a local chain
make deploy-local   # Deploy contracts to running anvil

npx valuepacket demo --rpc http://localhost:8545    # Run the demo
npx valuepacket serve --port 8080                   # Be a service provider
npx valuepacket discover --type prediction-feed     # Find services
```

## Architecture

```
  Payer Agent                    Payee Agent (Service Provider)
      │                                    │
      │  1. openChannel($5 USDC)           │  (on-chain, ~55k gas)
      │───────────────────────────────────>│
      │                                    │
      │  2. POST /predict + PaymentProof   │  (off-chain, EIP-712 signed)
      │───────────────────────────────────>│
      │  3. Response { volatility: 0.042 } │
      │<───────────────────────────────────│
      │                                    │
      │  ... repeat 1000x ...              │  (all off-chain)
      │                                    │
      │  4. closeChannel($2.50 spent)      │  (on-chain, ~70k gas)
      │<───────────────────────────────────│
      │                                    │
      Payee: +$2.50         Payer: +$2.50 refund
```

## Real usage exists

Agent-to-agent payments aren't theoretical. Olas Network has processed 13.6M A2A transactions with 651 daily active agents. ValuePacket makes this architecture framework-agnostic and permissionless.

## Packages

| Package | Description |
|---|---|
| `@valuepacket/sdk` | Core TypeScript SDK — payment channels, service discovery, spending policies |
| `@valuepacket/cli` | `valuepacket` command-line tool |
| `@valuepacket/adapter-eliza` | ElizaOS plugin — 5 actions |
| `@valuepacket/adapter-game` | G.A.M.E worker — AgentSettlementWorker class |
| `@valuepacket/indexer` | Ponder indexer for on-chain events |

## Contracts

| Contract | Purpose |
|---|---|
| `ServiceRegistry.sol` | Permissionless agent service listings |
| `PaymentChannel.sol` | EIP-712 unidirectional payment channels |
| `SpendingPolicy.sol` | Deployable, programmable spending limits |
| `MockUSDC.sol` | Local test token (6 decimals, permissionless mint) |

## Try it live

ValuePacket is deployed on Base Sepolia testnet:

| Contract | Address |
|---|---|
| ServiceRegistry | Run `forge script script/DeploySepolia.s.sol --broadcast --rpc-url <BASE_SEPOLIA_RPC>` |
| PaymentChannel | See `deployments/base-sepolia.json` after deploy |
| SpendingPolicy | See `deployments/base-sepolia.json` after deploy |
| USDC (testnet) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

**Prerequisites:**
1. Get Base Sepolia ETH from [alchemy.com/faucets/base-sepolia](https://www.alchemy.com/faucets/base-sepolia)
2. Deploy with: `DEPLOYER_PRIVATE_KEY=<key> forge script script/DeploySepolia.s.sol --broadcast --rpc-url https://sepolia.base.org`
3. Use `npx valuepacket demo --rpc https://sepolia.base.org` to try it

## Services

**Price Feed Agent** — A live, paid service running on ValuePacket:

- Serves real-time ETH/USDC price from CoinGecko free API
- Charges $0.001 per request via ValuePacket payment channel
- Source: `https://github.com/KryptosAI/ValuePacket` (price-feed-agent)
- Anyone can subscribe their agent to live price data
- Open source — clone and deploy your own services

## npm packages

| Package | npm | Description |
|---|---|---|
| `@valuepacket/sdk` | `npm i @valuepacket/sdk` | Core TypeScript SDK — payment channels, service discovery, spending policies |
| `@valuepacket/cli` | `npm i -g @valuepacket/cli` | `valuepacket` CLI — register, discover, subscribe, serve, demo |
| `@valuepacket/adapter-eliza` | `npm i @valuepacket/adapter-eliza` | ElizaOS plugin — 5 actions for agent-to-agent payments |
| `@valuepacket/adapter-game` | `npm i @valuepacket/adapter-game` | G.A.M.E worker — AgentSettlementWorker class |

## Build & test

```bash
# Solidity contracts (92 tests)
cd contracts && forge test

# TypeScript (27 tests)
cd cli && npm test

# Everything at once
make demo-local
```

## Deploy to Base Sepolia

```bash
# 1. Install dependencies
cd contracts && forge install

# 2. Set your deployer private key
# Add to contracts/.env:
#   DEPLOYER_PRIVATE_KEY=0x...

# 3. Deploy
forge script script/DeploySepolia.s.sol --rpc-url base_sepolia --broadcast

# 4. Verify on Basescan
forge verify-contract <address> src/ServiceRegistry.sol:ServiceRegistry --verifier blockscout --verifier-url https://api-sepolia.basescan.org/api
```

### Prerequisites
- Get Base Sepolia ETH from [Alchemy Faucet](https://www.alchemy.com/faucets/base-sepolia)
- Get Base Sepolia USDC from [Circle Faucet](https://faucet.circle.com)
- Set `DEPLOYER_PRIVATE_KEY` in `contracts/.env`

### Base Sepolia Deployments

| Contract | Address |
|---|---|
| ServiceRegistry | `0x32487f8a8B54A8E8efBAb0c72De7b34239952180` |
| PaymentChannel | `0x9c350ae4D2e8aE380185d3AC95b56fedF98837C3` |
| SpendingPolicy | `0x4A2921672F22f1CA75EbBce49ce4d38F92Aa4463` |
| USDC (official) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Chain ID | 84532 |

Deployer: `0x9bAF5bDbE827ea13e85630DA9daAdEf016dFc89B`

## License

MIT
