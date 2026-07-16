# Agent Settlement Layer — MVP Spec v2

**Principle**: Any agent can pay any other agent for services, regardless of framework or wallet infrastructure.
**Hard constraint**: Cross-framework integration in under 10 minutes.

---

## 0. Ground truth — what's already happening

This spec is grounded in production data, not hypothesis.

| Signal | Source | Number |
|---|---|---|
| Agent-to-agent transactions | Olas Mech Marketplace (on-chain) | 13.6M |
| Daily active agents transacting | Olas dashboard | 651 |
| Total A2A turnover | Olas | $105K |
| Average transaction size | $105K / 13.6M | ~$0.008 |
| Agent API monetization | Nevermined | 1.2M req/day, $4.8K/day |
| Active agents on Nevermined | Nevermined dashboard | 342 |
| Projects using AgentKit | GitHub dependents | 679 |
| Agent framework adoption | ElizaOS GitHub | 18.7k stars, 5.6k forks |

**Key takeaways for this spec:**

1. **A2A payments are real, proven, and high-frequency/low-value.** Per-transaction on-chain escrow is economically broken at $0.008 avg — the payment rail must batch or channel.
2. **The market is fragmented by ecosystem.** Olas agents pay Olas agents. Virtuals agents live on Base. Nevermined agents use card rails. No neutral settlement layer exists across them.
3. **Existing infrastructure is not a competitor — it's integration surface.** Nevermined, Crossmint, AgentKit, and Lit Protocol all ship production payment primitives. The product plugs into them, not replaces them.
4. **The wedge is cross-ecosystem micropayment settlement with programmable spending policies.** This is what nobody has.

---

## 1. What this is

A **permissionless protocol** for agent service micropayments. Not a company, not a marketplace with gatekeepers, not a framework. Anyone can list a service. Any agent can discover and pay for it. Settlement is optimized for sub-cent transactions.

The protocol has four layers:

| Layer | What it does | Where it runs |
|---|---|---|
| **Service Registry** | Agents list services with pricing, schema, endpoint | On-chain (minimal) + indexer |
| **Payment Channels** | Agents pay per-request without per-request gas | Off-chain (signed updates), on-chain settlement |
| **Spending Policies** | Agent owners define allowed spend rate, service types, counterparties | On-chain (policy contract), enforced at settlement |
| **SDK + Adapters** | Framework integrations that make this a 3-function integration | TypeScript, Python |

---

## 2. Core contracts

### 2.1 ServiceRegistry.sol

```
A permissionless registry where any address can list an agent service.
Gas-optimized for reads (discovery queries happen off-chain via indexer).
Writes are infrequent (register once, update rarely).
```

```solidity
struct Service {
    address provider;         // agent's payment address
    string  metadataURI;      // IPFS: service descriptor JSON
    uint256 pricePerRequest;  // in wei of settlement token (USDC = 6 decimals)
    uint32  maxResponseMs;    // max time provider commits to respond
    uint32  registeredAt;
    bool    active;
}

mapping(bytes32 => Service) public services;  // serviceId = keccak256(provider, metadataURI)
bytes32[] public serviceIndex;                 // enumerable for indexer
```

Functions: `register(metadataURI, pricePerRequest, maxResponseMs)`, `updateService(serviceId, ...)`, `deactivateService(serviceId)`.

**Design decision: no staking, no fees, no curation.** The protocol is neutral infrastructure. Quality signals come from transaction history (Phase 3 reputation). Bad services get discovered and avoided organically.

### 2.2 PaymentChannel.sol

```
A unidirectional payment channel between payer and payee.
Payer funds the channel on-chain once. Payee accumulates signed
payment proofs off-chain. Either party can close and settle on-chain.

Modeled on Lightning-style channels but for stablecoin micropayments.
A single on-chain open + close supports thousands of off-chain requests.
```

**State machine:**

```
         ┌───────────┐
         │   Opened   │  ← payer funds with deposit, sets policy contract
         └─────┬─────┘
               │
    ┌──────────┼──────────┐
    │ payee.   │ payer.   │
    │ close()  │ close()  │  ← submit final signed state + amount
    └─────┬────┘────┬─────┘
          │         │
    ┌─────▼──┐  ┌──▼──────┐
    │Settled │  │Refunded │  ← payer can close for refund after expiry
    └────────┘  └─────────┘
```

**Storage:**

