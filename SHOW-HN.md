# Show HN: ValuePacket — open source payment channels for AI agents

https://github.com/KryptosAI/ValuePacket

I've been working with agent frameworks for a while and kept hitting the same wall: an agent in ElizaOS has no way to pay an agent in G.A.M.E for a service. Every framework lives in its own silo. When agents need to buy data, compute, or inference from each other, the answer today is "hardcode a free API key or build a bespoke integration."

ValuePacket is a permissionless payment channel protocol that any agent can use regardless of framework. Open a channel with stablecoins on L2 (two on-chain transactions), then sign paid requests off-chain with EIP-712 — a single channel handles thousands of $0.001 requests before settlement.

Concrete example: an ElizaOS agent deposits $5 USDC into a channel with a G.A.M.E agent running a price feed service. Every POST /price request carries an EIP-712 PaymentProof in the headers. The price feed verifies the proof against on-chain state in ~7ms and returns the current ETH price. After 1,000 requests, either side submits the latest channel state — the payee receives $1, the payer gets the remaining $4 back. Total on-chain footprint: two transactions.

Open source (MIT), 234 tests (177 Solidity + 30 SDK + 27 CLI) (177 Solidity + 57 TypeScript), contracts verified on Base Sepolia. You can run the whole thing without installing anything:

```
docker compose up
```

Or install the CLI:

```
npm install -g @valuepacket/cli
```

5-line integration for any agent:

```typescript
import { AgentPay } from '@valuepacket/sdk';

const pay = new AgentPay({ wallet, publicClient, paymentChannelAddress });
const session = await pay.openChannel({ counterparty, token: USDC, deposit: 5_000000n, expiresIn: 3600 });
session.setEndpoint('https://price-feed-agent.example.com');
const data = await session.request({ prompt: 'What is ETH/USDC?' });
```

There's a live price feed service running on this already. Agents can query real-time CoinGecko data and pay $0.001 per request through a ValuePacket channel. The service is also open source — clone it and deploy your own paid API behind a channel in minutes.

This is a side project. I'm not trying to launch a company here — just building infrastructure I wish existed. I'd love honest feedback on a few things:

1. **Architecture** — each request includes both a PaymentProof and a ChannelClose signature so the provider can settle unilaterally without waiting for the payer. This adds ~130 bytes per request but removes trust. Is that the right tradeoff, or is there a simpler model I'm missing?

2. **EIP-712 signing model** — using typed structured data for both proofs and close authorization. Felt cleaner than raw ECDSA over packed ABI, but curious if there's a better primitive for this use case.

3. **Subscription extension** — we built a SubscriptionManager that auto-rolls payment channels period-by-period for recurring services (daily data feeds, weekly compute). Feels like it might be over-engineered. Is there a simpler approach?

Keen to hear what breaks, what doesn't make sense, and what you'd do differently.
