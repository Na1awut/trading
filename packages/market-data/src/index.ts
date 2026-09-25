import type { MarketDataProvider } from './provider';
import type { MarketDataLogger } from './logger';
import type { SessionMode } from './vendors/types';
import type { VendorResponseObservation } from './http/vendor-http-client';
import { MockMarketDataProvider } from './mock-provider';
import { RealMarketDataProvider } from './real-provider';

export * from './provider';
export * from './errors';
export * from './logger';
export * from './catalog';
export * from './mock-provider';
export * from './scripted-provider';
export * from './real-provider';
export * from './cache';
export * from './cached-provider';
export * from './freshness';
export { resolveBaseUrl } from './base-url';
export { SUPPORTED_VENDORS } from './vendors';
export { TokenBucketRateLimiter, type RateLimiter } from './http/rate-limiter';
export type { VendorResponseObservation } from './http/vendor-http-client';

export interface MarketDataConfig {
  provider: 'mock' | 'real';
  vendor?: string;
  apiKey?: string;
  baseUrl?: string;
  allowCustomBaseUrl?: boolean;
  delayed?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  requestsPerMinute?: number;
  logger?: MarketDataLogger;
  onResponse?: (o: VendorResponseObservation) => void;
  sessionMode?: SessionMode;
}

export function createMarketDataProvider(config: MarketDataConfig): MarketDataProvider {
  switch (config.provider) {
    case 'mock':
      return new MockMarketDataProvider();
    case 'real':
      return new RealMarketDataProvider({
        vendor: config.vendor ?? 'unspecified',
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        allowCustomBaseUrl: config.allowCustomBaseUrl,
        delayed: config.delayed,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        requestsPerMinute: config.requestsPerMinute,
        logger: config.logger,
        onResponse: config.onResponse,
        sessionMode: config.sessionMode,
      });
  }
}
export * from './audit';
export type { SessionMode } from './vendors/types';
