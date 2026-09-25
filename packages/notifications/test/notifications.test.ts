import { describe, expect, it, vi } from 'vitest';
import {
  ConsoleNotificationSender,
  RecordingNotificationSender,
  buildSignalNotification,
} from '../src';

describe('buildSignalNotification', () => {
  it('formats title/body and a deep link to the asset screen', () => {
    const msg = buildSignalNotification({
      eventId: 'evt_1',
      ticker: 'NVDA',
      label: 'EMA Bullish Cross',
      message: 'EMA 9 crossed above EMA 21 at $182.30',
      timeframe: '1h',
    });
    expect(msg.title).toBe('NVDA — EMA Bullish Cross');
    expect(msg.body).toBe('EMA 9 crossed above EMA 21 at $182.30 (1h)');
    expect(msg.data).toEqual({
      type: 'signal',
      eventId: 'evt_1',
      ticker: 'NVDA',
      url: 'stocksignals://asset/NVDA',
    });
  });
});

describe('senders', () => {
  it('console sender logs and reports success', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const res = await new ConsoleNotificationSender(logger).send(
      [{ token: 'tok_1234567890', provider: 'FCM', platform: 'android' }],
      { title: 't', body: 'b', data: {} },
    );
    expect(res).toEqual([{ token: 'tok_1234567890', success: true }]);
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('recording sender flags invalid tokens', async () => {
    const s = new RecordingNotificationSender();
    s.invalidTokens.add('dead');
    const res = await s.send(
      [
        { token: 'dead', provider: 'FCM', platform: 'ios' },
        { token: 'live', provider: 'FCM', platform: 'ios' },
      ],
      { title: 't', body: 'b', data: {} },
    );
    expect(res.map((r) => r.invalidToken ?? false)).toEqual([true, false]);
    expect(s.sent).toHaveLength(1);
  });
});
