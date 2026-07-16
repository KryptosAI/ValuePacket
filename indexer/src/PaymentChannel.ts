import { ponder } from "@ponder/core";
import { channel } from "../ponder.schema";

ponder.on("PaymentChannel:ChannelOpened", async ({ event, context }) => {
  const { channelId, payer, payee, token, deposit, expiresAt } = event.args;

  const ch = await context.client.readContract({
    address: context.contracts.PaymentChannel.address,
    abi: context.contracts.PaymentChannel.abi,
    functionName: "getChannel",
    args: [channelId],
  });

  const [, , , , , openedAt, , policy, metadata] =
    ch as unknown as [
      string,
      string,
      string,
      bigint,
      bigint,
      number,
      number,
      string,
      string,
      number,
    ];

  await context.db.insert(channel).values({
    id: channelId,
    payer,
    payee,
    token,
    deposit,
    spent: 0n,
    openedAt,
    expiresAt,
    policy,
    metadata,
    status: "Open",
  });
});

ponder.on("PaymentChannel:ChannelClosed", async ({ event, context }) => {
  const { channelId, spent } = event.args;

  await context.db.update(channel, { id: channelId }).set({
    spent,
    status: "Settled",
    closedAt: event.block.timestamp,
  });
});

ponder.on("PaymentChannel:ChannelRefunded", async ({ event, context }) => {
  const { channelId } = event.args;

  await context.db.update(channel, { id: channelId }).set({
    status: "Refunded",
    closedAt: event.block.timestamp,
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
