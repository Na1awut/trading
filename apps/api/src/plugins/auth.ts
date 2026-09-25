import type { FastifyReply, FastifyRequest } from 'fastify';
import { findOrCreateUser, type IdentityClaims, type PrismaClient } from '@signals/db';

export interface AuthVerifier {
  readonly mode: 'dev' | 'firebase';
  /** Throws AuthError (or any error -> 401) when the token is not acceptable. */
  verify(token: string): Promise<IdentityClaims>;
}

export interface AuthUser {
  id: string;
  firebaseUid: string;
  email: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

/** Authentication failure with a safe, client-facing message. */
export class AuthError extends Error {
  constructor(
    readonly statusCode: 401 | 403,
    message: string,
    /** Machine-readable reason for logs (never the token). */
    readonly reason: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Largest bearer token we will hand to a verifier (Firebase ID tokens are ~1 KB). */
export const MAX_TOKEN_LENGTH = 4096;

/**
 * LOCAL DEVELOPMENT ONLY. Accepts `Bearer dev:<email>`. Config validation refuses
 * AUTH_MODE=dev when NODE_ENV=production, and buildApp refuses a dev verifier in production.
 */
export class DevAuthVerifier implements AuthVerifier {
  readonly mode = 'dev' as const;
  async verify(token: string): Promise<IdentityClaims> {
    const match = /^dev:([^\s@]{1,64}@[^\s@]{1,190})$/.exec(token);
    if (!match) throw new AuthError(401, 'Invalid or expired token', 'dev_token_malformed');
    const email = match[1]!.toLowerCase();
    return { firebaseUid: `dev:${email}`, email };
  }
}

/** The subset of firebase-admin's Auth we use - injectable for tests. */
export interface FirebaseTokenVerifier {
  verifyIdToken(
    idToken: string,
    checkRevoked?: boolean,
  ): Promise<{
    uid: string;
    email?: string;
    email_verified?: boolean;
    name?: unknown;
    firebase?: { sign_in_provider?: string };
  }>;
}

export interface FirebaseAuthOptions {
  /** Reject password accounts whose email is not verified yet (403). */
  requireEmailVerified?: boolean;
  /** Also check the token was not revoked (extra Firebase call per request). */
  checkRevoked?: boolean;
}

/**
 * Production verifier: validates Firebase ID tokens (signature, expiry, audience = project,
 * issuer) with the Admin SDK. Works for every Firebase sign-in provider - email/password
 * and Google sign-in produce the same kind of ID token, so no extra server code is needed
 * to enable Google (or Apple) sign-in in the app.
 */
export class FirebaseAuthVerifier implements AuthVerifier {
  readonly mode = 'firebase' as const;
  constructor(
    private readonly auth: FirebaseTokenVerifier,
    private readonly options: FirebaseAuthOptions = {},
  ) {}

  async verify(token: string): Promise<IdentityClaims> {
    let decoded: Awaited<ReturnType<FirebaseTokenVerifier['verifyIdToken']>>;
    try {
      decoded = await this.auth.verifyIdToken(token, this.options.checkRevoked ?? false);
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'unknown';
      if (code === 'auth/id-token-expired') {
        throw new AuthError(401, 'Token expired', code);
      }
      if (code === 'auth/id-token-revoked' || code === 'auth/user-disabled') {
        throw new AuthError(401, 'Session revoked - sign in again', code);
      }
      throw new AuthError(401, 'Invalid or expired token', code);
    }
    if (this.options.requireEmailVerified && decoded.email && decoded.email_verified !== true) {
      throw new AuthError(403, 'Email address not verified', 'email_not_verified');
    }
    return {
      firebaseUid: decoded.uid,
      email: decoded.email ?? null,
      displayName: typeof decoded.name === 'string' ? decoded.name : null,
    };
  }
}

export function createAuthenticateHook(verifier: AuthVerifier, prisma: PrismaClient) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
    if (!match) throw new AuthError(401, 'Missing bearer token', 'missing_token');
    const token = match[1]!;
    if (token.length > MAX_TOKEN_LENGTH) {
      throw new AuthError(401, 'Invalid or expired token', 'token_too_long');
    }
    let claims: IdentityClaims;
    try {
      claims = await verifier.verify(token);
    } catch (err) {
      const authErr =
        err instanceof AuthError
          ? err
          : new AuthError(401, 'Invalid or expired token', 'verify_failed');
      // Reason only - the token itself is never logged.
      request.log.info(
        { reason: authErr.reason, authMode: verifier.mode },
        'authentication rejected',
      );
      throw authErr;
    }
    const user = await findOrCreateUser(prisma, claims);
    request.user = { id: user.id, firebaseUid: user.firebaseUid, email: user.email };
  };
}
