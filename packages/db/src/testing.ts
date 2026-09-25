/** Test utilities shared by the API and worker integration tests. */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';

const DEFAULT_TEST_URL = 'postgresql://signals:signals@localhost:5432/signals_test';

/**
 * Each test project gets its own Postgres schema so projects can run in parallel.
 * Base URL from TEST_DATABASE_URL (never DATABASE_URL, to protect dev data).
 */
export function testDatabaseUrl(schema: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

export function migrateTestDatabase(databaseUrl: string): void {
  const dbPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: dbPackageDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
