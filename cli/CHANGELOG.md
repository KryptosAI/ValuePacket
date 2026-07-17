# @valuepacket/cli

## 0.3.0

### Minor Changes

- Subscription commands rewritten against the real SDK API: `subscribe` uses `SubscriptionSession.create`, `subscriptions list` reads on-chain state, `subscriptions cancel` settles and refunds via `SubscriptionSession.load`.
- New `subscriptions authorize <id>` command: the payer signs a period-bound EIP-712 renewal authorization to hand to the payee.
- `subscriptions renew <id>` is now payee-side and requires `--auth-signature` from the payer (matches the contract's authorization model).
- Depends on `@valuepacket/sdk` ^0.3.0.

## 0.2.2

Initial public release under the `@valuepacket` scope.
