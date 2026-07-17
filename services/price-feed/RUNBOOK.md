# Happy-Path E2E Runbook — ValuePacket Price Feed

Goal: prove the full paid-request flow returns **200 + a price** — first locally (Route A,
free), then against the real base-sepolia deployment (Route B). Both routes share one
harness; only key/RPC/USDC source changes.

The flow under test:

```
approve(USDC) -> openChannel(payee, USDC, deposit, expiry) [on-chain]
   -> sign EIP-712 PaymentProof (channelId, cumulativeSpent, requestHash, nonce)
      -> POST /price/eth-usdc with X-* payment headers
         -> service recovers signer, reads getChannel() on-chain, verifies, returns price
```

Pass criteria (both routes):
- [ ] `openChannel` confirms; `getChannelCount()` increments
- [ ] First POST returns **200** with `{ price, timestamp, source }`
- [ ] Second POST with `cumulativeSpent += 1000`, `nonce += 1` returns **200** (replay ordering works)
- [ ] Replayed proof (same nonce) returns **409**
- [ ] Proof signed by a different key returns **401**
- [ ] `closeChannel` settles: payee receives `spent`, payer refunded the remainder

---

## Step 0 — One-time prep (both routes)

```bash
cd "/Users/williamweishuhn/Documents/New OpenCode Project"
npm install                       # installs tsx into workspaces (start script needs it)
```

Constants that matter (from `services/price-feed/src/server.ts`):
- `PRICE_PER_REQUEST = 1000` (USDC wei, 6 decimals = $0.001)
- `MIN_CHANNEL_DEPOSIT = 1_000_000` (= 1 USDC) — deposit at least this
- EIP-712 domain: `{ name: "ValuePacket", version: "1", chainId: <rpc>, verifyingContract: <PaymentChannel> }`

---

## Step 1 — Build the happy-path harness

Create `services/price-feed/scripts/happy-path.mjs`. It must:

1. Read env: `RPC_URL`, `PRIVATE_KEY`, `PAYMENT_CHANNEL_ADDRESS`, `USDC_ADDRESS`, `PAYEE`
   (payee can be any address — it just receives the settlement), `BASE_URL` (default
   `http://localhost:3000`).
2. Using viem wallet client:
   a. `approve(paymentChannel, deposit)` on USDC; wait for receipt.
   b. `openChannel(payee, usdc, deposit, now + 3600, 0x0 policy, "0x")`; wait for receipt;
      read `channelId` from the `ChannelOpened` event log (or `getChannelCount()`).
3. Sign PaymentProof #1: `cumulativeSpent = 1000n`, `nonce = 1n`,
   `requestHash = keccak256(toHex(JSON.stringify(body)))` — reuse the signing pattern from
   `scripts/live-check.mjs` (domain/types are already correct there).
4. POST `/price/eth-usdc` with headers `X-Channel-Id`, `X-Cumulative-Spent`,
   `X-Payment-Proof`, `X-Request-Nonce`, `X-Request-Hash`. Assert 200 and a numeric price.
5. Repeat with `cumulativeSpent = 2000n`, `nonce = 2n`. Assert 200.
6. Negative: resend proof #2 unchanged. Assert 409.
7. Negative: sign proof #3 with a random key. Assert 401.
8. Settle: `signChannelClose` (EIP-712, type `ChannelClose(uint256 channelId,uint256 spent)`,
   same domain) with `spent = 2000n`, then call `closeChannel(channelId, 2000, sig)` **from the
   payee wallet** (payee must be an account you control if you test settlement; otherwise skip 8).
9. Print a table: step, expected, actual, PASS/FAIL. Exit non-zero on any FAIL.

Note the `payee` constraint in step 8: `closeChannel` is payee-only. Ideal setup uses TWO
keys you control: payer (opens/pays) and payee (settles). On anvil use accounts #0 and #1.

---

## Route A — Local anvil (do this first)

Terminal 1:
```bash
anvil        # chain-id 31337, funded accounts printed at boot
```

