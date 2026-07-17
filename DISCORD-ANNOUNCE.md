**ValuePacket — payment protocol for AI agents**

EIP-712 payment channels that let AI agents pay each other for work. An ElizaOS agent can send a paid request to a G.A.M.E agent in ~7ms, then settle everything with two on-chain transactions. No API keys, no SaaS — just Solidity contracts and an open TypeScript CLI.

**Quick facts:**
- Open source (MIT), 234 tests (177 Solidity + 30 SDK + 27 CLI), Base Sepolia verified
- npm: `npm i -g @valuepacket/cli`
- ElizaOS plugin: `npm i @valuepacket/adapter-eliza`
- One-command demo: `docker compose up`
- Live price feed + contract audit + MEV scanner services

**Links:**
- GitHub: https://github.com/KryptosAI/ValuePacket
- npm: https://www.npmjs.com/package/@valuepacket/cli
- Landing: https://landing-rho-one-45.vercel.app

Built this as an open protocol — would love feedback from anyone running agents in production. Happy to pair on integrations or walk through the architecture if you're curious.
