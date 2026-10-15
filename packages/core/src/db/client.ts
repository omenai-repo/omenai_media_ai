import { MongoClient, type Db } from 'mongodb';
import mongoose, { type Connection } from 'mongoose';

import { optionalEnv, requireEnv } from '../config/env.js';

/**
 * One MongoClient per process, shared by Mongoose (our models) and Better Auth (its adapter).
 * Sharing avoids a second connection pool, which matters on Atlas M0's connection limits and in
 * serverless functions.
 *
 * The state lives on `globalThis` so Next.js dev hot-reloads and warm serverless invocations
 * reuse it instead of leaking clients.
 */
interface DbState {
  client: MongoClient;
  dbName: string;
  connection: Promise<Connection> | null;
}

const globalForDb = globalThis as typeof globalThis & { __omenaiDb?: DbState };

const DEFAULT_DB_NAME = 'omenai';

function createState(): DbState {
  const client = new MongoClient(requireEnv('MONGODB_URI'), {
    appName: 'omenai-newsroom',
    maxPoolSize: 10,
  });
  // Named explicitly (not taken from the URI path) so Mongoose and Better Auth can never
  // disagree about which database they use.
  return { client, dbName: optionalEnv('MONGODB_DB_NAME') ?? DEFAULT_DB_NAME, connection: null };
}

function getState(): DbState {
  globalForDb.__omenaiDb ??= createState();
  return globalForDb.__omenaiDb;
}

/**
 * The shared driver client. Usable synchronously: the driver connects lazily on first use,
 * which is what Better Auth's adapter needs at configuration time.
 */
export function getMongoClient(): MongoClient {
  return getState().client;
}

/** The application database on the shared client (used by Better Auth's adapter). */
export function getDatabase(): Db {
  const state = getState();
  return state.client.db(state.dbName);
}

/**
 * The Mongoose connection bound to the shared client. Mongoose's `setClient()` requires a
 * connected client, so the first call connects; later calls reuse the same promise.
 */
export function getConnection(): Promise<Connection> {
  const state = getState();
  const { client, dbName } = state;
  state.connection ??= client
    .connect()
    .then(() => mongoose.createConnection().setClient(client).useDb(dbName, { useCache: true }))
    .catch((error: unknown) => {
      // Let the next caller retry instead of caching a rejected promise forever.
      state.connection = null;
      throw error;
    });
  return state.connection;
}

/** Test hook: replace the shared client (e.g. with an in-memory replica set). */
export async function setMongoClientForTesting(client: MongoClient, dbName: string): Promise<void> {
  await closeDb();
  globalForDb.__omenaiDb = { client, dbName, connection: null };
}

export async function closeDb(): Promise<void> {
  const state = globalForDb.__omenaiDb;
  globalForDb.__omenaiDb = undefined;
  if (!state) return;
  if (state.connection) {
    const connection = await state.connection.catch(() => null);
    // The connection doesn't own the client, so close the client explicitly below.
    await connection?.close(false).catch(() => undefined);
  }
  await state.client.close();
}
