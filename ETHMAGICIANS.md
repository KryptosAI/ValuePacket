# ValuePacket — EIP-712 payment channels for autonomous AI agents

Hey all — I've been working on a payment channel protocol purpose-built for agent-to-agent payments and wanted to get feedback from people who think about channel design at the protocol level.

The short version: ValuePacket lets one AI agent pay another for individual API requests using unidirectional EIP-712-signed payment channels. An agent opens a channel on-chain, then includes a signed payment proof with every request. The receiver can settle any time. It's live on Base Sepolia with a working ElizaOS plugin.

## Why EIP-712

Every payment proof is an EIP-712 typed signature over a `ChannelClose` struct:

```
ChannelClose(bytes32 channelId, uint256 totalPaid, uint256 nonce)
```

We use full domain separation — name, version, chainId, and the verifying contract address. The structured data shows up in a wallet like any typed message, so both the sender and receiver can inspect exactly what they're signing before it hits the chain. This was the main reason we went with 712 over a raw `eth_sign` or personal_sign approach — the debuggability alone has saved us hours during development.

## Unidirectional vs bidirectional

This isn't Lightning. We intentionally went with payer → payee unidirectional channels. Here's the reasoning:

- Agent payments are overwhelmingly one-directional in practice. Your agent pays a compute provider. It doesn't receive payments from that same provider in the same session.
- Unidirectional channels don't require the payee to sign anything or stay online. The payer signs a new `ChannelClose` with each payment, and the payee can submit the latest one whenever they want. No revocation keys, no penalty mechanism, no watchtower needed.
- The simplicity means the channel logic fits in a single Solidity contract without needing a state channel framework underneath.

The tradeoff is that the payer has to track their own balance (they can't receive funds back without closing). But for the agent use case, this hasn't been an issue — agents naturally track their own spending limits.

## Cross-chain settlement

This is the part I'm most interested in feedback on. The design separates settlement from payment flow:

1. Two agents interact on whatever chain they're on (or even off-chain via HTTP).
2. When the payee settles, they submit a `ChannelClose` proof to the chain where the channel was opened.
3. The `ChannelClose` includes the source chain domain separator and chainId. A verifier contract on the destination chain can validate that the signed proof originated from a known channel on the source chain, without requiring a bridge or message relay.

The idea is that an agent on Base could open a channel and pay an agent on Optimism without either party needing to deploy or manage anything cross-chain. The destination verifier just checks the EIP-712 domain fields. It's not trustless in the strictest sense — you're trusting that the source chain won't reorg — but for microtransactions with short settlement windows, the practical risk seems acceptable.

I'm less confident about edge cases here. Specifically: what happens when the source chain's channel state diverges from what the destination verifier expects? And are there better patterns for cross-domain replay protection beyond what EIP-712 provides?

## SpendingPolicy as programmable contracts

Spending policies aren't a SaaS feature or a server-side config. They're Solidity contracts that the channel creator deploys and attaches:

```solidity
contract SpendingPolicy {
    function authorize(PaymentRequest calldata req) external view returns (bool);
}
```

This means anyone can write custom policies — per-endpoint rate limits, allowlists of receiver addresses, maximum-per-request caps, time-windowed budgets, whatever. The channel contract calls `authorize` before validating any payment. If the policy reverts or returns false, the payment is rejected at the contract level.

Running a policy as an on-chain contract has gas implications, but we've found the read-only `view` call pattern keeps it cheap enough for the settlement transaction. Curious if anyone has experimented with similar patterns or sees issues I'm missing.

## Where I'd like feedback

1. **Cross-chain domain verification** — is the EIP-712 domain separator approach sound, or are there better primitives (storage proofs, light client headers) that should replace it?
2. **Channel lifecycle** — we currently require the payer to explicitly close the channel to withdraw remaining funds. Is there a better pattern for "expired" channels that doesn't require the payer to stay active?
3. **MEV at settlement** — the settlement tx reveals the total payment value. For high-volume channels, this could leak revenue data. Has anyone designed around this, maybe with a commit-reveal settlement?

Repo is at https://github.com/KryptosAI/ValuePacket — TypeScript SDK, Solidity contracts, and a working ElizaOS plugin. CLI installs with `npm i -g @valuepacket/cli`. Everything's MIT licensed, 234 tests (177 Solidity + 30 SDK + 27 CLI), verified on Base Sepolia.

Would genuinely appreciate any critique. This works in demos but I want to know where it breaks at scale.
