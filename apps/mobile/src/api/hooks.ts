import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationSettings, Timeframe } from '@signals/types';
import { api } from './client';

export const keys = {
  watchlist: ['watchlist'] as const,
  asset: (s: string, tf?: string) => (tf ? (['asset', s, tf] as const) : (['asset', s] as const)),
  assetSignals: (s: string) => ['assetSignals', s] as const,
  events: (ticker?: string) => ['events', ticker ?? 'all'] as const,
  event: (id: string) => ['event', id] as const,
  me: ['me'] as const,
  catalog: ['catalog'] as const,
  search: (q: string) => ['search', q] as const,
};

export const WATCHLIST_REFRESH_MS = 15_000;
export const ASSET_REFRESH_MS = 15_000;
export const EVENTS_REFRESH_MS = 20_000;

export const useWatchlist = () =>
  useQuery({
    queryKey: keys.watchlist,
    queryFn: api.watchlist,
    refetchInterval: WATCHLIST_REFRESH_MS,
  });

export const useAsset = (symbol: string, timeframe?: Timeframe) =>
  useQuery({
    queryKey: keys.asset(symbol, timeframe),
    queryFn: () => api.asset(symbol, timeframe),
    refetchInterval: ASSET_REFRESH_MS,
    placeholderData: (previous) => previous, // keep showing data while switching timeframe
  });

export const useAssetSignals = (symbol: string) =>
  useQuery({ queryKey: keys.assetSignals(symbol), queryFn: () => api.assetSignals(symbol) });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: keys.search(q),
    queryFn: () => api.searchAssets(q),
    enabled: q.trim().length > 0,
  });

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: api.me });

export const useCatalog = () =>
  useQuery({ queryKey: keys.catalog, queryFn: api.catalog, staleTime: Infinity });

export const useSignalEvent = (id: string) =>
  useQuery({ queryKey: keys.event(id), queryFn: () => api.signalEvent(id) });

export const useSignalEvents = (ticker?: string) =>
  useInfiniteQuery({
    queryKey: keys.events(ticker),
    queryFn: ({ pageParam }) => api.signalEvents({ ticker, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: EVENTS_REFRESH_MS,
  });

export function useWatchlistMutations() {
  const qc = useQueryClient();
  const invalidate = (symbol: string) => {
    void qc.invalidateQueries({ queryKey: keys.watchlist });
    void qc.invalidateQueries({ queryKey: keys.asset(symbol) });
    void qc.invalidateQueries({ queryKey: keys.assetSignals(symbol) });
  };
  return {
    add: useMutation({
      mutationFn: api.addToWatchlist,
      onSuccess: (_d, symbol) => invalidate(symbol),
    }),
    remove: useMutation({
      mutationFn: api.removeFromWatchlist,
      onSuccess: (_d, symbol) => invalidate(symbol),
    }),
    setAlerts: useMutation({
      mutationFn: (v: { symbol: string; enabled: boolean }) =>
        api.setTickerAlerts(v.symbol, v.enabled),
      onSuccess: (_d, v) => invalidate(v.symbol),
    }),
  };
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<NotificationSettings>) => api.updateSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}
