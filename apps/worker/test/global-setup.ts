import { migrateTestDatabase, testDatabaseUrl } from '@signals/db/testing';

export default function setup() {
  migrateTestDatabase(testDatabaseUrl('worker_test'));
}
