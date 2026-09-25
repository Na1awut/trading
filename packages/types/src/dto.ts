import { z } from 'zod';
import {
  AssetClassSchema,
  AssetInfoSchema,
  DataFreshnessSchema,
  QuoteSchema,
  SymbolSchema,
  TimeframeSchema,
} from './market';
import {
  SignalEvidenceSchema,
  SignalCategorySchema,
  SignalParametersSchema,
  SignalTypeSchema,
  SignalValuesSchema,
} from './signals';

/* ----------------------------- Watchlist ----------------------------- */

export const WatchlistItemSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  assetClass: AssetClassSchema,
  exchange: z.string(),
  currency: z.string(),
  alertsEnabled: z.boolean(),
  addedAt: z.string(),
  quote: QuoteSchema.nullable(),
  /** Freshness of `quote`; null when the quote could not be loaded. */
  dataStatus: DataFreshnessSchema.nullable(),
  /** Set when the quote failed to load (e.g. vendor outage) - the rest of the list still works. */
  quoteError: z.string().nullable(),
});
export type WatchlistItem = z.infer<typeof WatchlistItemSchema>;

export const AddWatchlistItemBodySchema = z.object({
  symbol: SymbolSchema,
});
export type AddWatchlistItemBody = z.infer<typeof AddWatchlistItemBodySchema>;

export const UpdateWatchlistItemBodySchema = z.object({
  alertsEnabled: z.boolean(),
});
export type UpdateWatchlistItemBody = z.infer<typeof UpdateWatchlistItemBodySchema>;

/* ------------------------------ Assets ------------------------------- */

export const IndicatorSnapshotSchema = z.object({
  close: z.number().nullable(),
  ema9: z.number().nullable(),
  ema20: z.number().nullable(),
  ema21: z.number().nullable(),
  ema50: z.number().nullable(),
  rsi14: z.number().nullable(),
  macd: z.number().nullable(),
  macdSignal: z.number().nullable(),
  macdHistogram: z.number().nullable(),
  volume: z.number().nullable(),
  avgVolume20: z.number().nullable(),
  volumeRatio: z.number().nullable(),
});
export type IndicatorSnapshot = z.infer<typeof IndicatorSnapshotSchema>;

export const SignalEventSchema = z.object({
  id: z.string(),
  ticker: z.string(),
  /** Null when the originating custom signal has since been deleted. */
  signalDefinitionId: z.string().nullable(),
  signalType: SignalTypeSchema,
  category: SignalCategorySchema,
  name: z.string(),
  timeframe: TimeframeSchema,
  triggeredAt: z.string(),
  /** Open time of the completed candle that produced the signal. */
  candleTime: z.string(),
  price: z.number(),
  values: SignalValuesSchema,
  /** Structured explanation; null for events recorded before evidence existed. */
  evidence: SignalEvidenceSchema.nullable(),
  message: z.string(),
  notificationStatus: z.enum(['PENDING', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED', 'NO_DEVICES']),
  notificationSentAt: z.string().nullable(),
  /** Set while a push is deferred (quiet hours) or waiting for a retry. */
  nextNotificationAttemptAt: z.string().nullable(),
});
export type SignalEventDTO = z.infer<typeof SignalEventSchema>;

export const AssetDetailSchema = z.object({
  asset: AssetInfoSchema,
  quote: QuoteSchema,
  timeframe: TimeframeSchema,
  /** Open time of the last COMPLETED candle the indicators were calculated on. */
  indicatorsAsOf: z.string().nullable(),
  indicators: IndicatorSnapshotSchema,
  /** Staleness of the quote and of the candle series the indicators use. */
  dataStatus: z.object({ quote: DataFreshnessSchema, candles: DataFreshnessSchema }),
  inWatchlist: z.boolean(),
  recentEvents: z.array(SignalEventSchema),
});
export type AssetDetail = z.infer<typeof AssetDetailSchema>;

export const AssetSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(40),
});

/* ------------------------------ Signals ------------------------------ */

/** A user's view of a signal: the definition plus the user's subscription state. */
export const SignalSchema = z.object({
  id: z.string(),
  signalDefinitionId: z.string(),
  name: z.string(),
  description: z.string(),
  category: SignalCategorySchema,
  signalType: SignalTypeSchema,
  ticker: z.string(),
  timeframe: TimeframeSchema,
  parameters: SignalParametersSchema,
  enabled: z.boolean(),
  /** Presets are shared definitions; only the subscription can be toggled. */
  isPreset: z.boolean(),
  createdAt: z.string(),
});
export type SignalDTO = z.infer<typeof SignalSchema>;

export const CreateSignalBodySchema = z.object({
  ticker: SymbolSchema,
  signalType: SignalTypeSchema,
  timeframe: TimeframeSchema.optional(),
  parameters: SignalParametersSchema.optional(),
  name: z.string().trim().min(1).max(80).optional(),
});
export type CreateSignalBody = z.infer<typeof CreateSignalBodySchema>;

export const UpdateSignalBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    parameters: SignalParametersSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateSignalBody = z.infer<typeof UpdateSignalBodySchema>;

export const SignalCatalogEntrySchema = z.object({
  signalType: SignalTypeSchema,
  category: SignalCategorySchema,
  label: z.string(),
  description: z.string(),
  defaultParameters: SignalParametersSchema,
});
export type SignalCatalogEntry = z.infer<typeof SignalCatalogEntrySchema>;

export const SignalEventsQuerySchema = z.object({
  ticker: SymbolSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Cursor: return events triggered strictly before this event id. */
  before: z.string().optional(),
});

/* ------------------------------ Devices ------------------------------ */

export const PUSH_PROVIDERS = ['FCM', 'APNS', 'EXPO'] as const;
export const RegisterDeviceBodySchema = z.object({
  token: z.string().trim().min(10).max(4096),
  platform: z.enum(['ios', 'android', 'web']),
  provider: z.enum(PUSH_PROVIDERS).default('FCM'),
});
export type RegisterDeviceBody = z.infer<typeof RegisterDeviceBodySchema>;

/* --------------------------- Notifications --------------------------- */

export const NotificationSettingsSchema = z.object({
  alertsEnabled: z.boolean(),
  /** Categories the user has switched off entirely (e.g. ['VOLUME']). */
  disabledCategories: z.array(SignalCategorySchema),
  // Future-compatible fields: stored and returned but not yet enforced by the worker.
  quietHoursStart: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  quietHoursEnd: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  timezone: z.string().min(1).max(64),
  notificationFrequency: z.enum(['REALTIME', 'HOURLY_DIGEST', 'DAILY_DIGEST']),
  minimumSignalStrength: z.number().int().min(0).max(100),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const UpdateNotificationSettingsBodySchema = NotificationSettingsSchema.partial();

export const MeSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  settings: NotificationSettingsSchema,
});
export type Me = z.infer<typeof MeSchema>;

export const ErrorResponseSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
});
