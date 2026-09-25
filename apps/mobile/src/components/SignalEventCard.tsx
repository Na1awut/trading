import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SIGNAL_CATEGORY_LABELS, type SignalEventDTO } from '@signals/types';
import { formatDateTime, formatNumber, formatPrice } from '../lib/format';
import { colors, spacing } from '../theme';

const CATEGORY_COLOR: Record<SignalEventDTO['category'], string> = {
  PRICE: '#60A5FA',
  MOVING_AVERAGE: '#A78BFA',
  MOMENTUM: '#F59E0B',
  VOLUME: '#2DD4BF',
};

/**
 * Explains WHY a signal fired - category, plain-language message and the key numbers -
 * instead of a bare "BUY"/"SELL".
 */
export function SignalEventCard({
  event,
  showTicker = true,
  onPress,
  currency = 'USD',
}: {
  event: SignalEventDTO;
  showTicker?: boolean;
  onPress?: () => void;
  currency?: string;
}) {
  const v = event.values;
  const facts: { label: string; value: string }[] = [
    { label: 'Price', value: formatPrice(event.price, currency) },
  ];
  if (v.rsi14 !== undefined && v.rsi14 !== null)
    facts.push({ label: 'RSI', value: formatNumber(v.rsi14, 1) });
  if (v.volumeRatio !== undefined && v.volumeRatio !== null)
    facts.push({ label: 'Volume', value: `${formatNumber(v.volumeRatio, 1)}x avg` });

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.header}>
        <View style={[styles.dot, { backgroundColor: CATEGORY_COLOR[event.category] }]} />
        <Text style={styles.category}>{SIGNAL_CATEGORY_LABELS[event.category]}</Text>
        {showTicker ? <Text style={styles.ticker}>{event.ticker}</Text> : null}
        <Text style={styles.timeframe}>{event.timeframe}</Text>
        <Text style={styles.time}>{formatDateTime(event.triggeredAt)}</Text>
      </View>
      <Text style={styles.message}>{event.message}</Text>
      <View style={styles.facts}>
        {facts.map((f) => (
          <View key={f.label} style={styles.fact}>
            <Text style={styles.factLabel}>{f.label}</Text>
            <Text style={styles.factValue}>{f.value}</Text>
          </View>
        ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  category: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  ticker: { color: colors.text, fontSize: 13, fontWeight: '700' },
  timeframe: { color: colors.textFaint, fontSize: 12 },
  time: {
    color: colors.textMuted,
    fontSize: 12,
    marginLeft: 'auto',
    fontVariant: ['tabular-nums'],
  },
  message: { color: colors.text, fontSize: 16, fontWeight: '600', lineHeight: 22 },
  facts: { flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap' },
  fact: { gap: 2 },
  factLabel: {
    color: colors.textFaint,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  factValue: { color: colors.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
