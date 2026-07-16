import { ponder } from "@ponder/core";
import { service } from "../ponder.schema";

ponder.on("ServiceRegistry:ServiceRegistered", async ({ event, context }) => {
  const { serviceId, provider } = event.args;

  const svc = await context.client.readContract({
    address: context.contracts.ServiceRegistry.address,
    abi: context.contracts.ServiceRegistry.abi,
    functionName: "getService",
    args: [serviceId],
  });

  const [metadataURI, pricePerRequest, maxResponseMs, registeredAt, active] =
    svc as unknown as [string, bigint, number, number, boolean];

  await context.db.insert(service).values({
    id: serviceId,
    provider,
    metadataURI,
    pricePerRequest,
    maxResponseMs,
    registeredAt,
    active,
  });
});

ponder.on("ServiceRegistry:ServiceUpdated", async ({ event, context }) => {
  const { serviceId } = event.args;

  const svc = await context.client.readContract({
    address: context.contracts.ServiceRegistry.address,
    abi: context.contracts.ServiceRegistry.abi,
    functionName: "getService",
    args: [serviceId],
  });

  const [metadataURI, pricePerRequest, maxResponseMs] =
    svc as unknown as [string, bigint, number];

  await context.db.update(service, { id: serviceId }).set({
    metadataURI,
    pricePerRequest,
    maxResponseMs,
    updatedAt: event.block.timestamp,
  });
});

ponder.on("ServiceRegistry:ServiceDeactivated", async ({ event, context }) => {
  const { serviceId } = event.args;

  await context.db.update(service, { id: serviceId }).set({
    active: false,
    updatedAt: event.block.timestamp,
  });
});
