import { describe, expect, it, vi } from 'vitest';
import type { BatchResponse, Message } from 'firebase-admin/messaging';
import {
  ConsoleNotificationSender,
  FcmNotificationSender,
  RecordingNotificationSender,
  buildFcmMessage,
  buildSignalNotification,
  type MessagingClient,
} from '../src';

const input = {
  eventId: 'evt_1',
  symbol: 'NVDA',
  signalType: 'EMA_BULLISH_CROSS',
  label: 'EMA Bullish Cross',
  message: 'EMA 9 crossed above EMA 21 at $182.30',
  timeframe: '5m',
};

describe('buildSignalNotification', () => {
  it('formats title/body and carries only identifiers plus a deep link', () => {
    const msg = buildSignalNotification(input);
    expect(msg.title).toBe('NVDA — EMA Bullish Cross');
    expect(msg.body).toBe('EMA 9 crossed above EMA 21 at $182.30 (5m)');
    expect(msg.data).toEqual({
      type: 'signal',
      eventId: 'evt_1',
      symbol: 'NVDA',
      signalType: 'EMA_BULLISH_CROSS',
      timeframe: '5m',
      url: 'stocksignals://signals/events/evt_1',
    });
    expect(msg.collapseId).toBe('evt_1');
  });
});

describe('FCM message format', () => {
  it('sets high priority, the signals channel, and collapse keys so retries replace, not duplicate', () => {
    const m = buildFcmMessage('tok', buildSignalNotification(input)) as Message & { token: string };
    expect(m.token).toBe('tok');
    expect(m.notification).toEqual({
      title: 'NVDA — EMA Bullish Cross',
      body: 'EMA 9 crossed above EMA 21 at $182.30 (5m)',
    });
    expect(m.android).toEqual({
      priority: 'high',
      notification: { channelId: 'signals', tag: 'evt_1' },
    });
    expect(m.apns).toEqual({
      headers: { 'apns-collapse-id': 'evt_1' },
      payload: { aps: { sound: 'default' } },
    });
  });
});

describe('FcmNotificationSender (mocked messaging)', () => {
  function sender(codes: (string | null)[]) {
    const batches: Message[][] = [];
    const messaging: MessagingClient = {
      async sendEach(messages) {
        batches.push(messages);
        return {
          successCount: codes.filter((c) => c === null).length,
          failureCount: codes.filter((c) => c !== null).length,
          responses: codes.map((code) =>
            code === null
              ? { success: true, messageId: 'm' }
              : { success: false, error: { code, message: code } },
          ),
        } as unknown as BatchResponse;
      },
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { s: new FcmNotificationSender(messaging, logger), batches, logger };
  }

  it('sends one message per device and classifies each result', async () => {
    const { s, batches } = sender([
      null,
      'messaging/registration-token-not-registered',
      'messaging/unavailable',
      'messaging/invalid-argument',
    ]);
    const targets = ['a', 'b', 'c', 'd'].map((token) => ({
      token,
      provider: 'FCM' as const,
      platform: 'android',
    }));
    const res = await s.send(targets, buildSignalNotification(input));
    expect(batches[0]).toHaveLength(4);
    expect(res).toEqual([
      { token: 'a', success: true },
      {
        token: 'b',
        success: false,
        error: 'messaging/registration-token-not-registered',
        invalidToken: true,
        retryable: false,
      },
      {
        token: 'c',
        success: false,
        error: 'messaging/unavailable',
        invalidToken: false,
        retryable: true,
      },
      {
        token: 'd',
        success: false,
        error: 'messaging/invalid-argument',
        invalidToken: false,
        retryable: false,
      },
    ]);
  });

  it('skips raw APNs tokens without calling FCM for them', async () => {
    const { s, batches } = sender([null]);
    const res = await s.send(
      [
        { token: 'fcm-token', provider: 'FCM', platform: 'android' },
        { token: 'apns-token', provider: 'APNS', platform: 'ios' },
      ],
      buildSignalNotification(input),
    );
    expect(batches[0]!.map((m) => (m as { token: string }).token)).toEqual(['fcm-token']);
    expect(res[1]).toMatchObject({ token: 'apns-token', success: false, retryable: false });
  });
});

describe('dev senders', () => {
  it('console sender logs and reports success', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const res = await new ConsoleNotificationSender(logger).send(
      [{ token: 'tok_1234567890', provider: 'FCM', platform: 'android' }],
      { title: 't', body: 'b', data: {} },
    );
    expect(res).toEqual([{ token: 'tok_1234567890', success: true }]);
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('recording sender simulates invalid, transient and permanent failures', async () => {
    const s = new RecordingNotificationSender();
    s.invalidTokens.add('dead');
    s.transientFailures.add('flaky');
    s.permanentFailures.add('bad');
    const res = await s.send(
      ['dead', 'flaky', 'bad', 'ok'].map((token) => ({
        token,
        provider: 'FCM' as const,
        platform: 'ios',
      })),
      { title: 't', body: 'b', data: {} },
    );
    expect(res.map((r) => [r.success, r.invalidToken ?? false, r.retryable ?? false])).toEqual([
      [false, true, false],
      [false, false, true],
      [false, false, false],
      [true, false, false],
    ]);
  });
});
