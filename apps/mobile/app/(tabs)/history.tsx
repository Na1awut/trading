import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useSignalEvents } from '../../src/api/hooks';
import { SignalEventCard } from '../../src/components/SignalEventCard';
import { Disclaimer, EmptyState, ErrorState, Loading } from '../../src/components/ui';
import { colors, spacing } from '../../src/theme';

export default function HistoryScreen() {
  const router = useRouter();
  const q = useSignalEvents();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <View style={styles.screen}>
      <FlatList
        data={events}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={q.isRefetching && !q.isFetchingNextPage}
            onRefresh={() => void q.refetch()}
            tintColor={colors.textMuted}
          />
        }
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          <EmptyState
            title="No signals yet"
            body="When a signal triggers on one of your watchlist tickers it will appear here with an explanation of why."
          />
        }
        ListFooterComponent={
          q.isFetchingNextPage ? (
            <ActivityIndicator color={colors.textMuted} />
          ) : events.length > 0 ? (
            <Disclaimer />
          ) : null
        }
        renderItem={({ item }) => (
          <SignalEventCard
            event={item}
            currency={item.currency}
            onPress={() => router.push(`/signals/events/${item.id}`)}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.background } });
