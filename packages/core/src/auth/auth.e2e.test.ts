/**
 * End-to-end tests through Better Auth's real HTTP handler, with our configuration and an
 * in-memory replica set. These exercise the actual sign-up, sign-in and session paths.
 */
import { betterAuth } from 'better-auth';
import { getSessionCookie } from 'better-auth/cookies';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { createAuthOptions, INVITE_COOKIE_NAME } from './better-auth.js';
import { createInvitation } from './invitations.js';
import { deactivateUser } from './users.js';

const BASE_URL = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';

let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

function createTestAuth(rateLimit = false) {
  return betterAuth(
    createAuthOptions({
      client: db.client,
      db: db.db,
      secret: 'test-secret-that-is-long-enough-for-better-auth',
      baseURL: BASE_URL,
      rateLimit,
    }),
  );
}

type Auth = ReturnType<typeof createTestAuth>;
/** Any Better Auth instance, whatever options it was built with. */
type AuthHandler = { handler: (request: Request) => Promise<Response> };

function post(auth: Auth, path: string, body: unknown, cookie?: string, ip = '203.0.113.7') {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE_URL,
        'x-forwarded-for': ip,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function signUp(auth: Auth, email: string, token: string | null, password = PASSWORD) {
  return post(
    auth,
    '/sign-up/email',
    { email, password, name: 'Test Editor' },
    token ? `${INVITE_COOKIE_NAME}=${token}` : undefined,
  );
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { code?: string };
  return body.code;
}

async function invite(email = 'editor@omenai.example', role: 'owner' | 'editor' = 'editor') {
  return createInvitation({ email, role, invitedBy: 'test-owner' });
}

describe('invitation-only email sign-up', () => {
  it('creates the account with the invited role, signs the user in and consumes the invitation', async () => {
    const auth = createTestAuth();
    const { token, invitation } = await invite('owner@omenai.example', 'owner');

    const response = await signUp(auth, 'owner@omenai.example', token);

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/session_token=/);
    const { AuthUser, Invitation } = await getModels();
    const user = await AuthUser.findOne({ email: 'owner@omenai.example' }).lean();
    expect(user).toMatchObject({ role: 'owner', status: 'active', emailVerified: true });
    await expect
      .poll(async () => (await Invitation.findById(invitation.id).lean())?.status)
      .toBe('accepted');
    // The password is stored only as a hash on the credential account.
    const account = await db.db.collection('account').findOne({ providerId: 'credential' });
    expect(account?.password).toBeTypeOf('string');
    expect(account?.password).not.toContain(PASSWORD);
  });

  it('rejects public sign-up without an invitation token', async () => {
    const auth = createTestAuth();
    await invite();
    const response = await signUp(auth, 'editor@omenai.example', null);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('INVITATION_REQUIRED');
    const { AuthUser } = await getModels();
    expect(await AuthUser.countDocuments()).toBe(0);
  });

  it('rejects a valid token used for a different email', async () => {
    const auth = createTestAuth();
    const { token } = await invite();
    const response = await signUp(auth, 'intruder@example.com', token);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('INVITATION_REQUIRED');
  });

  it('does not reveal whether an email already has an account', async () => {
    const auth = createTestAuth();
    const { token } = await invite();
    expect((await signUp(auth, 'editor@omenai.example', token)).status).toBe(200);

    const existing = await signUp(auth, 'editor@omenai.example', null);
    const unknown = await signUp(auth, 'nobody@omenai.example', null);
    expect(existing.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await errorCode(existing)).toBe(await errorCode(unknown));
  });

  it('rejects a short password without consuming the invitation', async () => {
    const auth = createTestAuth();
    const { token } = await invite();
    const weak = await signUp(auth, 'editor@omenai.example', token, 'short1');
    expect(weak.status).toBe(400);

    const retry = await signUp(auth, 'editor@omenai.example', token);
    expect(retry.status).toBe(200);
  });

  it('cannot reuse an invitation once accepted', async () => {
    const auth = createTestAuth();
    const { token } = await invite();
    expect((await signUp(auth, 'editor@omenai.example', token)).status).toBe(200);
    const again = await signUp(auth, 'editor@omenai.example', token, 'another long password');
    expect(again.status).toBe(403);
    expect(await errorCode(again)).toBe('INVITATION_REQUIRED');
    const { AuthUser } = await getModels();
    expect(await AuthUser.countDocuments({ email: 'editor@omenai.example' })).toBe(1);
  });

  it('creates exactly one account when two sign-ups race on one invitation', async () => {
    const auth = createTestAuth();
    const { token } = await invite();
    const responses = await Promise.all([
      signUp(auth, 'editor@omenai.example', token),
      signUp(auth, 'editor@omenai.example', token),
    ]);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const { AuthUser } = await getModels();
    expect(await AuthUser.countDocuments({ email: 'editor@omenai.example' })).toBe(1);
  });

  it('keeps user emails unique at the database level', async () => {
    const indexes = await db.db.collection('user').indexes();
    expect(indexes.some((index) => index.key.email === 1 && index.unique === true)).toBe(true);
  });
});

