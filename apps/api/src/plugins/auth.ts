import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { findOrCreateUser, type IdentityClaims, type PrismaClient } from '@signals/db';

export interface AuthVerifier {
  readonly mode: 'dev' | 'firebase';
  /** Throws when the token is invalid. */
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

/**
 * LOCAL DEVELOPMENT ONLY. Accepts `Bearer dev:<email>`. Config validation refuses
 * AUTH_MODE=dev when NODE_ENV=production.
 */
export class DevAuthVerifier implements AuthVerifier {
  readonly mode = 'dev' as const;
  async verify(token: string): Promise<IdentityClaims> {
    const match = /^dev:([^\s@]{1,64}@[^\s@]{1,190})$/.exec(token);
    if (!match) throw new Error('Invalid dev token - expected "dev:<email>"');
    const email = match[1]!.toLowerCase();
    return { firebaseUid: `dev:${email}`, email };
  }
}

export class FirebaseAuthVerifier implements AuthVerifier {
  readonly mode = 'firebase' as const;
  constructor(private readonly app: App) {}
  async verify(token: string): Promise<IdentityClaims> {
    const decoded = await getAuth(this.app).verifyIdToken(token);
    return {
      firebaseUid: decoded.uid,
      email: decoded.email ?? null,
      displayName: (decoded.name as string | undefined) ?? null,
    };
  }
}

class UnauthorizedError extends Error {
  readonly statusCode = 401;
}

export function createAuthenticateHook(verifier: AuthVerifier, prisma: PrismaClient) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing bearer token');
    }
    let claims: IdentityClaims;
    try {
      claims = await verifier.verify(header.slice('Bearer '.length).trim());
    } catch (err) {
      request.log.debug({ err }, 'token verification failed');
      throw new UnauthorizedError('Invalid or expired token');
    }
    const user = await findOrCreateUser(prisma, claims);
    request.user = { id: user.id, firebaseUid: user.firebaseUid, email: user.email };
  };
}
