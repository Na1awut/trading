import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@signals/config';
import { MockMarketDataProvider } from '@signals/market-data';
import { RecordingNotificationSender } from '@signals/notifications';
import { buildApp } from '../src/app';
import {
  DevAuthVerifier,
  FirebaseAuthVerifier,
  type FirebaseTokenVerifier,
} from '../src/plugins/auth';
import { DATABASE_URL, makeApp, prisma, resetDatabase } from './helpers';

afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

type Decoded = Awaited<ReturnType<FirebaseTokenVerifier['verifyIdToken']>>;

/** Mock of firebase-admin Auth.verifyIdToken with Firebase's real error codes. */
function mockFirebase(tokens: Record<string, Decoded | { error: string }>) {
  const calls: { token: string; checkRevoked?: boolean }[] = [];
  const verifier: FirebaseTokenVerifier = {
    async verifyIdToken(token, checkRevoked) {
      calls.push({ token, checkRevoked });
      const entry = tokens[token];
      if (!entry)
        throw Object.assign(new Error('Decoding Firebase ID token failed'), {
          code: 'auth/argument-error',
        });
      if ('error' in entry) throw Object.assign(new Error(entry.error), { code: entry.error });
      return entry;
    },
  };
  return { verifier, calls };
}

const TOKENS = {
  'valid-password-user': {
    uid: 'uid-alice',
    email: 'alice@example.com',
    email_verified: true,
    name: 'Alice',
    firebase: { sign_in_provider: 'password' },
  },
  'unverified-user': {
    uid: 'uid-new',
    email: 'new@example.com',
    email_verified: false,
    firebase: { sign_in_provider: 'password' },
  },
  'google-user': {
    uid: 'uid-google',
    email: 'g@gmail.com',
    email_verified: true,
    name: 'Gee',
    firebase: { sign_in_provider: 'google.com' },
  },
  expired: { error: 'auth/id-token-expired' },
  revoked: { error: 'auth/id-token-revoked' },
} satisfies Record<string, Decoded | { error: string }>;

async function firebaseApp(
  options: { requireEmailVerified?: boolean; checkRevoked?: boolean } = {},
) {
  const fb = mockFirebase(TOKENS);
  const { app } = await makeApp(
    { AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'test-project' },
    { authVerifier: new FirebaseAuthVerifier(fb.verifier, options) },
  );
  const get = (authorization?: string) =>
    app.inject({ method: 'GET', url: '/me', headers: authorization ? { authorization } : {} });
  return { app, fb, get };
}

describe('Firebase ID token authentication (mocked Firebase)', () => {
  it('accepts a valid token and provisions the user from its claims', async () => {
    const { app, get } = await firebaseApp();
    const res = await get('Bearer valid-password-user');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'alice@example.com', displayName: 'Alice' });
    const again = await get('bearer valid-password-user'); // scheme is case-insensitive
    expect(again.json().id).toBe(res.json().id);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'uid-alice' } }),
    ).toBeTruthy();
    await app.close();
  });

  it('accepts Google sign-in tokens the same way (same Firebase ID token format)', async () => {
    const { app, get } = await firebaseApp({ requireEmailVerified: true });
    expect((await get('Bearer google-user')).json()).toMatchObject({
      email: 'g@gmail.com',
      displayName: 'Gee',
    });
    await app.close();
  });

  it('rejects expired, revoked, forged and dev tokens with 401', async () => {
    const { app, get } = await firebaseApp();
    expect((await get('Bearer expired')).json()).toMatchObject({
      statusCode: 401,
      message: 'Token expired',
    });
    expect((await get('Bearer revoked')).json()).toMatchObject({
      statusCode: 401,
      message: 'Session revoked - sign in again',
    });
    expect((await get('Bearer forged.jwt.value')).json()).toMatchObject({
      statusCode: 401,
      message: 'Invalid or expired token',
    });
    expect((await get('Bearer dev:alice@example.com')).statusCode).toBe(401); // dev tokens do not work in firebase mode
    expect(await prisma.user.count()).toBe(0);
    await app.close();
  });

  it('rejects missing, non-bearer and oversized tokens without calling Firebase', async () => {
    const { app, fb, get } = await firebaseApp();
    expect((await get()).json()).toMatchObject({
      statusCode: 401,
      message: 'Missing bearer token',
    });
    expect((await get('Basic dXNlcjpwYXNz')).statusCode).toBe(401);
    expect((await get(`Bearer ${'x'.repeat(5000)}`)).statusCode).toBe(401);
    expect(fb.calls).toHaveLength(0);
    await app.close();
  });

  it('enforces verified email when AUTH_REQUIRE_EMAIL_VERIFIED is on (403)', async () => {
    const strict = await firebaseApp({ requireEmailVerified: true });
    expect((await strict.get('Bearer unverified-user')).json()).toMatchObject({
      statusCode: 403,
      message: 'Email address not verified',
    });
    await strict.app.close();
    const lax = await firebaseApp({ requireEmailVerified: false });
    expect((await lax.get('Bearer unverified-user')).statusCode).toBe(200);
    await lax.app.close();
  });

  it('passes checkRevoked through to Firebase when enabled', async () => {
    const { app, fb, get } = await firebaseApp({ checkRevoked: true });
    await get('Bearer valid-password-user');
    expect(fb.calls[0]).toEqual({ token: 'valid-password-user', checkRevoked: true });
    await app.close();
  });

  it('never logs the bearer token', async () => {
    const lines: string[] = [];
    const { pino } = await import('pino');
    const logger = pino({ level: 'debug' }, { write: (l: string) => void lines.push(l) });
    const fb = mockFirebase(TOKENS);
    const app = await buildApp(
      {
        config: parseConfig({ DATABASE_URL, AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'p' }),
        prisma,
        marketData: new MockMarketDataProvider(),
        notifier: new RecordingNotificationSender(),
        authVerifier: new FirebaseAuthVerifier(fb.verifier),
      },
      { logger },
    );
    await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer forged.secret.token' },
    });
    await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer valid-password-user' },
    });
    const all = lines.join('\n');
    expect(all).toContain('authentication rejected');
    expect(all).not.toContain('forged.secret.token');
    expect(all).not.toContain('valid-password-user');
    await app.close();
  });
});

describe('production refuses dev authentication', () => {
  it('config validation rejects AUTH_MODE=dev in production', () => {
    expect(() =>
      parseConfig({
        DATABASE_URL,
        NODE_ENV: 'production',
        AUTH_MODE: 'dev',
        CORS_ORIGINS: 'https://a.example',
        ALLOW_MOCK_MARKET_DATA: 'true',
      }),
    ).toThrow(/AUTH_MODE=dev is not allowed in production/);
  });

  it('buildApp refuses a dev verifier even if config validation were bypassed', async () => {
    const config = {
      ...parseConfig({ DATABASE_URL, LOG_LEVEL: 'silent' }),
      NODE_ENV: 'production' as const,
    };
    await expect(
      buildApp(
        {
          config,
          prisma,
          marketData: new MockMarketDataProvider(),
          notifier: new RecordingNotificationSender(),
          authVerifier: new DevAuthVerifier(),
        },
        { logger: false },
      ),
    ).rejects.toThrow(/dev authentication is not allowed in production/);
  });
});