```solidity
struct Channel {
    address payer;           // agent spending funds
    address payee;           // service provider receiving funds
    address token;           // settlement token (USDC, etc.)
    uint256 deposit;         // total funded amount
    uint256 spent;           // cumulative amount paid (increases monotonically)
    uint32  openedAt;
    uint32  expiresAt;       // payer can refund unspent after this
    address policy;          // optional: SpendingPolicy contract (0x0 = none)
    bytes   metadata;        // channel purpose / reference
    Status  status;
}

enum Status { Open, Settled, Refunded }
```

**Key functions:**

| Function | Caller | Description |
|---|---|---|
| `openChannel(payee, token, deposit, expiresAt, policy, metadata)` | payer | Funds channel. Transfers `deposit` of `token` from payer to contract. |
| `closeChannel(channelId, spent, signature)` | payee | Settles channel. `signature` is payer's EIP-712 sig on `(channelId, spent)`. Contract verifies sig, transfers `spent` to payee, remainder to payer. |
| `refundChannel(channelId)` | payer | After expiry, recovers unspent deposit. Only if payee hasn't closed. |
| `extendChannel(channelId, newExpiry, additionalDeposit)` | payer | Top up or extend. |

**Policy enforcement at close:**

```solidity
function closeChannel(uint256 channelId, uint256 spent, bytes calldata signature) external {
    Channel storage ch = channels[channelId];
    require(ch.status == Status.Open, "not open");
    require(msg.sender == ch.payee, "only payee");

    // Verify payer authorized this spent amount
    bytes32 hash = keccak256(abi.encode(channelId, spent));
    require(_verifyPayerSignature(ch.payer, hash, signature), "bad sig");

    // If policy contract is set, verify it allows the spend
    if (ch.policy != address(0)) {
        require(ISpendingPolicy(ch.policy).validateChannelClose(
            ch.payer, ch.payee, ch.deposit, spent, ch.metadata
        ), "policy rejected");
    }

    ch.spent = spent;
    ch.status = Status.Settled;

    // Pay the payee, return remainder to payer
    IERC20(ch.token).transfer(ch.payee, spent);
    if (ch.deposit > spent) {
        IERC20(ch.token).transfer(ch.payer, ch.deposit - spent);
    }
}
```

**Gas:** ~55k to open, ~70k to close. One open+close supports thousands of off-chain requests. Effective cost per request: fractions of a cent.

### 2.3 SpendingPolicy.sol (interface + reference implementation)

```
Users deploy their own policy contracts or use a shared reference implementation.
A policy enforces: what this channel can be used for, max spend rate, allowed services.
```

```solidity
interface ISpendingPolicy {
    function validateChannelOpen(
        address payer, address payee, uint256 deposit,
        uint256 expiresAt, bytes calldata metadata
    ) external view returns (bool);

    function validateChannelClose(
        address payer, address payee, uint256 deposit,
        uint256 spent, bytes calldata metadata
    ) external view returns (bool);
}
```

**Reference implementation — RateLimitedPolicy:**

```
Deployed once, used by many users with per-user config stored in the contract.

Config: {
    maxSpendPerDay: 100 USDC,
    allowedServiceTypes: ["data-oracle", "prediction-feed"],
    allowedProviders: [] or [0x..., 0x...],  // empty = any
    allowedTokens: [USDC],
    requireRegistered: true  // provider must be in ServiceRegistry
}
```

Policy checks on close:
- `spent <= maxSpendPerDay * (days since channel opened)`
- If `allowedServiceTypes` is non-empty, channel metadata must reference a registered service of matching type
- If `allowedProviders` is non-empty, payee must be in the list

This is intentionally simple. The policy interface is extensible — anyone can deploy a custom policy with arbitrary logic. The reference implementation covers 80% of use cases.

---

## 3. Off-chain payment protocol

This is where the actual micropayments happen. Gas-free, instant, signed.

### 3.1 Payment flow

```
Payer Agent                          Payee Agent (Service Provider)
     │                                        │
     │  1. openChannel(deposit=$5, expires=24h)│
     │────────────────────────────────────────>│  (on-chain tx, ~55k gas)
     │                                        │
     │  2. Request: "get ETH/USDC price"      │
     │────────────────────────────────────────>│  (HTTP POST, off-chain)
     │                                        │
     │  3. Response + PaymentProof            │
     │<────────────────────────────────────────│  (HTTP 200 + EIP-712 sig)
     │     PaymentProof: {                    │
     │       channelId, cumulativeSpent,      │
     │       requestHash, signature           │
     │     }                                  │
     │                                        │
     │  4. Request: "get ETH/WBTC price"      │
     │────────────────────────────────────────>│
     │                                        │
     │  5. Response + PaymentProof            │
     │<────────────────────────────────────────│  cumulativeSpent incremented
     │                                        │
     │  ... repeat N times ...                │
     │                                        │
     │  6. closeChannel(finalCumulativeSpent) │
     │<────────────────────────────────────────│  (on-chain tx, ~70k gas)
     │                                        │
     │  Payee receives finalSpent             │
     │  Payer receives deposit - finalSpent   │
```

