/**
 * Fills a *fixtures* database with a named development scenario (invented editions, stories,
 * team and simulated usage) for local interface work without API spend. It runs only in the
 * fixtures runtime with a database whose name ends in `_fixtures`, so real data is never affected.
 *
 *   OMENAI_RUNTIME=fixtures MONGODB_DB_NAME=omenai_fixtures pnpm db:seed-fixtures           # "full"
 *   OMENAI_RUNTIME=fixtures MONGODB_DB_NAME=omenai_fixtures pnpm db:seed-fixtures -- empty  # new
 */
import { betterAuth } from 'better-auth';

import { createAuthOptions, INVITE_COOKIE_NAME } from '../auth/better-auth.js';
import { optionalEnv, requireEnv } from '../config/env.js';
import { isFixtureRuntime } from '../config/runtime.js';
import { closeDb, getDatabase, getMongoClient } from '../db/client.js';
import { ensureIndexes } from '../db/models.js';
import {
  FIXTURE_ACCOUNTS,
  FIXTURE_PASSWORD,
  SCENARIOS,
  seedScenario,
  type ScenarioName,
} from '../testing/scenarios/index.js';

async function main(): Promise<void> {
  const dbName = optionalEnv('MONGODB_DB_NAME') ?? '(not set)';
  if (!isFixtureRuntime()) {
    console.error(
      `Refusing to seed "${dbName}". Set OMENAI_RUNTIME=fixtures and a MONGODB_DB_NAME ending in _fixtures.`,
    );
    process.exitCode = 1;
    return;
  }
  const requested = process.argv.slice(2).find((arg) => !arg.startsWith('-')) ?? 'full';
  if (!(requested in SCENARIOS)) {
    console.error(
      `Unknown scenario "${requested}". Choose one of: ${Object.keys(SCENARIOS).join(', ')}.`,
    );
    process.exitCode = 1;
    return;
  }
  const scenario = requested as ScenarioName;

  const db = getDatabase();
  for (const collection of await db.collections()) await collection.deleteMany({});
  await ensureIndexes();

  const auth = betterAuth(
    createAuthOptions({
      client: getMongoClient(),
      db,
      secret: requireEnv('BETTER_AUTH_SECRET'),
      baseURL: requireEnv('BETTER_AUTH_URL'),
    }),
  );
  const { editions } = await seedScenario(scenario, {
    signUp: async ({ email, name, password, invitationToken }) => {
      await auth.api.signUpEmail({
        body: { email, password, name },
        headers: new Headers({ cookie: `${INVITE_COOKIE_NAME}=${invitationToken}` }),
      });
    },
  });

  console.log(`Seeded "${dbName}" with the "${scenario}" scenario: ${SCENARIOS[scenario]}`);
  console.log('All content is invented development data; usage is marked simulated.');
  for (const edition of editions) console.log(`  ${edition.runKey}  ${edition.description}`);
  const accounts = scenario === 'full' ? Object.values(FIXTURE_ACCOUNTS) : [FIXTURE_ACCOUNTS.owner];
  console.log(`Sign in with password "${FIXTURE_PASSWORD}" as:`);
  for (const account of accounts)
    console.log(`  ${account.email} (${account.role}, ${account.name})`);
  if (scenario === 'full')
    console.log('  (kwesi.mensah has had access removed, so cannot sign in.)');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
