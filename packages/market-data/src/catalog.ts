import type { AssetInfo } from '@signals/types';

export interface MockAsset extends AssetInfo {
  /** Anchor price the synthetic series oscillates around. */
  basePrice: number;
  /** Typical volume traded per minute. */
  baseVolumePerMinute: number;
}

/**
 * Sample universe for the mock provider. Includes non-US-equity entries to exercise
 * the multi-asset model; the mock generates 24/7 data for all of them and ignores
 * exchange sessions/holidays.
 */
export const MOCK_ASSETS: MockAsset[] = [
  {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    assetClass: 'EQUITY',
    exchange: 'NASDAQ',
    currency: 'USD',
    basePrice: 250,
    baseVolumePerMinute: 120_000,
  },
  {
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    assetClass: 'EQUITY',
    exchange: 'NASDAQ',
    currency: 'USD',
    basePrice: 182,
    baseVolumePerMinute: 400_000,
  },
  {
    symbol: 'MSFT',
    name: 'Microsoft Corporation',
    assetClass: 'EQUITY',
    exchange: 'NASDAQ',
    currency: 'USD',
    basePrice: 510,
    baseVolumePerMinute: 55_000,
  },
  {
    symbol: 'AMZN',
    name: 'Amazon.com, Inc.',
    assetClass: 'EQUITY',
    exchange: 'NASDAQ',
    currency: 'USD',
    basePrice: 225,
    baseVolumePerMinute: 100_000,
  },
  {
    symbol: 'GOOGL',
    name: 'Alphabet Inc. Class A',
    assetClass: 'EQUITY',
    exchange: 'NASDAQ',
    currency: 'USD',
    basePrice: 245,
    baseVolumePerMinute: 80_000,
  },
  {
    symbol: 'META',
    name: 'Meta Platforms, Inc.',
    assetClass: 'EQUITY',
    exchange: 'NASDAQ',
    currency: 'USD',
    basePrice: 760,
    baseVolumePerMinute: 30_000,
  },
  {
    symbol: 'TSLA',
    name: 'Tesla, Inc.',
    assetClass: 'EQUITY',
    exchange: 'NASDAQ',
    currency: 'USD',
    basePrice: 420,
    baseVolumePerMinute: 250_000,
  },
  {
    symbol: 'AMD',
    name: 'Advanced Micro Devices, Inc.',
    assetClass: 'EQUITY',
    exchange: 'NASDAQ',
    currency: 'USD',
    basePrice: 160,
    baseVolumePerMinute: 110_000,
  },
  {
    symbol: 'JPM',
    name: 'JPMorgan Chase & Co.',
    assetClass: 'EQUITY',
    exchange: 'NYSE',
    currency: 'USD',
    basePrice: 300,
    baseVolumePerMinute: 25_000,
  },
  {
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    assetClass: 'ETF',
    exchange: 'NYSE Arca',
    currency: 'USD',
    basePrice: 660,
    baseVolumePerMinute: 180_000,
  },
  {
    symbol: 'QQQ',
    name: 'Invesco QQQ Trust',
    assetClass: 'ETF',
    exchange: 'NASDAQ',
    currency: 'USD',
    basePrice: 590,
    baseVolumePerMinute: 110_000,
  },
  {
    symbol: 'BTC-USD',
    name: 'Bitcoin / US Dollar',
    assetClass: 'CRYPTO',
    exchange: 'CRYPTO',
    currency: 'USD',
    basePrice: 112_000,
    baseVolumePerMinute: 25,
  },
  {
    symbol: 'ETH-USD',
    name: 'Ethereum / US Dollar',
    assetClass: 'CRYPTO',
    exchange: 'CRYPTO',
    currency: 'USD',
    basePrice: 4_100,
    baseVolumePerMinute: 400,
  },
  {
    symbol: 'PTT.BK',
    name: 'PTT Public Company Limited',
    assetClass: 'EQUITY',
    exchange: 'SET',
    currency: 'THB',
    basePrice: 33,
    baseVolumePerMinute: 90_000,
  },
  {
    symbol: 'CPALL.BK',
    name: 'CP ALL Public Company Limited',
    assetClass: 'EQUITY',
    exchange: 'SET',
    currency: 'THB',
    basePrice: 52,
    baseVolumePerMinute: 60_000,
  },
];
