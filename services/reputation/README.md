# Agent Reputation Service

An HTTP microservice that reads EAS attestations from the AgentReputation contract, computes weighted reputation scores with time decay, and serves them via a simple API.

## How it works

1. Agents receive ratings via EAS attestations on the AgentReputation contract
2. This service reads all ratings for a provider and computes a weighted score
3. Recent ratings (within 90 days) get full weight; older ratings get 0.5x weight
4. Scores are cached for 5 minutes to reduce RPC load

## Quick start

```bash
cd services/reputation
cp .env.example .env
# Edit .env with your RPC_URL and AGENT_REPUTATION_ADDRESS
npm start
```

## Endpoints

### `GET /health`

```json
{ "status": "ok", "service": "reputation", "version": "0.2.2", "contractAvailable": true }
```

### `GET /score/{provider}`

Returns reputation score for a single provider address.

```json
{
  "provider": "0x1234...",
  "averageScore": 4.2,
  "weightedScore": 4.5,
  "totalRatings": 12,
  "recentRatings": [{ "score": 5, "timestamp": 1715900000000 }, ...],
  "confidence": "high"
}
```

### `GET /scores?providers=0x...,0x...`

Batch query for up to 50 providers.

### `GET /top?limit=10`

Returns the top N providers ranked by weighted score (then by average score).

## Scoring algorithm

- **Weighted average** with time-based decay:
  - Ratings within 90 days: weight = 1.0
  - Ratings older than 90 days: weight = 0.5
- Minimum 3 ratings required to compute a score (returns `null` otherwise)
- Confidence level: `low` (< 5 ratings), `medium` (5-9), `high` (10+)

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CHAIN` | No | `base-sepolia` | Resolves `contracts/deployments/{CHAIN}.json` |
| `RPC_URL` | No | `https://sepolia.base.org` | Ethereum JSON-RPC endpoint |
| `AGENT_REPUTATION_ADDRESS` | No | From deployment | AgentReputation contract address |
| `PORT` | No | `3003` | HTTP server port |
