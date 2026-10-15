import { MongoBinary } from 'mongodb-memory-server';

/**
 * Downloads (or finds the cached) mongod binary once, before test files run in parallel.
 * Otherwise every DB-backed test file races to download it on a cold cache.
 */
export default async function setup(): Promise<void> {
  await MongoBinary.getPath();
}
