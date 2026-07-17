# r/ethereum post

**Title:** I built an EIP-712 payment channel protocol for AI agents — deployed on Base Sepolia, 229 tests, would love a review

---

**What:** ValuePacket is a unidirectional payment channel protocol that lets AI agents pay each other for services using stablecoins. Two on-chain transactions cover thousands of off-chain requests. MIT licensed, verified on Base Sepolia.

https://github.com/KryptosAI/ValuePacket

---

I started this because agent-to-agent payments are clearly coming — Olas alone has processed 13.6M A2A transactions with 651 daily active agents — but every framework has its own siloed execution environment. There's no shared economic layer. Payment channels seemed like the right primitive: agents make high-frequency, low-value requests to each other, on-chain per-request settlement would be absurdly expensive, and the bilateral channel model maps well to agent-service relationships.

**EIP-712 architecture**

Each paid request carries two signatures in HTTP headers:

1. A `PaymentProof` — typed structured data over `(channelId, cumulativeSpent, requestHash, nonce)`. The provider verifies this against on-chain channel state before processing the request.

2. A `ChannelClose` signature — authorizing settlement at `cumulativeSpent`. This lets the provider close the channel unilaterally if the payer goes offline.

The trick is that `cumulativeSpent` is monotonically increasing. Each new request increments it by `pricePerRequest`. The provider can trust that a proof at `cumulativeSpent = 5000` covers all previous requests — no need to verify individual micropayments. One signature, one HTTP header, one arithmetic check.

**Design decisions I'd like feedback on**

**ecrecover → OpenZeppelin ECDSA.** The PaymentChannel contract uses `ECDSA.recover` from OpenZeppelin. I initially used raw `ecrecover` but switched because the OZ wrapper handles signature malleability (enforces low-s) and returns `address(0)` on failure rather than the zero address. The SubscriptionManager extension still uses raw `ecrecover` with manual v/r/s extraction — I need to standardize this. For anyone building similar contracts: just use OZ ECDSA. The gas difference is negligible and you avoid the `ecrecover` footguns (malleability, zero-address-on-failure, v ∈ {27,28} normalization).

**Channel model vs state channels (Lightning).** This is unidirectional, not bidirectional. The payer opens a channel and streams payments to the payee — money only flows one way. Lightning/Raiden use bidirectional channels with hash timelock contracts and routed payments. That felt like overkill. Agent-to-agent payments are inherently directed: one agent is buying a service from another. A unidirectional channel with EIP-712 signed state updates is simpler to implement, reason about, and verify formally (we have Counterflow Z3 proofs for pool-level non-negative balance).

**Why Base Sepolia.** The contracts need almost no modifications to support any EVM chain, but L2 gas costs make the channel open/close overhead trivial. Opening a channel costs ~55k gas, closing costs ~70k. At current L2 prices that's fractions of a cent.

The full audit trail: 177 Solidity tests covering channel lifecycle (open/close/refund/extend), edge cases around expiry, signature validation, spending policy enforcement, and reentrancy guards. Contracts are Counterflow-verified (3/3 PROVED — non-negative contract balance across PaymentChannel, CrossChainSettlement, and SubscriptionManager).

Would appreciate any review of the signing model, the contract architecture, or things I should be worried about that aren't obvious yet.

---

# r/ethdev post

**Title:** I made it so your agent can pay other agents in 5 lines of code — payment channels for agent-to-agent micropayments

---

**What:** ValuePacket is an open source (MIT) payment channel SDK for AI agents. `npm install @valuepacket/sdk` and your agent can open a stablecoin channel, pay for services off-chain with EIP-712 proofs, and settle on-chain. ~7ms latency per request, ~$0.001 gas amortized.

https://github.com/KryptosAI/ValuePacket

---

I built this because I wanted my ElizaOS agent to pay for a price feed without wiring up Stripe or pre-funding a wallet per-request. Payment channels solve this cleanly: deposit once, make thousands of requests, settle later.

**Using it**

```bash
npm install @valuepacket/sdk
```

5 lines to add payment capability to any agent:

```typescript
import { AgentPay } from '@valuepacket/sdk';

const pay = new AgentPay({ wallet, publicClient, paymentChannelAddress });
const session = await pay.openChannel({ counterparty: providerAddress, token: USDC, deposit: 5_000000n, expiresIn: 3600 });
session.setEndpoint('https://some-provider.example.com');
const result = await session.request({ query: 'ETH price forecast' });
```

That's it. `session.request()` automatically signs an EIP-712 PaymentProof, attaches it as HTTP headers, and parses the response. The provider SDK side is similarly straightforward — `ChannelServer` handles proof verification and route registration.

**Deploying your own service**

The contracts are verified on Base Sepolia. To spin up your own paid service:

```bash
# 1. Deploy contracts (or use existing ones on Base Sepolia)
cd contracts && forge script script/DeploySepolia.s.sol --rpc-url base_sepolia --broadcast

# 2. Register your service
npx valuepacket register --type price-feed --price 1000 --endpoint https://my-service.com

# 3. Start serving paid requests
npx valuepacket serve --port 8080
```

Anyone can now open a channel with your service address and send paid requests.

**Live demo**

There's a real price feed service running — queries CoinGecko, charges $0.001/request, settled through ValuePacket channels:

```bash
npx valuepacket demo --rpc https://sepolia.base.org
```

Or run entirely locally (no RPC, no faucet):

```bash
make demo-local
```

This starts Anvil, deploys contracts, mints test USDC, opens a channel, and runs 10 paid requests at ~7ms average latency. Takes about 15 seconds.

**What's worth knowing**

- 229 tests (177 Solidity + 52 TypeScript), 6/6 happy-path acceptance criteria passing
- Contracts verified on Base Sepolia, Counterflow-proved for non-negative balance
- Framework adapters exist for ElizaOS and G.A.M.E (50 lines each)
- The SDK handles channel state export/import, so you can persist sessions across restarts

The thing I'd most want feedback on: the SDK ergonomics. `session.request()` feels natural when you're making individual calls, but if you're batching 100 requests, you're signing each one separately. I considered a "bulk proof" model where one EIP-712 signature covers a range of nonces, but that complicates verification. What pattern would you prefer?
