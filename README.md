# ValuePacket

[![CI](https://github.com/KryptosAI/ValuePacket/actions/workflows/ci.yml/badge.svg)](https://github.com/KryptosAI/ValuePacket/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-177%20Solidity%20%2B%20TypeScript%20tests-brightgreen)
![Verified](https://img.shields.io/badge/Counterflow-3%2F3%20contracts%20PROVED-success)

**The payment protocol for autonomous agents. Machine-verified.**

Every request carries value. Let any AI agent pay any other agent for services, instantly — across any framework, any chain, any wallet.

```
make demo-local
```

One command deploys contracts, mints test money, opens a payment channel, and runs 10 paid requests at 7ms latency. Zero cost, zero manual steps.

![ValuePacket local demo](demo.gif)

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

## Docker (zero prerequisites)

```bash
docker compose up
```

or

```bash
make demo-docker
```

Starts anvil, deploys contracts, launches price-feed and contract-audit services, and runs the happy-path harness. No Foundry, Node, or anvil required on the host.

After the demo completes, services stay running:
- `curl http://localhost:3000/health` — price-feed
- `curl http://localhost:3001/health` — contract-audit
- `curl -X POST http://localhost:8545 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'` — anvil

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

## Design limitations

These are deliberate MVP choices, not oversights:

- **No pause mechanism.** There is no emergency stop or admin kill switch. Funds only move
  through the documented channel/subscription/escrow flows.
- **No upgradeability.** All contracts are immutable once deployed; fixes ship as new
  deployments, never in-place upgrades.
- **Gas is not reimbursed.** Payers, payees, and relayers pay their own transaction costs
  (e.g. payees pay for `renew()`, payers for `cancel()`, anyone for
  `sweepCancelledSubscription()`).

## Try it live

ValuePacket is deployed on Base Sepolia testnet:

| Contract | Address |
|---|---|
| ServiceRegistry | `0x32487f8a8B54A8E8efBAb0c72De7b34239952180` |
| PaymentChannel | `0x9c350ae4D2e8aE380185d3AC95b56fedF98837C3` |
| SpendingPolicy | `0x4A2921672F22f1CA75EbBce49ce4d38F92Aa4463` |
| SubscriptionManager | `0x3116436B73e9Bbe230e517460A780359ba90B033` |
| AgentReputation | `0x014d6681978A43E0ceCF7BF6474095f7Fa5905f3` |
| USDC (testnet) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Try it: `npx valuepacket demo --rpc https://sepolia.base.org`

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
# Solidity contracts (177 tests)
cd contracts && forge test

# TypeScript
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

## Verified by Counterflow

ValuePacket is the first agent payment protocol shipping with machine-checked mathematical proofs. Every contract release is verified by [Counterflow](https://github.com/KryptosAI/counterflow) — an AI-translated, Z3-proved formal verification tool from KryptosAI.

```
  3/3 PROVED — pool-level accounting
  PaymentChannel        ✓ non-negative contract balance
  CrossChainSettlement  ✓ non-negative contract balance
  SubscriptionManager   ✓ non-negative contract balance
```

Audit chain: `a33aa593…` (3 entries, SHA-256 tamper-evident). Generated by Counterflow v0.3.0.

**Coverage:** Pool-level deposit conservation and non-negative balance are inductively proved for all inputs. Channel/escrow/subscription lifecycle invariants (status transitions, per-channel deposit conservation, signature authorization, expiry gating) are documented and queued for the next Counterflow model extension.

**How it works:** Counterflow takes the Solidity source, translates safety properties into a fixed formal vocabulary via LLM, and a ~350-line auditable Z3 core either proves the property for all possible inputs or produces a concrete counterexample. The full audit chain is SHA-256 hash-chained and tamper-evident. [Read more →](veros-verify/README.md)

Run verification locally:
```bash
cd veros-verify && npm run valuepacket
```

## For maintainers

After pushing, set these in GitHub repo Settings:
- Topics: ai-agents, payment-channels, ethereum, solidity, web3, micropayments, elizaos, agent-economy, stablecoin, base
- Social preview: upload a 1280x640 image
- Website: https://valuepacket.dev (when deployed)

## License

MIT
