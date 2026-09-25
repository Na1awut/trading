import { Platform } from 'react-native';
import type {
  AssetDetail,
  AssetInfo,
  CreateSignalBody,
  Me,
  NotificationSettings,
  RegisterDeviceBody,
  SignalCatalogEntry,
  SignalDTO,
  SignalEventDTO,
  UpdateSignalBody,
  WatchlistItem,
} from '@signals/types';

// Android emulators reach the host machine via 10.0.2.2, not localhost.
const DEFAULT_URL = Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || DEFAULT_URL).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let tokenProvider: (forceRefresh?: boolean) => Promise<string | null> = async () => null;
let onUnauthorized: () => void = () => {};

/** Wired up by AuthProvider. */
export function configureApiAuth(
  getToken: (forceRefresh?: boolean) => Promise<string | null>,
  unauthorized: () => void,
) {
  tokenProvider = getToken;
  onUnauthorized = unauthorized;
}

async function send(
  path: string,
  init: { method?: string; body?: unknown },
  forceRefresh: boolean,
) {
  const token = await tokenProvider(forceRefresh);
  try {
    return await fetch(`${API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, `Cannot reach the server at ${API_URL}`);
  }
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res = await send(path, init, false);
  // One retry with a force-refreshed ID token before treating the session as dead.
  if (res.status === 401) res = await send(path, init, true);
  if (res.status === 401) onUnauthorized();
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new ApiError(res.status, json.message ?? `Request failed (${res.status})`);
  return json as T;
}

const enc = encodeURIComponent;

export const api = {
  me: () => request<Me>('/me'),
  updateSettings: (patch: Partial<NotificationSettings>) =>
    request<NotificationSettings>('/me/settings', { method: 'PATCH', body: patch }),

  watchlist: () => request<{ items: WatchlistItem[] }>('/watchlist'),
  addToWatchlist: (symbol: string) =>
    request<{ item: WatchlistItem }>('/watchlist', { method: 'POST', body: { symbol } }),
  removeFromWatchlist: (symbol: string) =>
    request<void>(`/watchlist/${enc(symbol)}`, { method: 'DELETE' }),
  setTickerAlerts: (symbol: string, alertsEnabled: boolean) =>
    request<void>(`/watchlist/${enc(symbol)}`, { method: 'PATCH', body: { alertsEnabled } }),

  searchAssets: (q: string) => request<{ results: AssetInfo[] }>(`/assets/search?q=${enc(q)}`),
  asset: (symbol: string) => request<AssetDetail>(`/assets/${enc(symbol)}`),
  assetSignals: (symbol: string) =>
    request<{ signals: SignalDTO[] }>(`/assets/${enc(symbol)}/signals`),

  catalog: () => request<{ catalog: SignalCatalogEntry[] }>('/signals/catalog'),
  createSignal: (body: CreateSignalBody) =>
    request<SignalDTO>('/signals', { method: 'POST', body }),
  updateSignal: (id: string, patch: UpdateSignalBody) =>
    request<SignalDTO>(`/signals/${enc(id)}`, { method: 'PATCH', body: patch }),
  deleteSignal: (id: string) => request<void>(`/signals/${enc(id)}`, { method: 'DELETE' }),

  signalEvents: (params: { ticker?: string; before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.ticker) q.set('ticker', params.ticker);
    if (params.before) q.set('before', params.before);
    q.set('limit', String(params.limit ?? 30));
    return request<{ events: SignalEventDTO[]; nextCursor: string | null }>(`/signal-events?${q}`);
  },
  signalEvent: (id: string) => request<SignalEventDTO>(`/signal-events/${enc(id)}`),

  registerDevice: (body: RegisterDeviceBody) =>
    request<{ id: string }>('/devices/register', { method: 'POST', body }),
  unregisterDevice: (token: string) =>
    request<void>('/devices/unregister', { method: 'POST', body: { token } }),
  sendTestNotification: () =>
    request<{ devices: number; delivered: number }>('/devices/test', { method: 'POST' }),
};
