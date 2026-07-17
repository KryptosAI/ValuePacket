# @valuepacket/sdk

## 0.3.0

### Minor Changes

- `SubscriptionSession` aligned with the on-chain `SubscriptionManager` contract: correct function names (`cancel`), event signatures, and struct decoding; `renew()` is now submitted by the payee with a payer-signed EIP-712 authorization (`renew(spent, submitter?, authSignature?)`).
- Period-bound renewal salts: `computeRenewalSalt` is exported and matches the contract's replay protection (`keccak256(abi.encode(subscriptionId, completedPeriods + 1))`); `InvalidSalt` error added to `SUBSCRIPTION_MANAGER_ABI`.
- `ChannelServer` auto-settlement: opt-in `autoSettle` config closes channels approaching expiry using the latest stored payment proof.
- `ChannelServer` persistence: optional `stateStore` (`ChannelStateStore`) so replay protection and settlement state survive restarts; `FileChannelStateStore` serializes the latest close signature.
- Reputation extension fixed against the real `AgentReputation` ABI (`getAverageScore`/`getRatingCount`; the previous `getScore(address)` selector did not exist on-chain).
- Webhook event payloads are bigint-safe (bigints serialized as strings).
- `privateKeyToAccount` imported from `viem/accounts` (fixes type declaration build).

## 0.2.2

Initial public release under the `@valuepacket` scope.