### 3.2 Off-chain message: PaymentProof

Every service response includes a signed payment proof. This is the payer's commitment to the current cumulative spend. The payee holds this and submits the highest one at settlement.

```typescript
// EIP-712 typed message, signed by payer
{
  domain: {
    name: "AgentSettlement",
    version: "1",
    chainId: 8453,
    verifyingContract: "0x..."  // PaymentChannel contract address
  },
  types: {
    PaymentProof: [
      { name: "channelId", type: "uint256" },
      { name: "cumulativeSpent", type: "uint256" },  // total so far, always increases
      { name: "requestHash", type: "bytes32" },      // keccak256 of the request payload
      { name: "nonce", type: "uint256" }             // monotonic request counter
    ]
  },
  value: {
    channelId: 1,
    cumulativeSpent: "2500000",     // 2.5 USDC so far (6 decimals)
    requestHash: "0xabc123...",
    nonce: 42
  }
}
```

The payer signs this **before** sending each request. The payee verifies the signature, processes the request if valid, and holds the proof. The payee only settles on-chain when:
- Channel expiry approaches
- Deposit is nearly exhausted
- The payee wants to realize revenue

### 3.3 Request/response wire format (HTTP + optional x402)

Agent services are just HTTP endpoints. The payer sends a standard POST with JSON body. The payee responds with JSON body + `X-Payment-Proof` header containing the signed PaymentProof.

```http
POST /services/prediction-feed HTTP/1.1
Host: agent-payee.example
Content-Type: application/json
X-Channel-Id: 1
X-Payment-Proof: <base64-encoded EIP-712 signature>
X-Cumulative-Spent: 2500000
X-Request-Nonce: 42

{
  "market": "ETH/USDC-2026-07-16",
  "metric": "implied_volatility"
}
```

Response:
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-Hash: 0xabc123...

{
  "impliedVolatility": 0.0427,
  "timestamp": 1721000000,
  "confidence": 0.95
}
```

**x402 compatibility:** The protocol supports HTTP 402 Payment Required for service discovery and initial channel setup. A payer hitting a service endpoint without an active channel receives:

```http
HTTP/1.1 402 Payment Required
X-Service-Id: 0xdef456...
X-Price-Per-Request: 50000        # 0.05 USDC
X-Accepted-Tokens: 0x833589fCD...
X-Channel-Expiry-Min: 3600        # minimum 1hr channel
X-Suggested-Deposit: 5000000      # payee suggests $5 deposit
```

This aligns with Nevermined's x402 facilitator — the protocol is compatible, not competing.

---

## 4. Service descriptor schema

Each service registered in ServiceRegistry points to an IPFS JSON document:

```json
{
  "protocol": "agent-settlement/v1",
  "service": {
    "id": "prediction-feed-v1",
    "name": "ETH Prediction Market Feed",
    "description": "Real-time implied volatility and order book depth from Polymarket + Omen",
    "version": "1.2.0"
  },
  "provider": {
    "framework": "olas-mech",
    "contact": "discord://...",
    "attestation": null
  },
  "api": {
    "endpoint": "https://olaspredict.example/services/prediction-feed",
    "method": "POST",
    "inputSchema": {
      "type": "object",
      "properties": {
        "market": { "type": "string", "description": "Market identifier" },
        "metric": { "enum": ["implied_volatility", "orderbook_depth", "spread"] }
      },
      "required": ["market", "metric"]
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "impliedVolatility": { "type": "number" },
        "orderbookDepth": { "type": "object" },
        "spread": { "type": "number" },
        "timestamp": { "type": "number" },
        "confidence": { "type": "number" }
      }
    }
  },
  "pricing": {
    "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "pricePerRequest": "50000",
    "minChannelDeposit": "5000000",
    "minChannelDuration": 3600
  },
  "sla": {
    "maxResponseMs": 2000,
    "uptime": "0.999",
    "rateLimit": "100/min"
  }
}
```

---

## 5. SDK — the integration surface

### 5.1 Core SDK (TypeScript)

```typescript
import { AgentPay } from '@valuepacket/sdk';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';

const wallet = createWalletClient({
  account: process.env.AGENT_KEY as `0x${string}`,
  chain: base,
  transport: http()
});

const pay = new AgentPay({ wallet });

// ── Register a service (once) ──
await pay.registerService({
  metadataURI: 'ipfs://Qm.../prediction-feed.json',
  pricePerRequest: parseUnits('0.05', 6),
  maxResponseMs: 2000
});

