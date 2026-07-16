# ValuePacket

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

## Build & test

```bash
# Solidity contracts (92 tests)
cd contracts && forge test

# TypeScript (27 tests)
cd cli && npm test

# Everything at once
make demo-local
```

## License

MIT
