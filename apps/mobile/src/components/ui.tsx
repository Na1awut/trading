import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { DISCLAIMER } from '@signals/types';
import { formatDateTime } from '../lib/format';
import { colors, spacing } from '../theme';

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {right}
    </View>
  );
}

export function ChangePill({ value, text }: { value: number | null | undefined; text: string }) {
  const up = (value ?? 0) >= 0;
  return (
    <View style={[styles.pill, { backgroundColor: up ? colors.positiveBg : colors.negativeBg }]}>
      <Text style={[styles.pillText, { color: up ? colors.positive : colors.negative }]}>
        {text}
      </Text>
    </View>
  );
}

export function Row({
  label,
  value,
  hint,
  valueColor,
}: {
  label: string;
  value: string;
  hint?: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={{ flexShrink: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Text style={[styles.rowValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
}) {
  const bg =
    variant === 'primary'
      ? colors.accent
      : variant === 'danger'
        ? colors.negativeBg
        : colors.cardRaised;
  const fg = variant === 'danger' ? colors.negative : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        selected ? { backgroundColor: colors.accent, borderColor: colors.accent } : null,
      ]}
    >
      <Text style={[styles.chipText, selected ? { color: colors.text } : null]}>{label}</Text>
    </Pressable>
  );
}

export function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.textMuted} />
    </View>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <View style={styles.center}>
      <Text style={styles.errorText}>
        {error instanceof Error ? error.message : 'Something went wrong'}
      </Text>
      {onRetry ? <Button title="Retry" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
      {action}
    </View>
  );
}

export function Disclaimer() {
  return <Text style={styles.disclaimer}>{DISCLAIMER}</Text>;
}

export const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: 'rgba(245,158,11,0.14)',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bannerText: { color: colors.warning, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  bannerAction: { color: colors.text, fontSize: 13, fontWeight: '700' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: 'flex-end' },
  pillText: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 7,
    gap: spacing.md,
  },
  rowLabel: { color: colors.textMuted, fontSize: 15 },
  rowHint: { color: colors.textFaint, fontSize: 12, marginTop: 2 },
  rowValue: { color: colors.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  button: {
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  errorText: { color: colors.negative, textAlign: 'center', fontSize: 15 },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  emptyBody: { color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  disclaimer: {
    color: colors.textFaint,
    fontSize: 11,
    lineHeight: 16,
    marginTop: spacing.xl,
    textAlign: 'center',
  },
});

/** The subset of a React Query result the banner needs. */
export interface RefreshState {
  data: unknown;
  dataUpdatedAt: number;
  isRefetchError: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
}

/**
 * Shown above data that may no longer be current: the last refresh failed, the device is
 * offline, or nothing has refreshed for 3 polling intervals (e.g. timers paused in the
 * background). The data stays visible, always labelled with the time it is from.
 */
export function RefreshStatusBanner({
  query,
  intervalMs,
  onRetry,
}: {
  query: RefreshState;
  intervalMs: number;
  onRetry?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  if (!query.data || !query.dataUpdatedAt) return null;
  const since = formatDateTime(new Date(query.dataUpdatedAt).toISOString());
  let text: string | null = null;
  if (query.fetchStatus === 'paused') text = `Offline · showing data from ${since}`;
  else if (query.isRefetchError) text = `Couldn't refresh · showing data from ${since}`;
  else if (now - query.dataUpdatedAt > 3 * intervalMs && query.fetchStatus !== 'fetching')
    text = `Not updated since ${since}`;
  if (!text) return null;
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.bannerText}>{text}</Text>
      {onRetry ? (
        <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.bannerAction}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
