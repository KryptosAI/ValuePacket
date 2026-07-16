# ValuePacket Launch Plan

Three barriers to organic adoption and how to break them.

---

## Barrier 1: Nobody can try it

**Problem:** Contracts exist only in local Anvil. Adoption requires cloning the repo.

**Fix:** Deploy to Base Sepolia testnet. Make it reachable without git.

**Steps:**
1. Get Base Sepolia ETH from faucet (alchemy.com/faucets/base-sepolia)
2. Deploy contracts (same Solidity, different RPC)
3. Write deployment addresses to `deployments/base-sepolia.json`
4. Start a live provider server (free hosting: Render, Railway, Fly.io)
5. Add `make demo-sepolia` target
6. Add deployed addresses to README

**Success metric:** Anyone with a wallet and testnet USDC can run `npx valuepacket demo` without cloning.

---

## Barrier 2: Nothing to buy

**Problem:** The demo returns mock data. Zero real services exist on the network.

**Fix:** Deploy one real, useful service that charges real micropayments.

**Candidate: Live Price Feed Agent**
- Serves ETH/USDC price from CoinGecko free API
- Charges $0.001 per request via ValuePacket payment channel
- Anyone can subscribe their agent to live price data
- Hosted on a free tier service (Railway/Render)
- Open source so others can clone and deploy their own services

**Minimal implementation:**
```
POST /price/eth-usdc
X-Channel-Id: 1
X-Cumulative-Spent: 1000
X-Payment-Proof: 0x...

→ { price: 1847.32, timestamp: 1721000000, source: "coingecko" }
```

**Success metric:** Any agent, regardless of framework, can pay for live data within 5 minutes of integration.

---

## Barrier 3: Nobody knows it exists

**Problem:** Zero distribution. Framework users don't know ValuePacket exists.

**Fix:** Get listed where agent developers already are.

**Steps:**
1. Publish `@valuepacket/adapter-eliza` to npm
2. Submit to ElizaOS plugin registry (plugins.elizacloud.ai)
3. Publish `@valuepacket/sdk` to npm
4. Write one blog post: "Your ElizaOS agent can now pay other agents"
5. Post on X, Farcaster, Discord
6. DM 5 agent framework maintainers directly

**Success metric:** One person who isn't us installs the adapter and runs it against the live price feed.

---

## Execution order

| Day | What | Dependency |
|---|---|---|
| Today | Deploy contracts to Base Sepolia | None |
| Today | Deploy Price Feed Agent | Contracts deployed |
| Today | Publish npm packages | SDK builds |
| Tomorrow | Submit to ElizaOS plugin catalog | Adapter published |
| Tomorrow | Blog post + social | Live demo working |

## Required resources

- Base Sepolia ETH (free from faucet)
- Base Sepolia USDC (free from faucet)
- Free hosting account (Railway, Render, or Fly.io)
- npm account for publishing packages
- ElizaOS plugin catalog submission (free)
