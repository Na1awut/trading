import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, parseTrustProxy } from '../src';

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

  it('applies Phase 2 production guards', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      AUTH_MODE: 'firebase',
      FIREBASE_PROJECT_ID: 'p',
      CORS_ORIGINS: 'https://app.example.com',
    };
    expect(() => parseConfig(prod)).toThrow(/Mock market data is not allowed/);
    const ok = parseConfig({ ...prod, ALLOW_MOCK_MARKET_DATA: 'true' });
    expect(ok.ENABLE_API_DOCS).toBe(false); // docs off by default in production
    expect(
      parseConfig({ ...prod, ALLOW_MOCK_MARKET_DATA: 'true', ENABLE_API_DOCS: 'true' })
        .ENABLE_API_DOCS,
    ).toBe(true);
    expect(() =>
      parseConfig({ ...prod, ALLOW_MOCK_MARKET_DATA: 'true', TRUST_PROXY: 'true' }),
    ).toThrow(/spoof/);
  });

  it('keeps ENABLE_SWAGGER as a deprecated alias and enables docs in development', () => {
    expect(parseConfig(base).ENABLE_API_DOCS).toBe(true);
    expect(parseConfig({ ...base, ENABLE_SWAGGER: 'false' }).ENABLE_API_DOCS).toBe(false);
  });

  it('validates the market data vendor and strength confirmations', () => {
    const real = { ...base, MARKET_DATA_PROVIDER: 'real', MARKET_DATA_API_KEY: 'k' };
    expect(() => parseConfig(real)).toThrow(/MARKET_DATA_VENDOR/);
    expect(() => parseConfig({ ...real, MARKET_DATA_VENDOR: 'finnhub' })).toThrow(
      /Unsupported vendor/,
    );
    expect(parseConfig({ ...real, MARKET_DATA_VENDOR: 'twelvedata' }).MARKET_DATA_VENDOR).toBe(
      'twelvedata',
    );
    expect(() => parseConfig({ ...base, SIGNAL_STRENGTH_CONFIRMATIONS: 'rsi,astrology' })).toThrow(
      /astrology/,
    );
  });

  it('parses TRUST_PROXY safely', () => {
    expect(parseTrustProxy('false')).toBe(false);
    const hops = parseTrustProxy('1') as (a: string, h: number) => boolean;
    expect([hops('x', 0), hops('x', 1)]).toEqual([true, false]);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });
});
