import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('parseConfig', () => {
  it('applies safe local-development defaults', () => {
    const c = parseConfig(base);
    expect(c.AUTH_MODE).toBe('dev');
    expect(c.NOTIFICATION_DRIVER).toBe('console');
    expect(c.MARKET_DATA_PROVIDER).toBe('mock');
    expect(c.SIGNAL_POLL_INTERVAL_MS).toBe(30_000);
    expect(c.API_PORT).toBe(4000);
  });

  it('coerces numbers and treats empty strings as unset', () => {
    const c = parseConfig({ ...base, SIGNAL_POLL_INTERVAL_MS: '5000', FIREBASE_PROJECT_ID: '' });
    expect(c.SIGNAL_POLL_INTERVAL_MS).toBe(5000);
    expect(c.FIREBASE_PROJECT_ID).toBeUndefined();
  });

  it('refuses dev auth and wildcard CORS in production', () => {
    expect(() => parseConfig({ ...base, NODE_ENV: 'production' })).toThrow(ConfigError);
    try {
      parseConfig({ ...base, NODE_ENV: 'production' });
    } catch (e) {
      expect((e as ConfigError).issues.join()).toMatch(/AUTH_MODE=dev is not allowed/);
      expect((e as ConfigError).issues.join()).toMatch(/CORS/);
    }
  });

  it('requires Firebase project id for firebase auth / FCM', () => {
    expect(() => parseConfig({ ...base, NOTIFICATION_DRIVER: 'fcm' })).toThrow(
      /FIREBASE_PROJECT_ID/,
    );
    expect(
      parseConfig({ ...base, AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'p' }).AUTH_MODE,
    ).toBe('firebase');
  });

  it('requires an API key for the real market data provider', () => {
    expect(() => parseConfig({ ...base, MARKET_DATA_PROVIDER: 'real' })).toThrow(
      /MARKET_DATA_API_KEY/,
    );
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
  });
});
