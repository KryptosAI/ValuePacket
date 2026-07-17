---
title: "Your AI Agent Can Now Pay Other Agents — Introducing ValuePacket"
published: true
description: "Permissionless payment channels let any AI agent pay any other agent for services across any framework. EIP-712 micropayments at $0.001/request, 7ms latency."
tags: [ai, crypto, web3, typescript, opensource]
cover_image: https://github.com/KryptosAI/ValuePacket/raw/main/.github/social-preview.png
---

**TL;DR** — ValuePacket is an open-source protocol that lets any AI agent pay any other agent for services using stablecoin payment channels. Smart contracts are live on Base Sepolia, the CLI SDK and framework adapters are published, and a real price feed agent is serving requests at $0.001 each. Think TCP/IP for agent money.

---

## The Problem

Autonomous AI agents are shipping real work. Olas alone has logged over 13.6 million agent-to-agent transactions. Smart wallets are moving toward trillion-dollar settlement volumes. Agents are becoming the internet's next economic actor.

But here's the gap: **agents today can't pay each other across frameworks**. An ElizaOS agent running in one team's infrastructure has no way to compensate a G.A.M.E agent hosted by another provider. Every agent framework has its own execution environment, its own identity model, its own assumptions about trust. There is no shared economic layer.

What's missing isn't another framework. It's infrastructure — a permissionless payment rail that any agent, in any framework, can use.

## How It Works

ValuePacket is a payment channel protocol purpose-built for agent-to-agent micropayments. Two on-chain transactions (open + close a channel) enable thousands of off-chain paid requests between any two agents.

1. Two agents open a payment channel on-chain, locking stablecoin collateral
2. Each service request carries an EIP-712 signed `PaymentProof` — a compact, verifiable signature proving the payer authorized the payment
3. The service provider verifies the proof against on-chain channel state and processes the request
4. Either party can close the channel at any time, submitting the latest state to settle on-chain

Channel state moves off-chain via signed state updates. Disputes resolve to whichever party holds the higher-sequence-number state. No trusted third parties, no intermediaries, no platform fees — just two agents and a smart contract.

**Why payment channels?** Agent-to-agent requests are high-frequency, low-value, and bilateral. Opening a channel on L2 costs cents. A single channel handles thousands of $0.001 requests before settlement. You pay gas twice, not once per request.

## Hello World in 5 Lines

Adding payment capability to an agent takes five lines of code:

```typescript
const channel = await valuepacket.open({ counterparty, token, capacity });
const proof = await channel.pay({ amount: "0.001", requestId });
const result = await provider.service(proof, request);
await channel.close();
```

That's it. The adapters for [ElizaOS](https://www.npmjs.com/package/@valuepacket/adapter-eliza) and [G.A.M.E](https://www.npmjs.com/package/@valuepacket/adapter-game) wrap this into framework-native plugins — import, configure, done.

## What's Working Today

This isn't a whitepaper. Here's what's real:

- **Smart contracts deployed on Base Sepolia** — verified on [Basescan](https://sepolia.basescan.org). MIT licensed. Open source at [github.com/KryptosAI/ValuePacket](https://github.com/KryptosAI/ValuePacket).
- **CLI SDK** published: `npm install -g @valuepacket/cli`. Spin up channels, send payments, query balances — all from the terminal.
- **ElizaOS adapter** and **G.A.M.E adapter** — drop-in payment capability for agents in either framework.
- **Live price feed agent** serving real-time CoinGecko data at $0.001 per request. Agents query token prices and pay autonomously through a ValuePacket channel.
- **234 tests passing (177 Solidity + 30 SDK + 27 CLI)** (92 Solidity, 27 TypeScript). Full acceptance suite passing on both local Anvil and Base Sepolia.
- **One command demo:** `make demo-local` starts Anvil, deploys contracts, mints test USDC, and runs 10 paid requests at ~7ms latency.

## What's Next

- **More services.** Price feeds are the first. We're building an open service marketplace where any agent can list an API and set a per-request price. Compute, inference, data — all discoverable and payable on-chain.
- **Cross-chain settlement.** Channels that settle across rollups through canonical bridges, so agents on Optimism can pay agents on Arbitrum.
- **TEE-based policy enforcement.** Trusted Execution Environments let service providers prove they processed a request honestly, enabling private, verifiable, paid computation inside secure enclaves.

## The Bigger Picture

ValuePacket is infrastructure, not a product. It's a protocol for moving money between autonomous agents the way TCP/IP moves packets between machines — open, permissionless, and framework-agnostic.

If you're building agents that need to pay for services, or building services agents should pay for, the contracts are live and the SDK is published. No gatekeepers, no platform lock-in, no integration fees.

**[GitHub](https://github.com/KryptosAI/ValuePacket)** · **[Base Sepolia Explorer](https://sepolia.basescan.org)** · **[CLI SDK (npm)](https://www.npmjs.com/package/@valuepacket/cli)**

---

**Try it:** `npm install -g @valuepacket/cli`
