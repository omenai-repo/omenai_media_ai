/**
 * A failed connect must not break the shared client for good. Reproduces production's "Topology
 * is closed" (2026-10-21): a proxy in front of an in-memory MongoDB refuses connections first (a
 * network blip on a cold serverless instance), then lets them through.
 */
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  ensureDatabaseConnection,
  getConnection,
  getDatabase,
  setMongoClientForTesting,
} from './client.js';
import { getModels } from './models.js';

let replSet: MongoMemoryReplSet;
let proxy: Server;
let proxyPort = 0;
let refusing = true;
const open = new Set<Socket>();

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const [host, port] = /mongodb:\/\/([^/,?]+)/.exec(replSet.getUri())![1]!.split(':');
  proxy = createServer((socket) => {
    if (refusing) {
      socket.destroy();
      return;
    }
    const upstream = connect(Number(port), host);
    for (const s of [socket, upstream]) {
      open.add(s);
      s.on('close', () => open.delete(s));
    }
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await replSet.stop();
});

beforeEach(async () => {
  refusing = true;
  const client = new MongoClient(
    `mongodb://127.0.0.1:${proxyPort}/?directConnection=true&serverSelectionTimeoutMS=300&connectTimeoutMS=300`,
  );
  await setMongoClientForTesting(client, 'omenai_topology_test');
});

afterEach(async () => {
  for (const socket of open) socket.destroy();
  await closeDb();
});

/** What Better Auth's adapter does: use the shared database without connecting first. */
const adapterRead = () => getDatabase().collection('user').findOne({});

describe('the shared MongoDB client after a failed connect', () => {
  it('stays closed in the driver, and ensureDatabaseConnection repairs it', async () => {
    await expect(adapterRead()).rejects.toThrow();
    refusing = false;
    // The driver kept the topology it closed: the server is back, yet the call fails at once.
    await expect(adapterRead()).rejects.toMatchObject({ name: 'MongoTopologyClosedError' });

    await ensureDatabaseConnection();
    await expect(adapterRead()).resolves.toBeNull();
  });

  it('is repaired by getConnection too, for Mongoose models and the adapter alike', async () => {
    await expect(adapterRead()).rejects.toThrow();
    refusing = false;

    await getConnection();
    const { Invitation } = await getModels();
    await expect(Invitation.countDocuments()).resolves.toBe(0);
    await expect(adapterRead()).resolves.toBeNull();
  });

  it('costs nothing when already connected: the same client keeps working', async () => {
    refusing = false;
    await ensureDatabaseConnection();
    await expect(adapterRead()).resolves.toBeNull();
    await ensureDatabaseConnection();
    await getConnection();
    await getConnection();
    await expect(adapterRead()).resolves.toBeNull();
  });
});
