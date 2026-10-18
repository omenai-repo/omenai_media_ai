import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { closeDb, getConnection, setMongoClientForTesting } from '../db/client.js';
import { ensureIndexes } from '../db/models.js';

/**
 * Test-only helpers. Starts a single-node in-memory replica set (Better Auth uses transactions,
 * which MongoDB only supports on replica sets) and points the shared client at it.
 * The mongod binary is downloaded on first use and cached by mongodb-memory-server.
 */
const TEST_DB_NAME = 'omenai_test';

export interface TestDatabase {
  client: MongoClient;
  db: Db;
  /** Drops every collection's documents while keeping indexes. */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = new MongoClient(replSet.getUri());
  await client.connect();
  await setMongoClientForTesting(client, TEST_DB_NAME);
  await getConnection();
  await ensureIndexes();

  const db = client.db(TEST_DB_NAME);
  return {
    client,
    db,
    reset: async () => {
      const collections = await db.collections();
      await Promise.all(collections.map((collection) => collection.deleteMany({})));
    },
    stop: async () => {
      await closeDb();
      await replSet.stop();
    },
  };
}

export { seedFixtureNewsroom } from './seed.js';
