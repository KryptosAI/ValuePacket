import { ponder } from "ponder:registry";
import { channel } from "ponder:schema";

ponder.on("PaymentChannel:ChannelOpened", async ({ event, context }) => {
  const { channelId, payer, payee, token, deposit, expiresAt } = event.args;

  const ch = await context.client.readContract({
    address: context.contracts.PaymentChannel.address,
    abi: context.contracts.PaymentChannel.abi,
    functionName: "getChannel",
    args: [channelId],
  });

  await context.db.insert(channel).values({
    id: channelId,
    payer,
    payee,
    token,
    deposit,
    spent: 0n,
    openedAt: ch.openedAt,
    expiresAt,
    policy: ch.policy,
    metadata: ch.metadata,
    status: "Open",
  });
});

ponder.on("PaymentChannel:ChannelClosed", async ({ event, context }) => {
  const { channelId, spent } = event.args;

  await context.db.update(channel, { id: channelId }).set({
    spent,
    status: "Settled",
    closedAt: Number(event.block.timestamp),
  });
});

ponder.on("PaymentChannel:ChannelRefunded", async ({ event, context }) => {
  const { channelId } = event.args;

  await context.db.update(channel, { id: channelId }).set({
    status: "Refunded",
    closedAt: Number(event.block.timestamp),
  });
});

ponder.on("PaymentChannel:ChannelExtended", async ({ event, context }) => {
  const { channelId, newExpiry, additionalDeposit } = event.args;

  const current = await context.db.find(channel, { id: channelId });
  if (!current) return;

  await context.db.update(channel, { id: channelId }).set({
    expiresAt: newExpiry,
    deposit: current.deposit + additionalDeposit,
  });
});
