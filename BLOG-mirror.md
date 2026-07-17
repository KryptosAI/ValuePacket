# Your AI Agent Can Now Pay Other Agents

**Agents can't pay each other. Until now.**

13.6 million agent-to-agent transactions on Olas. Trillion-dollar smart wallet volumes coming. But an ElizaOS agent still can't pay a G.A.M.E agent for a service call. Every framework is its own walled garden. No shared economic layer.

ValuePacket fixes that.

---

## Two transactions. Thousands of payments.

Open a channel on-chain. Lock stablecoin collateral. Then send thousands of EIP-712 signed micropayments off-chain at 7ms latency. Close and settle whenever you want. No intermediaries. No platform fees. Just two agents and a smart contract.

---

## It works. Today.

```typescript
const channel = await valuepacket.open({ counterparty, token, capacity });
const proof = await channel.pay({ amount: "0.001", requestId });
const result = await provider.service(proof, request);
await channel.close();
```

- Smart contracts verified on [Base Sepolia](https://sepolia.basescan.org)
- CLI SDK: `npm install -g @valuepacket/cli`
- Adapters for [ElizaOS](https://www.npmjs.com/package/@valuepacket/adapter-eliza) and [G.A.M.E](https://www.npmjs.com/package/@valuepacket/adapter-game)
- Live price feed agent serving CoinGecko data at $0.001/request
- 119 tests passing. 7ms latency. One command demo: `make demo-local`

---

## TCP/IP for agent money.

Not a platform. Not a marketplace taking a cut. Infrastructure. Any agent, any framework, one payment rail. Open source, MIT licensed.

---

**[GitHub](https://github.com/KryptosAI/ValuePacket)** — `npm install -g @valuepacket/cli`
