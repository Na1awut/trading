import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SIGNAL_CATEGORY_LABELS } from '@signals/types';
import { useCatalog, useSignalEvent } from '../../../src/api/hooks';
import {
  Button,
  Card,
  Disclaimer,
  ErrorState,
  Loading,
  Row,
  SectionTitle,
} from '../../../src/components/ui';
import { formatDateTime, formatPrice, formatValue, valueLabel } from '../../../src/lib/format';
import { colors, spacing } from '../../../src/theme';

const DELIVERY: Record<string, string> = {
  SENT: 'Push notification sent',
  SUPPRESSED: 'Recorded; notification muted by your settings',
  NO_DEVICES: 'Recorded; no device registered for push',
  FAILED: 'Recorded; push delivery failed',
  PENDING: 'Delivery pending',
  SENDING: 'Sending…',
};

// Context values shown first, in this order; the rest follow.
const ORDER = ['close', 'rsi14', 'volume', 'avgVolume20', 'volumeRatio'];

export default function EventDetailScreen() {
  const { eventId: id } = useLocalSearchParams<{ eventId: string }>();
  const router = useRouter();
  const { data: e, error, isLoading, refetch } = useSignalEvent(id ?? '');
  const catalog = useCatalog();
  if (isLoading) return <Loading />;
  if (error || !e) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const description = catalog.data?.catalog.find((c) => c.signalType === e.signalType)?.description;
  // Rule-specific values (e.g. EMA 9, EMA 21) first, then the standard context values.
  const rank = (k: string) => ORDER.indexOf(k);
  const entries = Object.entries(e.values).sort(
    ([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }),
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
    >
      <Text style={styles.category}>{SIGNAL_CATEGORY_LABELS[e.category]}</Text>
      <Text style={styles.title}>
        {e.ticker} — {e.name}
      </Text>
      <Text style={styles.message}>{e.message}</Text>

      <SectionTitle>What happened</SectionTitle>
      <Card>
        <Row label="Price" value={formatPrice(e.price)} />
        <Row label="Timeframe" value={e.timeframe} />
        <Row
          label="Candle"
          value={formatDateTime(e.candleTime)}
          hint="Open time of the completed candle"
        />
        <Row label="Triggered" value={formatDateTime(e.triggeredAt)} />
      </Card>

      <SectionTitle>Indicator values at trigger</SectionTitle>
      <Card>
        {entries.map(([k, v]) => (
          <Row key={k} label={valueLabel(k)} value={formatValue(k, v)} />
        ))}
      </Card>

      {description ? (
        <>
          <SectionTitle>What this signal measures</SectionTitle>
          <Card>
            <Text style={styles.body}>{description}</Text>
            <Text style={[styles.body, { marginTop: spacing.sm, color: colors.textMuted }]}>
              A signal describes what the indicators did. It is not a prediction or a
              recommendation.
            </Text>
          </Card>
        </>
      ) : null}

      <Text style={styles.delivery}>{DELIVERY[e.notificationStatus]}</Text>
      <Button
        title={`Open ${e.ticker}`}
        variant="secondary"
        onPress={() => router.push(`/asset/${encodeURIComponent(e.ticker)}`)}
      />
      <Disclaimer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  category: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 4 },
  message: { color: colors.text, fontSize: 17, lineHeight: 24, marginTop: spacing.sm },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  delivery: {
    color: colors.textFaint,
    fontSize: 12,
    marginVertical: spacing.lg,
    textAlign: 'center',
  },
});
