import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { DataFreshness, SignalStrength } from '@signals/types';
import { colors, spacing } from '../theme';

/** Grey placeholder block with a subtle pulse (single, cheap animation). */
export function Skeleton({
  width,
  height = 14,
  style,
}: {
  width: number | `${number}%`;
  height?: number;
  style?: ViewStyle;
}) {
  const opacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[
        { width, height, borderRadius: 6, backgroundColor: colors.cardRaised, opacity },
        style,
      ]}
    />
  );
}

export function WatchlistSkeleton() {
  return (
    <View style={{ padding: spacing.lg, gap: spacing.sm }} accessibilityLabel="Loading watchlist">
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={skeletonStyles.row}>
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width={70} height={18} />
            <Skeleton width={140} height={12} />
          </View>
          <View style={{ alignItems: 'flex-end', gap: 8 }}>
            <Skeleton width={90} height={18} />
            <Skeleton width={60} height={16} />
          </View>
        </View>
      ))}
    </View>
  );
}

export function DetailSkeleton() {
  return (
    <View style={{ padding: spacing.lg, gap: spacing.md }} accessibilityLabel="Loading">
      <Skeleton width={180} height={20} />
      <Skeleton width={220} height={40} />
      <Skeleton width="100%" height={46} />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} width="100%" height={16} />
      ))}
    </View>
  );
}

function Pill({ text, color, bg }: { text: string; color: string; bg: string }) {
  return (
    <View style={[badgeStyles.pill, { backgroundColor: bg }]}>
      <Text style={[badgeStyles.text, { color }]}>{text}</Text>
    </View>
  );
}

/** Stale / delayed / market-closed indicator. Renders nothing when data is fresh and live. */
export function DataStatusBadge({
  status,
  delayed,
}: {
  status: DataFreshness | null | undefined;
  delayed?: boolean;
}) {
  if (status?.stale) return <Pill text="Stale" color={colors.warning} bg="rgba(245,158,11,0.14)" />;
  if (status?.marketOpen === false)
    return <Pill text="Market closed" color={colors.textMuted} bg={colors.cardRaised} />;
  if (delayed) return <Pill text="Delayed" color={colors.textMuted} bg={colors.cardRaised} />;
  return null;
}

const STRENGTH_COLOR: Record<SignalStrength, string> = {
  LOW: colors.textMuted,
  MEDIUM: '#60A5FA',
  HIGH: '#A78BFA',
};

/**
 * Informational: how many technical conditions agree. Deliberately neutral colours and
 * wording - it is not a rating or a recommendation.
 */
export function StrengthBadge({
  level,
  score,
  max,
}: {
  level: SignalStrength | null;
  score: number | null;
  max: number | null;
}) {
  if (!level) return null;
  const detail = score !== null && max !== null ? ` · ${score} of ${max} conditions agree` : '';
  return <Pill text={`${level}${detail}`} color={STRENGTH_COLOR[level]} bg={colors.cardRaised} />;
}

const skeletonStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
});

const badgeStyles = StyleSheet.create({
  pill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, alignSelf: 'flex-start' },
  text: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
});
