import type { MarketDataProvider } from './provider';
import { MockMarketDataProvider } from './mock-provider';
import { RealMarketDataProvider } from './real-provider';

export * from './provider';
export * from './catalog';
export * from './mock-provider';
export * from './scripted-provider';
export * from './real-provider';

export interface MarketDataConfig {
  provider: 'mock' | 'real';
  vendor?: string;
  apiKey?: string;
  baseUrl?: string;
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
      });
  }
}
