import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SIGNAL_CATEGORY_LABELS, type SignalEvidence, type SignalValues } from '@signals/types';
import { useCatalog, useSignalEvent } from '../../../src/api/hooks';
import { DetailSkeleton, StrengthBadge } from '../../../src/components/badges';
import {
  Button,
  Card,
  Disclaimer,
  ErrorState,
  Row,
  SectionTitle,
} from '../../../src/components/ui';
import {
  formatDateTime,
  formatPrice,
  formatTime,
  formatTimeSeconds,
  formatValue,
  valueLabel,
} from '../../../src/lib/format';
import { colors, spacing } from '../../../src/theme';

const DELIVERY: Record<string, string> = {
  SENT: 'Push notification sent',
  SENDING: 'Sending…',
  PENDING: 'Notification pending',
  FAILED: 'Push delivery failed',
  SUPPRESSED: 'Recorded; notification muted by your settings',
  NO_DEVICES: 'Recorded; no device registered for push',
};

/** Parameter-like keys shown once under "Parameters", not per candle. */
const PARAM_KEYS = new Set(['threshold', 'level', 'multiplier']);

function ruleValues(v: SignalValues): [string, number | null][] {
  return Object.entries(v)
    .filter(([k]) => !PARAM_KEYS.has(k) && k !== 'close')
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
}

function CandleCard({
  title,
  candle,
  values,
  currency,
}: {
  title: string;
  candle: SignalEvidence['candle'] | null;
  values: SignalValues;
  currency: string;
}) {
  return (
    <>
      <SectionTitle>
        {title}
        {candle ? ` · ${formatTime(candle.timestamp)}` : ''}
      </SectionTitle>
      <Card>
        {ruleValues(values).map(([k, v]) => (
          <Row key={k} label={valueLabel(k)} value={formatValue(k, v, currency)} />
        ))}
        {candle ? <Row label="Close" value={formatPrice(candle.close, currency)} /> : null}
      </Card>
    </>
  );
}

export default function EventDetailScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const router = useRouter();
  const { data: e, error, isLoading, refetch } = useSignalEvent(eventId ?? '');
  const catalog = useCatalog();
  if (isLoading) return <DetailSkeleton />;
  if (error || !e) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const description = catalog.data?.catalog.find((c) => c.signalType === e.signalType)?.description;
  const ev = e.evidence;
  const currency = e.currency;
  const params = ev
    ? Object.entries(ev.parameters)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')
    : null;

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
      <View style={{ marginTop: spacing.sm }}>
        <StrengthBadge level={e.signalStrength} score={e.signalScore} max={e.maxSignalScore} />
      </View>

      {ev ? (
        <>
          <CandleCard
            title="Previous candle"
            candle={ev.previousCandle}
            values={ev.previous}
            currency={currency}
          />
          <CandleCard
            title="Current candle"
            candle={ev.candle}
            values={ev.current}
            currency={currency}
          />
        </>
      ) : null}

      <SectionTitle>Details</SectionTitle>
      <Card>
        <Row label="Price" value={formatPrice(e.price, currency)} />
        <Row label="Timeframe" value={e.timeframe} />
        <Row
          label="Candle opened"
          value={formatDateTime(e.candleTime)}
          hint="Completed candle the signal was evaluated on"
        />
        <Row
          label="Triggered"
          value={formatTimeSeconds(e.triggeredAt)}
          hint={formatDateTime(e.triggeredAt)}
        />
        {params ? <Row label="Parameters" value={params} /> : null}
      </Card>

      {ev ? (
        <>
          <SectionTitle>Context at trigger</SectionTitle>
          <Card>
            {Object.entries(ev.context)
              .filter(([k]) => k !== 'close')
              .map(([k, v]) => (
                <Row key={k} label={valueLabel(k)} value={formatValue(k, v, currency)} />
              ))}
          </Card>
        </>
      ) : (
        <>
          <SectionTitle>Indicator values at trigger</SectionTitle>
          <Card>
            {Object.entries(e.values).map(([k, v]) => (
              <Row key={k} label={valueLabel(k)} value={formatValue(k, v, currency)} />
            ))}
          </Card>
        </>
      )}

      {ev?.strength ? (
        <>
          <SectionTitle>Condition agreement</SectionTitle>
          <Card>
            {ev.strength.components.map((c) => (
              <View key={c.name} style={styles.component}>
                <Text
                  style={[
                    styles.componentMark,
                    { color: c.met ? colors.positive : colors.textFaint },
                  ]}
                >
                  {c.met ? '✓' : '–'}
                </Text>
                <Text style={styles.componentText}>{c.detail}</Text>
              </View>
            ))}
            <Text style={styles.note}>
              Counts how many configured technical conditions agree at this candle. It is not a
              forecast, a probability or a recommendation.
            </Text>
          </Card>
        </>
      ) : null}

      {description ? (
        <>
          <SectionTitle>What this signal measures</SectionTitle>
          <Card>
            <Text style={styles.body}>{description}</Text>
          </Card>
        </>
      ) : null}

      <Text style={styles.notice}>
        This is an automatically detected technical condition, not investment advice.
      </Text>
      <Text style={styles.delivery}>
        {DELIVERY[e.notificationStatus]}
        {e.nextNotificationAttemptAt &&
        (e.notificationStatus === 'PENDING' || e.notificationStatus === 'FAILED')
          ? ` · next attempt ${formatDateTime(e.nextNotificationAttemptAt)}`
          : ''}
      </Text>
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
  component: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 5 },
  componentMark: { width: 16, fontSize: 15, fontWeight: '700' },
  componentText: { color: colors.text, fontSize: 14, flex: 1, lineHeight: 19 },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  notice: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: spacing.xl },
  delivery: {
    color: colors.textFaint,
    fontSize: 12,
    marginVertical: spacing.md,
    textAlign: 'center',
  },
});
