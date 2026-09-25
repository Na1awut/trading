import type { SignalEvent } from '@prisma/client';
import type { SignalEventDTO } from '@signals/types';
import type { Db } from '../client';
import { toSignalEventDTO } from './mappers';

/** Attach each ticker's quote currency (one query per page, not per event). */
export async function toSignalEventDTOs(db: Db, events: SignalEvent[]): Promise<SignalEventDTO[]> {
  const tickers = [...new Set(events.map((e) => e.ticker))];
  const assets = tickers.length
    ? await db.asset.findMany({
        where: { symbol: { in: tickers } },
        select: { symbol: true, currency: true },
      })
    : [];
  const currency = new Map(assets.map((a) => [a.symbol, a.currency]));
  return events.map((e) => toSignalEventDTO(e, currency.get(e.ticker) ?? 'USD'));
}

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
  return toSignalEventDTOs(db, events);
}