// ── Discover services ──
const feeds = await pay.discover({ serviceType: 'prediction-feed' });
// → [{ provider, endpoint, pricePerRequest, metadata, ... }, ...]

// ── Open a channel and start consuming ──
const channel = await pay.openChannel({
  provider: feeds[0].provider,
  deposit: parseUnits('5', 6),     // $5 USDC
  expiresIn: 86400,                  // 24 hours
  policy: '0x...'                    // optional: SpendingPolicy contract
});

// ── Make requests (the SDK handles payment proofs automatically) ──
for (let i = 0; i < 50; i++) {
  const result = await channel.request({
    market: 'ETH/USDC-2026-07-16',
    metric: 'implied_volatility'
  });
  // result = { impliedVolatility: 0.0427, ... }
  // SDK handled: sign PaymentProof, attach header, verify incremental spend
}

// ── Close when done (or channel auto-closes on expiry) ──
await channel.close();
// Payee receives 50 × $0.05 = $2.50
// Payer receives $2.50 refund

// ── Being a service provider ──
const server = pay.serve({
  serviceId: '0x...',
  handler: async (request) => {
    const { market, metric } = request.body;
    const data = await myModel.predict(market, metric);
    return { body: data };
  }
});
// Server automatically: verifies payment proofs per request,
// rejects if cumulativeSpent hasn't incremented properly,
// settles channel on-chain when deposit runs low
```

### 5.2 Framework adapters

**ElizaOS adapter** (same pattern as v1, adapted for micropayments):

```typescript
export const agentPayPlugin: Plugin = {
  name: 'agent-settlement',
  actions: [
    {
      name: 'SUBSCRIBE_TO_FEED',
      handler: async (runtime, params) => {
        const { serviceType, filter, maxDailySpend } = params;
        // Opens a channel, subscribes to periodic data
        return runtime.agentPay.subscribe({ serviceType, filter, maxDailySpend });
      }
    },
    {
      name: 'LIST_SERVICE',
      handler: async (runtime, params) => {
        // Register what this agent can do for others
        return runtime.agentPay.registerService(params.serviceDescriptor);
      }
    }
  ]
};
```

G.A.M.E, Rig, LangChain adapters are structurally identical — the SDK abstracts the payment channel logic.

### 5.3 Integration with existing infrastructure

The SDK is designed to plug into existing wallet/payment infrastructure, not replace it:

```typescript
// Use Coinbase AgentKit wallet
import { AgentKit } from '@coinbase/agentkit';
const agentkit = AgentKit.from(config);
const wallet = agentkit.getWalletClient();
const pay = new AgentPay({ wallet });

// Use Crossmint agent wallet
import { CrossmintWallet } from '@crossmint/agent-wallet';
const crossmintWallet = new CrossmintWallet({ apiKey });
const pay = new AgentPay({ wallet: crossmintWallet });

// Use any EIP-1193 provider (Lit, Privy, Safe, etc.)
const pay = new AgentPay({ wallet: window.ethereum });
```

The payment channel contract is token-agnostic — USDC, xDAI, any ERC-20.

---

## 6. Indexer

Built with Ponder or Envio. Indexes `ServiceRegistered`, `ServiceUpdated`, `ChannelOpened`, `ChannelClosed` events.

Exposes:
- **GraphQL API** — query services by type, provider, chain, price range
- **WebSocket** — subscribe to new service registrations, channel events
- **REST** — simple search endpoint for agent discovery

Includes a lightweight cache of service metadata (fetched from IPFS, cached locally with TTL).

---

## 7. What the MVP does NOT include

| Excluded | Why | When |
|---|---|---|
| Reputation scoring | Requires transaction volume to be meaningful | Phase 3 |
| Provider staking/slashing | Adds onboarding friction; organic discovery first | Phase 3 |
| Dispute resolution | Payment channels have self-enforcing economics (payee only paid for work delivered) | Phase 2 |
| TEE attestation verification | SDK supports attestation metadata field; verification logic is Phase 4 | Phase 4 |
| Cross-chain channels | Single-chain (Base) MVP; cross-chain via existing bridges later | Phase 2 |
| ZK anything | No evidence of demand for ZK at micropayment scale | Phase 4 |
| Fees/take rate | Protocol is free; monetization via hosted indexer/SaaS later | Post-PMF |
| Card/fiat rails | Integrate with Nevermined/Crossmint for that; don't rebuild | Post-PMF |

---

## 8. The 10-minute demo (updated)

```bash
# Terminal 1 — Service provider agent (ElizaOS, provides prediction feed)
npx @valuepacket/cli serve \
  --service prediction-feed \
  --price 0.05 \
  --framework eliza

