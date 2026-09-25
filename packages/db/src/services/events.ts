import type { SignalEventDTO } from '@signals/types';
import type { Db } from '../client';
import { toSignalEventDTO } from './mappers';

export async function listSignalEvents(
  db: Db,
  userId: string,
  opts: { ticker?: string; limit?: number; before?: string } = {},
): Promise<SignalEventDTO[]> {
  const events = await db.signalEvent.findMany({
    where: { userId, ...(opts.ticker ? { ticker: opts.ticker } : {}) },
    orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }],
    take: opts.limit ?? 50,
    ...(opts.before ? { cursor: { id: opts.before }, skip: 1 } : {}),
  });
  return events.map(toSignalEventDTO);
}
