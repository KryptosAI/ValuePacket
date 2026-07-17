import { ponder } from "ponder:registry";
import { service } from "ponder:schema";

ponder.on("ServiceRegistry:ServiceRegistered", async ({ event, context }) => {
  const { serviceId, provider } = event.args;

  const svc = await context.client.readContract({
    address: context.contracts.ServiceRegistry.address,
    abi: context.contracts.ServiceRegistry.abi,
    functionName: "getService",
    args: [serviceId],
  });

  await context.db.insert(service).values({
    id: serviceId,
    provider,
    metadataURI: svc.metadataURI,
    pricePerRequest: svc.pricePerRequest,
    maxResponseMs: svc.maxResponseMs,
    registeredAt: svc.registeredAt,
    active: svc.active,
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

  await context.db.update(service, { id: serviceId }).set({
    metadataURI: svc.metadataURI,
    pricePerRequest: svc.pricePerRequest,
    maxResponseMs: svc.maxResponseMs,
    updatedAt: Number(event.block.timestamp),
  });
});

ponder.on("ServiceRegistry:ServiceDeactivated", async ({ event, context }) => {
  const { serviceId } = event.args;

  await context.db.update(service, { id: serviceId }).set({
    active: false,
    updatedAt: Number(event.block.timestamp),
  });
});
