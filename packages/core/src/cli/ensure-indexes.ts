/** Creates or updates all database indexes. Safe to run repeatedly (e.g. on every deploy). */
import { closeDb } from '../db/client.js';
import { ensureIndexes } from '../db/models.js';

ensureIndexes()
  .then(() => console.log('Indexes are up to date.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