describe('email sign-in', () => {
  async function registeredEditor(auth: Auth) {
    const { token } = await invite();
    expect((await signUp(auth, 'editor@omenai.example', token)).status).toBe(200);
  }

  it('signs in with the right password and rejects a wrong one with a generic error', async () => {
    const auth = createTestAuth();
    await registeredEditor(auth);

    const ok = await post(auth, '/sign-in/email', {
      email: 'editor@omenai.example',
      password: PASSWORD,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/session_token=/);

    const wrong = await post(auth, '/sign-in/email', {
      email: 'editor@omenai.example',
      password: 'not the password at all',
    });
    expect(wrong.status).toBe(401);
    const unknown = await post(auth, '/sign-in/email', {
      email: 'nobody@omenai.example',
      password: 'not the password at all',
    });
    expect(unknown.status).toBe(401);
    // Same error for unknown accounts and wrong passwords: no account enumeration.
    expect(await errorCode(unknown)).toBe(await errorCode(wrong));
  });

  it('refuses sign-in for a deactivated user', async () => {
    const auth = createTestAuth();
    await registeredEditor(auth);
    const { insertedId: ownerId } = await db.db
      .collection('user')
      .insertOne({ email: 'owner@omenai.example', role: 'owner', status: 'active', name: 'o' });
    const editor = await db.db.collection('user').findOne({ email: 'editor@omenai.example' });
    await deactivateUser({ actorId: ownerId.toString(), userId: editor!._id.toString() });

    const response = await post(auth, '/sign-in/email', {
      email: 'editor@omenai.example',
      password: PASSWORD,
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('ACCOUNT_DEACTIVATED');
  });

  it('rate-limits repeated sign-in attempts from one client', async () => {
    const auth = createTestAuth(true);
    await registeredEditor(auth);
    const attempt = () =>
      post(
        auth,
        '/sign-in/email',
        { email: 'editor@omenai.example', password: 'wrong password!!' },
        undefined,
        '198.51.100.9',
      );

    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await attempt()).status);
    expect(statuses).toContain(429);
    // Limits are persisted in MongoDB, so they hold across serverless instances.
    expect(await db.db.collection('rateLimit').countDocuments()).toBeGreaterThan(0);
  });
});

/** The `name=value` pair of the session cookie a response sets. */
function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token='));
  expect(cookie).toBeDefined();
  return cookie!.split(';')[0]!;
}

