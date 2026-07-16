# Fixtures

Demo fixtures used for local testing and development.

## Usage

These JSON service descriptors represent valuepacket protocol services. They can be
uploaded to IPFS for discovery or loaded directly from disk in demo mode.

### Load a fixture directly

```ts
import { readFileSync } from 'fs';
const descriptor = JSON.parse(readFileSync('cli/fixtures/prediction-feed-service.json', 'utf-8'));
```

### Descriptor fields

- **protocol** — Protocol version identifier.
- **service** — Name, ID, and version of the service.
- **provider** — Implementation framework and contact info.
- **api** — HTTP endpoint, method, and JSON schemas for input/output.
- **pricing** — On-chain payment config (token address, per-request price, channel deposit).
- **sla** — Latency, uptime, and rate-limit guarantees.

### Adding new fixtures

1. Create a new `*.json` file in this directory following the same schema.
2. Update this README with a short description of the new fixture.