Terminal 2 — deploy and capture addresses:
```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast
# Deploy.s.sol uses anvil account #0 by default and mints 1,000,000 mock USDC to it.
# Copy MOCK_USDC= and PAYMENT_CHANNEL= from output, then update deployments/local.json
# to match (Deploy.s.sol does NOT write the file — keep local.json in sync by hand or add
# vm.writeFile to the script).
```

Terminal 2 — start the service against local:
```bash
cd ../services/price-feed
CHAIN=local npm start
# banner must show: Chain: local, RPC http://localhost:8545, your local PaymentChannel addr
# and "connected: chainId=31337 ..." — if it exits, local.json addresses are stale.
```

Terminal 3 — run the harness:
```bash
cd services/price-feed
RPC_URL=http://localhost:8545 \
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
PAYEE_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
PAYMENT_CHANNEL_ADDRESS=<from deploy> \
USDC_ADDRESS=<MOCK_USDC from deploy> \
node scripts/happy-path.mjs
```
(Those are anvil's well-known dev keys #0 and #1 — never use them anywhere real.)

All 6 pass criteria green? Route A done. Commit the harness — it's now your regression test.

---

## Route B — Real base-sepolia

1. **Fund the payer wallet** (a fresh key, or the deployer key already in `contracts/.env`):
   - Base Sepolia ETH: https://www.alchemy.com/faucets/base-sepolia (or Coinbase faucet).
     ~0.01 ETH is plenty (two txs).
   - Test USDC at `0x036CbD53842c5426634e7929541eC2318f3dCF7e`: use Circle's faucet
     (https://faucet.circle.com, select Base Sepolia) — sends 10 USDC per request.
     Deposit needs >= 1 USDC.
2. **Service is already wired**: `.env` has `CHAIN=base-sepolia`; addresses auto-resolve
   from `contracts/deployments/base-sepolia.json`. Just `npm start`.
3. **Run the same harness** with real params:
   ```bash
   RPC_URL=https://sepolia.base.org \
   PRIVATE_KEY=<funded payer key> \
   PAYEE_PRIVATE_KEY=<second key you control, needs a little ETH for closeChannel> \
   PAYMENT_CHANNEL_ADDRESS=0x9c350ae4D2e8aE380185d3AC95b56fedF98837C3 \
   USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
   node scripts/happy-path.mjs
   ```
4. Verify on Basescan (https://sepolia.basescan.org): the `ChannelOpened` and
   `ChannelClosed` events on the PaymentChannel, and the USDC transfers splitting
   `spent` to payee / remainder to payer.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Service exits `FATAL ... chainId mismatch` | RPC and CHAIN disagree — check `.env` |
| Service exits `no contract bytecode` | Stale address in deployments JSON (esp. local.json after anvil restart — redeploy every anvil boot) |
| 401 on valid proof | Domain mismatch: chainId in signature must equal RPC chainId; verifyingContract must be the PaymentChannel address the SERVICE uses |
| 402 deposit below minimum | Deposit < 1 USDC (1_000_000 wei at 6 decimals) |
| 409 on first request | Service has stale in-memory channel state — restart it (state is not persisted) |
| `SafeERC20FailedOperation` on openChannel | Missing/insufficient `approve` before `openChannel` |
| CoinGecko 503 | Rate limit — the service serves stale cache if warm; retry in 60s |

## Hardening follow-ups (post-green, in priority order)

1. Persist channel state (nonce/cumulativeSpent) — in-memory Map loses replay protection on restart.
2. `watchEvent` on `ChannelClosed`/`ChannelRefunded` — evict settled channels from memory so payments on closed channels fail fast without an RPC round-trip.
3. Rate-limit unauthenticated routes; cap request body size.
4. CI job: anvil + deploy + service + harness = the Route A flow as a GitHub Action.
5. Move `PRICE_PER_REQUEST`/`MIN_CHANNEL_DEPOSIT` to env; register the service in ServiceRegistry and read price from there (single source of truth).
