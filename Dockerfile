# Stage 1: Foundry — compile contracts
FROM ghcr.io/foundry-rs/foundry:latest AS foundry

WORKDIR /contracts
COPY contracts/foundry.toml contracts/.gitmodules ./
COPY contracts/lib ./lib
COPY contracts/src ./src
COPY contracts/script ./script

RUN forge build

# Stage 2: Node — install & build all packages
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY sdk/package.json sdk/package.json
COPY sdk/tsconfig.json sdk/tsconfig.json
COPY cli/package.json cli/package.json
COPY cli/tsconfig.json cli/tsconfig.json
COPY cli/tsup.config.ts cli/tsup.config.ts
COPY indexer/package.json indexer/package.json
COPY indexer/tsconfig.json indexer/tsconfig.json
COPY adapters/eliza/package.json adapters/eliza/package.json
COPY adapters/eliza/tsconfig.json adapters/eliza/tsconfig.json
COPY adapters/game/package.json adapters/game/package.json
COPY adapters/game/tsconfig.json adapters/game/tsconfig.json
COPY services/price-feed/package.json services/price-feed/package.json
COPY services/price-feed/tsconfig.json services/price-feed/tsconfig.json
COPY services/contract-audit/package.json services/contract-audit/package.json
COPY services/contract-audit/tsconfig.json services/contract-audit/tsconfig.json

RUN npm install

COPY sdk/src sdk/src
COPY cli/src cli/src
COPY services/price-feed/src services/price-feed/src
COPY services/contract-audit/src services/contract-audit/src

RUN npm run build --workspaces --if-present

# Stage 3: Runtime — combine everything
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends curl jq && \
    rm -rf /var/lib/apt/lists/*

COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/cast

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY --from=builder /app/node_modules ./node_modules

COPY sdk/package.json sdk/package.json
COPY --from=builder /app/sdk/dist sdk/dist
COPY cli/package.json cli/package.json
COPY --from=builder /app/cli/dist cli/dist
COPY services/price-feed/package.json services/price-feed/package.json
COPY --from=builder /app/services/price-feed/src services/price-feed/src
COPY services/contract-audit/package.json services/contract-audit/package.json
COPY --from=builder /app/services/contract-audit/src services/contract-audit/src

COPY --from=foundry /contracts/foundry.toml contracts/foundry.toml
COPY --from=foundry /contracts/lib contracts/lib
COPY --from=foundry /contracts/src contracts/src
COPY --from=foundry /contracts/script contracts/script
COPY --from=foundry /contracts/out contracts/out

RUN mkdir -p contracts/deployments contracts/broadcast contracts/cache

COPY scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8545 3000 3001

ENV CHAIN=local
ENV RPC_URL=http://localhost:8545
ENV PORT_PRICE_FEED=3000
ENV PORT_CONTRACT_AUDIT=3001
ENV DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

ENTRYPOINT ["/entrypoint.sh"]
