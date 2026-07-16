# Contributing to ValuePacket

ValuePacket is a monorepo with Solidity contracts, TypeScript packages, and framework adapters.

## Repository structure

```
ValuePacket/
├── contracts/          # Solidity smart contracts (Foundry)
│   ├── src/            # ServiceRegistry, PaymentChannel, SpendingPolicy
│   └── script/         # Deploy scripts (local + Base Sepolia)
├── sdk/                # @valuepacket/sdk — TypeScript SDK (tsup + vitest)
├── cli/                # @valuepacket/cli — CLI tool
├── adapters/
│   ├── eliza/          # @valuepacket/adapter-eliza — ElizaOS plugin
│   └── game/           # @valuepacket/adapter-game — G.A.M.E worker
├── indexer/            # Ponder indexer for on-chain events
└── scripts/            # Demo and utility scripts
```

## Getting started

```bash
git clone https://github.com/KryptosAI/ValuePacket.git
cd ValuePacket
npm install
make demo-local
```

## Running tests

```bash
# Solidity contracts
cd contracts && forge test

# CLI
cd cli && npm test

# SDK
cd sdk && npm test

# Everything (build + test all workspaces)
npm test
```

## Adding a new framework adapter

1. Create `adapters/<name>/` with a `package.json` and `src/index.ts`
2. The package name should follow `@valuepacket/adapter-<name>`
3. Add the workspace to the root `package.json` workspaces array
4. Implement your adapter using `@valuepacket/sdk` types and client
5. Add a build script: `tsup src/index.ts --format esm,cjs --dts --clean`
6. Include `"files": ["dist", "src"]` in package.json
7. If the framework has a peer dependency, add it to `peerDependencies`

Minimal adapter template:

```typescript
// src/index.ts
import { AgentPay, type ServiceConfig } from "@valuepacket/sdk";

export class MyAdapter {
  private client: AgentPay;

  constructor(rpc: string, signer: `0x${string}`) {
    this.client = new AgentPay({ rpc, signer });
  }

  async registerService(config: ServiceConfig) {
    return this.client.registerService(config);
  }

  async sendPayment(channelId: bigint, amount: bigint) {
    return this.client.sendPayment(channelId, amount);
  }
}
```

## Deploying a new service

1. Register a service on-chain using the CLI or SDK
2. Deploy a server that accepts ValuePacket payment proofs
3. Use `ChannelServer` from `@valuepacket/sdk` to verify incoming payments

Example using the CLI:

```bash
# Register a service
valuepacket register --name "my-price-feed" --price 100 --type "price-feed" \
  --endpoint "https://my-service.com/api"

# Serve it
valuepacket serve --port 8080
```

## Publishing packages

Packages are published to npm under the `@valuepacket` scope:

```bash
# Build all packages
npm run build

# Dry run to verify
npm publish --dry-run -w sdk
npm publish --dry-run -w cli
npm publish --dry-run -w adapters/eliza
npm publish --dry-run -w adapters/game

# Actually publish (requires npm login + @valuepacket org)
npm publish -w sdk
npm publish -w cli
npm publish -w adapters/eliza
npm publish -w adapters/game
```

## License

MIT — see [LICENSE](LICENSE).
