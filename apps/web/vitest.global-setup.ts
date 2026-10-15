import { MongoBinary } from 'mongodb-memory-server';

/** Downloads (or finds the cached) mongod binary once, before test files run in parallel. */
export default async function setup(): Promise<void> {
  await MongoBinary.getPath();
}
