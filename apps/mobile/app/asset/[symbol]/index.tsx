import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { TIMEFRAMES, type Timeframe } from '@signals/types';
import {
  ASSET_REFRESH_MS,
  useAsset,
  useWatchlist,
  useWatchlistMutations,
} from '../../../src/api/hooks';
import { DataStatusBadge, DetailSkeleton } from '../../../src/components/badges';
import { SignalEventCard } from '../../../src/components/SignalEventCard';
import {
  Button,
  Card,
  ChangePill,
  Chip,
  Disclaimer,
  ErrorState,
  RefreshStatusBanner,
  Row,
  SectionTitle,
} from '../../../src/components/ui';
import {
  formatChange,
  formatCompact,
  formatDateTime,
  formatNumber,
  formatPct,
  formatPrice,
  formatTime,
} from '../../../src/lib/format';
import { colors, spacing } from '../../../src/theme';

function rsiHint(rsi: number | null): { hint?: string; color?: string } {
  if (rsi === null) return {};
  if (rsi >= 70) return { hint: 'Above 70 - often described as overbought', color: colors.warning };
  if (rsi <= 30) return { hint: 'Below 30 - often described as oversold', color: colors.warning };
  return {};
}

export default function AssetDetailScreen() {
  const { symbol: raw } = useLocalSearchParams<{ symbol: string }>();
  const symbol = decodeURIComponent(raw ?? '').toUpperCase();
  const router = useRouter();
  const [timeframe, setTimeframe] = useState<Timeframe | undefined>(undefined);
  const assetQuery = useAsset(symbol, timeframe);
  const { data, error, isLoading, refetch, isRefetching, isFetching } = assetQuery;
  const watchlist = useWatchlist();
  const { add, remove, setAlerts } = useWatchlistMutations();
  const item = watchlist.data?.items.find((i) => i.symbol === symbol);

  if (isLoading) return <DetailSkeleton />;
  // Old data stays visible after a failed refresh, labelled by RefreshStatusBanner.
  if (!data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const { asset, quote, indicators: ind, dataStatus } = data;
  const currency = asset.currency;
  const up = quote.change >= 0;
  const rsi = rsiHint(ind.rsi14);
  const activeTf = timeframe ?? data.timeframe;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={() => void refetch()}
          tintColor={colors.textMuted}
        />
      }
    >
      <Stack.Screen options={{ title: asset.symbol }} />
      <RefreshStatusBanner
        query={assetQuery}
        intervalMs={ASSET_REFRESH_MS}
        onRetry={() => void refetch()}
      />
      <Text style={styles.name}>{asset.name}</Text>
      <Text style={styles.meta}>
        {asset.exchange} · {asset.assetClass} · {asset.currency}
      </Text>

      <View style={styles.priceRow}>
        <Text style={styles.price}>{formatPrice(quote.price, currency)}</Text>
        <ChangePill value={quote.changePercent} text={formatPct(quote.changePercent)} />
      </View>
      <Text style={[styles.change, { color: up ? colors.positive : colors.negative }]}>
        {formatChange(quote.change, quote.price, currency)} today
      </Text>
      <View style={styles.statusRow}>
        <DataStatusBadge status={dataStatus.quote} delayed={quote.delayed} />
        <Text style={styles.timestamp}>
          Updated {formatDateTime(quote.timestamp)} · source: {quote.source}
        </Text>
      </View>
      {dataStatus.quote.stale && dataStatus.quote.reason ? (
        <Text style={styles.staleNote}>Price may be out of date: {dataStatus.quote.reason}.</Text>
      ) : null}

      <View style={styles.actions}>
        <View style={{ flex: 1 }}>
          {data.inWatchlist ? (
            <Button
              title="Configure signals"
              onPress={() => router.push(`/asset/${encodeURIComponent(symbol)}/signals`)}
            />
          ) : (
            <Button
              title="Add to watchlist"
              onPress={() => add.mutate(symbol)}
              loading={add.isPending}
            />
          )}
        </View>
      </View>

      <SectionTitle
        right={
          isFetching && !isRefetching ? <Text style={styles.footnote}>Loading…</Text> : undefined
        }
      >
        Indicators
      </SectionTitle>
      <View style={styles.chips} accessibilityRole="tablist">
        {TIMEFRAMES.map((tf) => (
          <Chip key={tf} label={tf} selected={tf === activeTf} onPress={() => setTimeframe(tf)} />
        ))}
      </View>
      <Card>
        <Row label="EMA 9" value={formatPrice(ind.ema9, currency)} />
        <Row label="EMA 21" value={formatPrice(ind.ema21, currency)} />
        <Row label="EMA 20" value={formatPrice(ind.ema20, currency)} />
        <Row label="EMA 50" value={formatPrice(ind.ema50, currency)} />
        <Row
          label="RSI 14"
          value={formatNumber(ind.rsi14, 1)}
          hint={rsi.hint}
          valueColor={rsi.color}
        />
        <Row label="MACD (12,26,9)" value={formatNumber(ind.macd, 3)} />
        <Row label="MACD signal" value={formatNumber(ind.macdSignal, 3)} />
        <Row
          label="MACD histogram"
          value={formatNumber(ind.macdHistogram, 3)}
          valueColor={
            ind.macdHistogram === null
              ? undefined
              : ind.macdHistogram >= 0
                ? colors.positive
                : colors.negative
          }
        />
        <Row label="Volume" value={formatCompact(ind.volume)} />
        <Row
          label="Avg volume (20)"
          value={formatCompact(ind.avgVolume20)}
          hint={
            ind.volumeRatio !== null
              ? `Last candle: ${formatNumber(ind.volumeRatio, 2)}x average`
              : undefined
          }
        />
      </Card>
      <View style={styles.statusRow}>
        <DataStatusBadge status={dataStatus.candles} />
        <Text style={styles.footnote}>
          Calculated on completed {activeTf} candles
          {data.indicatorsAsOf ? ` · last candle opened ${formatTime(data.indicatorsAsOf)}` : ''}.
        </Text>
      </View>

      <SectionTitle>Recent signals</SectionTitle>
      {data.recentEvents.length === 0 ? (
        <Card>
          <Text style={styles.empty}>No signals yet for {symbol}.</Text>
        </Card>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {data.recentEvents.map((e) => (
            <SignalEventCard
              key={e.id}
              event={e}
              showTicker={false}
              currency={currency}
              onPress={() => router.push(`/signals/events/${e.id}`)}
            />
          ))}
        </View>
      )}

      {data.inWatchlist ? (
        <>
          <SectionTitle>Watchlist</SectionTitle>
          <Card>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchLabel}>Alerts for {symbol}</Text>
                <Text style={styles.switchHint}>
                  Push notifications for all of this ticker's signals
                </Text>
              </View>
              <Switch
                value={item?.alertsEnabled ?? true}
                onValueChange={(enabled) => setAlerts.mutate({ symbol, enabled })}
                trackColor={{ true: colors.positive, false: colors.cardRaised }}
              />
            </View>
          </Card>
          <View style={{ marginTop: spacing.md }}>
            <Button
              title="Remove from watchlist"
              variant="danger"
              loading={remove.isPending}
              onPress={() => remove.mutate(symbol, { onSuccess: () => router.back() })}
            />
          </View>
        </>
      ) : null}
      <Disclaimer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  name: { color: colors.text, fontSize: 20, fontWeight: '700' },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
  price: { color: colors.text, fontSize: 36, fontWeight: '800', fontVariant: ['tabular-nums'] },
  change: { fontSize: 15, fontWeight: '600', marginTop: 2 },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  },
  timestamp: { color: colors.textFaint, fontSize: 12 },
  staleNote: { color: colors.warning, fontSize: 12, marginTop: 4 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  chips: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  footnote: { color: colors.textFaint, fontSize: 11 },
  empty: { color: colors.textMuted },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  switchHint: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
});
