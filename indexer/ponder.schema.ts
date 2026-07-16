import { onchainTable } from "@ponder/core";

export const service = onchainTable("service", (t) => ({
  id: t.hex().primaryKey(),
  provider: t.hex().notNull(),
  metadataURI: t.text().notNull(),
  pricePerRequest: t.bigint().notNull(),
  maxResponseMs: t.integer().notNull(),
  registeredAt: t.integer().notNull(),
  active: t.boolean().notNull(),
  updatedAt: t.integer(),
}));

export const channel = onchainTable("channel", (t) => ({
  id: t.bigint().primaryKey(),
  payer: t.hex().notNull(),
  payee: t.hex().notNull(),
  token: t.hex().notNull(),
  deposit: t.bigint().notNull(),
  spent: t.bigint(),
  openedAt: t.integer().notNull(),
  expiresAt: t.integer().notNull(),
  policy: t.hex(),
  metadata: t.hex(),
  status: t.text().notNull(),
  closedAt: t.integer(),
}));