# Terminal 2 — Consumer agent (G.A.M.E, consumes prediction feed)
npx @valuepacket/cli consume \
  --service-type prediction-feed \
  --deposit 5 \
  --framework game

# Output:
#   [provider] Registered service 0xabc... (prediction-feed, $0.05/req)
#   [consumer] Found 1 service matching "prediction-feed"
#   [consumer] Opened channel #1: $5.00 USDC deposit, 24hr expiry
#   [consumer] Request #1 → { impliedVolatility: 0.0427 } (paid $0.05, balance $4.95)
#   [consumer] Request #2 → { impliedVolatility: 0.0431 } (paid $0.10, balance $4.90)
#   ...
#   [consumer] Request #50 → { impliedVolatility: 0.0419 } (paid $2.50, balance $2.50)
#   [consumer] Closing channel. Provider received $2.50, refunded $2.50.
#   ✓ Done in 87 seconds. Total on-chain txs: 2 (open + close).
#   ✓ 50 requests processed off-chain. Avg req latency: 84ms.
```

---

## 9. Build order (4 weeks, 2 engineers)

| Week | Deliverable |
|---|---|
| 1 | `ServiceRegistry.sol` + `PaymentChannel.sol` + `SpendingPolicy.sol` (reference impl). Full Foundry test suite. Deploy to Base Sepolia. |
| 2 | TypeScript SDK: `openChannel`, `request` (with auto PaymentProof signing), `closeChannel`, `serve` (service provider). E2E tests on testnet. |
| 3 | Ponder indexer for service discovery. WebSocket relay for channel events. CLI dev tool (`npx @valuepacket/cli`). |
| 4 | ElizaOS adapter + G.A.M.E adapter. AgentKit wallet integration. Integration demo passing. Documentation. Blog post: "Any agent can pay any agent." |

---

## 10. Success metrics

| Metric | Target | Why |
|---|---|---|
| Integration time (new framework) | < 10 min | Lower is a moat |
| On-chain cost per 1,000 requests | < $0.10 | Open + close = $0.02 total for 1,000 reqs |
| Request latency (payment overhead) | < 5ms | EIP-712 signing only, no chain interaction |
| Agent registrations (testnet, week 1) | > 20 services | Prove anyone can list |
| Cross-framework transaction pairs | ≥ 3 (eliza↔game, eliza↔agentkit, game↔custom) | Prove framework agnostic |
| Channels opened (testnet, month 1) | > 100 | Prove usage, not just registration |

---

## 11. Competitive positioning

| | Olas Mech | Nevermined | Crossmint | AgentKit | **This** |
|---|---|---|---|---|---|
| A2A marketplace | ✓ (Olas-only) | — | — | — | ✓ (framework-agnostic) |
| Stablecoin micropayments | ✓ (xDAI) | — | ✓ (via wallets) | ✓ (transfers) | ✓ (channels) |
| Card/fiat rails | — | ✓ | ✓ | — | Integrates, doesn't build |
| Spending policies | — | ✓ (per-agent caps) | ✓ (card controls) | — | ✓ (on-chain, programmable) |
| Open/permissionless | Requires OLAS stake | Enterprise SaaS | API key required | CDP key required | ✓ (no key, no stake) |
| Sub-cent transaction support | ✓ (on Gnosis) | — | — | — | ✓ (payment channels) |
| Existing volume | 13.6M txns | 1.2M req/day | Unknown | Unknown | 0 (pre-launch) |

The gap is clear: no one offers **permissionless, framework-agnostic, crypto-native A2A micropayment settlement with user-defined spending policies.** Olas comes closest but is locked to Olas staking and the Olas agent stack.

---

## 12. Distribution strategy

**Do not lead with "Agent Interoperability Protocol."** Lead with a specific integration that provides immediate value.

**Beachhead:** Build the ElizaOS adapter first. ElizaOS has 18.7k GitHub stars and ships with a non-custodial wallet. Their agents can already do DeFi actions via AgentKit. They cannot pay other agents for services. Give them that capability in one plugin.

**Second integration:** AgentKit. Coinbase's agent wallet infrastructure has 679 dependents. AgentKit agents can swap, stake, and LP — but can't pay other agents. Plug them into the service marketplace.

**Third integration:** Olas Mech Marketplace providers. Olas agents already sell services. Give them access to buyers outside the Olas ecosystem.

**The demo that sells it:** "An ElizaOS agent on Base pays an Olas Mech agent on Gnosis for prediction market data — using a single USDC payment channel. Integration time: one plugin install."
