import { migrateTestDatabase, testDatabaseUrl } from '@signals/db/testing';

export default function setup() {
  migrateTestDatabase(testDatabaseUrl('api_test'));
}
