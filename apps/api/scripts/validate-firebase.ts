/**
 * Firebase Authentication validation against a REAL Firebase project (Phase 3, step 4).
 *
 *   # API running with AUTH_MODE=firebase AUTH_REQUIRE_EMAIL_VERIFIED=true AUTH_CHECK_REVOKED=true
 *   FIREBASE_WEB_API_KEY=... FIREBASE_PROJECT_ID=... FIREBASE_SERVICE_ACCOUNT_BASE64=... \
 *     pnpm --filter @signals/api validate:firebase --api http://localhost:4000 [--wait-expiry]
 *
 * Creates a throwaway email/password user through the Firebase Auth REST API (the same
 * endpoints the Firebase JS SDK in the app uses), then checks against the running API:
 *   sign-up -> verification email requested -> unverified user rejected (403)
 *   -> marked verified (Admin SDK) -> token refresh -> accepted (200)
 *   -> password sign-in -> accepted -> tampered token rejected (401)
 *   -> refresh tokens revoked ("log out everywhere") -> old ID token rejected (401)
 *      and the old refresh token no longer works
 *   -> [--wait-expiry] an ID token older than 1 hour is rejected (401)
 *   -> the user is deleted.
 *
 * Tokens, the web API key and the service account are never printed. Google sign-in needs an
 * interactive browser/device and is covered by the manual protocol, not this script.
 */
import { randomBytes } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { getFirebaseAdminApp } from '@signals/notifications';

const opt = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const API = (opt('api') ?? 'http://localhost:4000').replace(/\/$/, '');
const WEB_KEY = process.env.FIREBASE_WEB_API_KEY;
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (!WEB_KEY || !PROJECT) {
  console.error('Set FIREBASE_WEB_API_KEY and FIREBASE_PROJECT_ID (and a service account).');
  process.exit(2);
}

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  console.info(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Identity Toolkit call; returns status and body, never logs the key or tokens. */
async function idt(path: string, body: object) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/${path}?key=${WEB_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function refresh(refreshToken: string) {
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${WEB_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function me(idToken: string) {
  const res = await fetch(`${API}/me`, { headers: { authorization: `Bearer ${idToken}` } });
  const body = (await res.json().catch(() => ({}))) as { message?: string; email?: string };
  return { status: res.status, message: body.message ?? '', email: body.email };
}

async function main() {
  const admin = getAuth(
    getFirebaseAdminApp({
      projectId: PROJECT,
      serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
      serviceAccountBase64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    }),
  );
  const email = `signals-validation-${randomBytes(4).toString('hex')}@example.com`;
  const password = randomBytes(18).toString('base64url');
  let uid: string | undefined;
  try {
    const up = await idt('accounts:signUp', { email, password, returnSecureToken: true });
    uid = up.body.localId as string | undefined;
    check('sign-up (email/password)', up.status === 200 && Boolean(uid), `HTTP ${up.status}`);
    const idToken = up.body.idToken as string;

    const oob = await idt('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken });
    check(
      'verification email requested',
      oob.status === 200,
      `HTTP ${oob.status} (delivery to an example.com inbox is not checked)`,
    );

    const unverified = await me(idToken);
    check(
      'API rejects an unverified email (403)',
      unverified.status === 403,
      `HTTP ${unverified.status} ${unverified.message}`,
    );

    await admin.updateUser(uid!, { emailVerified: true });
    const r1 = await refresh(up.body.refreshToken as string);
    check('token refresh', r1.status === 200, `HTTP ${r1.status}`);
    const verified = await me(r1.body.id_token as string);
    check(
      'API accepts the refreshed token after verification (200) and provisions the user',
      verified.status === 200 && verified.email === email,
      `HTTP ${verified.status}`,
    );

    const signIn = await idt('accounts:signInWithPassword', {
      email,
      password,
      returnSecureToken: true,
    });
    check('password sign-in', signIn.status === 200, `HTTP ${signIn.status}`);
    const token = signIn.body.idToken as string;
    check('API accepts the sign-in token (200)', (await me(token)).status === 200);

    const parts = token.split('.');
    const sig = parts[2]!;
    const tampered = `${parts[0]}.${parts[1]}.${sig.slice(0, -4)}${sig.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
    check('API rejects a tampered signature (401)', (await me(tampered)).status === 401);
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ ...payload, email: 'attacker@example.com' })).toString('base64url')}.${sig}`;
    check('API rejects a token with modified claims (401)', (await me(forged)).status === 401);

    // Firebase's revocation granularity is one second; make sure the tokens are older.
    await new Promise((r) => setTimeout(r, 1500));
    await admin.revokeRefreshTokens(uid!);
    const afterRevoke = await me(token);
    check(
      'log out everywhere: API rejects a revoked ID token (401, needs AUTH_CHECK_REVOKED=true)',
      afterRevoke.status === 401,
      `HTTP ${afterRevoke.status} ${afterRevoke.message}`,
    );
    const r2 = await refresh(signIn.body.refreshToken as string);
    check(
      'log out everywhere: the old refresh token stops working',
      r2.status !== 200,
      `HTTP ${r2.status}`,
    );

    if (process.argv.includes('--wait-expiry')) {
      const fresh = await idt('accounts:signInWithPassword', {
        email,
        password,
        returnSecureToken: true,
      });
      console.info('Waiting 61 minutes for the ID token to expire…');
      await new Promise((r) => setTimeout(r, 61 * 60_000));
      const expired = await me(fresh.body.idToken as string);
      check(
        'API rejects an expired ID token (401)',
        expired.status === 401,
        `HTTP ${expired.status} ${expired.message}`,
      );
    } else {
      console.info('SKIP  expired token (run with --wait-expiry; ID tokens live 1 hour)');
    }
  } finally {
    if (uid) {
      await admin.deleteUser(uid).catch(() => {});
      console.info('Test user deleted from Firebase.');
    }
  }
  const failed = results.filter((r) => !r.pass).length;
  console.info(`\n${results.length - failed}/${results.length} passed against project ${PROJECT}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'failed');
  process.exit(1);
});
