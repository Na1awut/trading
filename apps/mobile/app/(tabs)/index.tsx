import Ionicons from '@expo/vector-icons/Ionicons';
import { Link, Stack, useRouter } from 'expo-router';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { WatchlistItem } from '@signals/types';
import { useWatchlist, useWatchlistMutations } from '../../src/api/hooks';
import { Button, ChangePill, EmptyState, ErrorState, Loading } from '../../src/components/ui';
import { formatPct, formatPrice, formatTime } from '../../src/lib/format';
import { colors, spacing } from '../../src/theme';

export default function WatchlistScreen() {
  const router = useRouter();
  const { data, error, isLoading, refetch, isRefetching } = useWatchlist();
  const { remove } = useWatchlistMutations();

  const confirmRemove = (item: WatchlistItem) =>
    Alert.alert(`Remove ${item.symbol}?`, 'Its signals will stop. Signal history is kept.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => remove.mutate(item.symbol) },
    ]);

  const addButton = (
    <Link href="/search" asChild>
      <Pressable
        hitSlop={12}
        accessibilityLabel="Add ticker"
        style={{ paddingHorizontal: spacing.lg }}
      >
        <Ionicons name="add" size={26} color={colors.text} />
      </Pressable>
    </Link>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerRight: () => addButton }} />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <FlatList
          data={data?.items ?? []}
          keyExtractor={(i) => i.symbol}
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, flexGrow: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => void refetch()}
              tintColor={colors.textMuted}
            />
          }
          ListEmptyComponent={
            <EmptyState
              title="Your watchlist is empty"
              body="Add a ticker to track its price and get alerts when technical signals trigger."
              action={<Button title="Add ticker" onPress={() => router.push('/search')} />}
            />
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/asset/${encodeURIComponent(item.symbol)}`)}
              onLongPress={() => confirmRemove(item)}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <Text style={styles.symbol}>{item.symbol}</Text>
                  {!item.alertsEnabled ? (
                    <Ionicons name="notifications-off-outline" size={14} color={colors.textFaint} />
                  ) : null}
                </View>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
              </View>
              {item.quote ? (
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={styles.price}>{formatPrice(item.quote.price, item.currency)}</Text>
                  <ChangePill
                    value={item.quote.changePercent}
                    text={formatPct(item.quote.changePercent)}
                  />
                  <Text style={styles.updated}>
                    {item.quote.delayed ? 'Delayed · ' : ''}
                    {formatTime(item.quote.timestamp)}
                  </Text>
                </View>
              ) : (
                <Text style={styles.updated}>Price unavailable</Text>
              )}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  symbol: { color: colors.text, fontSize: 18, fontWeight: '700' },
  name: { color: colors.textMuted, fontSize: 13, maxWidth: 190 },
  price: { color: colors.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  updated: { color: colors.textFaint, fontSize: 11 },
});
