import { PrismaClient } from '@prisma/client';

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  return new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
}

/** Either the client or an interactive-transaction client. */
export type Db = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