async function getSession(auth: AuthHandler, cookie: string, base = BASE_URL) {
  const response = await auth.handler(
    new Request(`${base}/api/auth/get-session`, { headers: { cookie } }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { user: { email: string; role: string } } | null;
}

describe('sessions', () => {
  async function signedInEditor(auth: Auth): Promise<string> {
    const { token } = await invite();
    expect((await signUp(auth, 'editor@omenai.example', token)).status).toBe(200);
    const response = await post(auth, '/sign-in/email', {
      email: 'editor@omenai.example',
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    return sessionCookie(response);
  }

  it('returns the signed-in user, and nothing once signed out', async () => {
    const auth = createTestAuth();
    const cookie = await signedInEditor(auth);
    expect((await getSession(auth, cookie))?.user).toMatchObject({
      email: 'editor@omenai.example',
      role: 'editor',
    });

    // The cookie carries `<session token>.<signature>`.
    const token = decodeURIComponent(cookie.split('=')[1]!).split('.')[0];
    expect(await db.db.collection('session').countDocuments({ token })).toBe(1);

    expect((await post(auth, '/sign-out', {}, cookie)).status).toBe(200);
    // The old cookie no longer opens a session, and its session record is gone.
    expect(await getSession(auth, cookie)).toBeNull();
    expect(await db.db.collection('session').countDocuments({ token })).toBe(0);
  });

  it('treats an expired session as signed out', async () => {
    const auth = createTestAuth();
    const cookie = await signedInEditor(auth);
    await db.db
      .collection('session')
      .updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1_000) } });
    expect(await getSession(auth, cookie)).toBeNull();
  });
});

/**
 * Production as deployed: an https base URL (secure cookies) and Better Auth's origin checks on.
 * Better Auth turns those checks off under test by default, so the tests above never see them.
 */
describe('production-shaped configuration', () => {
  const PRODUCTION_URL = 'https://newsroom.omenai.example';

  function createProductionAuth() {
    const options = createAuthOptions({
      client: db.client,
      db: db.db,
      secret: 'test-secret-that-is-long-enough-for-better-auth',
      baseURL: PRODUCTION_URL,
      rateLimit: false,
    });
    return betterAuth({ ...options, advanced: { disableOriginCheck: false } });
  }

  function postFrom(
    auth: AuthHandler,
    origin: string,
    path: string,
    body: unknown,
    cookie?: string,
  ) {
    return auth.handler(
      new Request(`${PRODUCTION_URL}/api/auth${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          'x-forwarded-for': '203.0.113.7',
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async function signIn(auth: AuthHandler): Promise<Response> {
    const { token } = await invite();
    const signUpResponse = await auth.handler(
      new Request(`${PRODUCTION_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: PRODUCTION_URL,
          cookie: `${INVITE_COOKIE_NAME}=${token}`,
        },
        body: JSON.stringify({ email: 'editor@omenai.example', password: PASSWORD, name: 'E' }),
      }),
    );
    expect(signUpResponse.status).toBe(200);
    return postFrom(auth, PRODUCTION_URL, '/sign-in/email', {
      email: 'editor@omenai.example',
      password: PASSWORD,
    });
  }

  it('sets a secure, HTTP-only session cookie that the sign-in redirect check recognises', async () => {
    const auth = createProductionAuth();
    const response = await signIn(auth);
    expect(response.status).toBe(200);
    const header = response.headers.getSetCookie().find((c) => c.includes('session_token='))!;
    expect(header).toMatch(/^__Secure-better-auth\.session_token=/);
    expect(header).toMatch(/; Secure/i);
    expect(header).toMatch(/; HttpOnly/i);

    const cookie = sessionCookie(response);
    // proxy.ts lets a request through only if it finds this cookie.
    expect(getSessionCookie(new Headers({ cookie }))).toBeTruthy();
    expect((await getSession(auth, cookie, PRODUCTION_URL))?.user.email).toBe(
      'editor@omenai.example',
    );
  });

  it('refuses a cookie-carrying request from any origin but BETTER_AUTH_URL', async () => {
    const auth = createProductionAuth();
    const cookie = sessionCookie(await signIn(auth));

    // e.g. the app opened on its *.vercel.app address while BETTER_AUTH_URL names the domain.
    const elsewhere = await postFrom(
      auth,
      'https://omenai-media.vercel.app',
      '/sign-out',
      {},
      cookie,
    );
    expect(elsewhere.status).toBe(403);
    expect(await errorCode(elsewhere)).toBe('INVALID_ORIGIN');
    expect(await getSession(auth, cookie, PRODUCTION_URL)).not.toBeNull();

    expect((await postFrom(auth, PRODUCTION_URL, '/sign-out', {}, cookie)).status).toBe(200);
    expect(await getSession(auth, cookie, PRODUCTION_URL)).toBeNull();
  });
});
