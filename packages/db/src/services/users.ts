import type { NotificationSettings } from '@signals/types';
import type { Db } from '../client';
import { toSettingsDTO } from './mappers';

export interface IdentityClaims {
  firebaseUid: string;
  email?: string | null;
  displayName?: string | null;
}

/** First authenticated request provisions the user, settings row and default watchlist. */
export async function findOrCreateUser(db: Db, claims: IdentityClaims) {
  // Fast path: most requests come from existing users - avoid a write per request.
  const existing = await db.user.findUnique({ where: { firebaseUid: claims.firebaseUid } });
  if (
    existing &&
    (claims.email === undefined || claims.email === existing.email) &&
    (claims.displayName === undefined || claims.displayName === existing.displayName)
  ) {
    return existing;
  }
  const user = await db.user.upsert({
    where: { firebaseUid: claims.firebaseUid },
    update: { email: claims.email ?? undefined, displayName: claims.displayName ?? undefined },
    create: {
      firebaseUid: claims.firebaseUid,
      email: claims.email ?? null,
      displayName: claims.displayName ?? null,
      settings: { create: {} },
      watchlists: { create: { name: 'My Watchlist', isDefault: true } },
    },
  });
  return user;
}

export async function getSettings(db: Db, userId: string): Promise<NotificationSettings> {
  const s = await db.notificationSettings.upsert({ where: { userId }, update: {}, create: { userId } });
  return toSettingsDTO(s);
}

export async function updateSettings(
  db: Db,
  userId: string,
  patch: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  const s = await db.notificationSettings.upsert({
    where: { userId },
    update: patch,
    create: { userId, ...patch },
  });
  return toSettingsDTO(s);
}
