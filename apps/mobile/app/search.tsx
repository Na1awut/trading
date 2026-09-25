import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSearch, useWatchlist, useWatchlistMutations } from '../src/api/hooks';
import { EmptyState, ErrorState } from '../src/components/ui';
import { colors, spacing } from '../src/theme';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function SearchScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 250);
  const search = useSearch(q);
  const watchlist = useWatchlist();
  const { add } = useWatchlistMutations();
  const inList = new Set(watchlist.data?.items.map((i) => i.symbol));

  return (
    <View style={styles.screen}>
      <TextInput
        style={styles.input}
        placeholder="Search ticker or company (e.g. NVDA)"
        placeholderTextColor={colors.textFaint}
        autoFocus
        autoCapitalize="characters"
        autoCorrect={false}
        value={query}
        onChangeText={setQuery}
      />
      {search.error ? (
        <ErrorState error={search.error} />
      ) : (
        <FlatList
          data={search.data?.results ?? []}
          keyExtractor={(a) => a.symbol}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.xl }}
          ListEmptyComponent={
            q && !search.isFetching ? (
              <EmptyState title="No matches" body={`Nothing found for "${q}"`} />
            ) : null
          }
          renderItem={({ item }) => {
            const added = inList.has(item.symbol);
            const adding = add.isPending && add.variables === item.symbol;
            return (
              <Pressable
                style={styles.row}
                onPress={() => router.push(`/asset/${encodeURIComponent(item.symbol)}`)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.symbol}>{item.symbol}</Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {item.name} · {item.exchange} · {item.assetClass}
                  </Text>
                </View>
                <Pressable
                  disabled={added || adding}
                  onPress={() => add.mutate(item.symbol)}
                  style={[styles.addBtn, added && { backgroundColor: colors.cardRaised }]}
                  hitSlop={8}
                >
                  <Text style={[styles.addText, added && { color: colors.textMuted }]}>
                    {added ? 'Added' : adding ? 'Adding…' : 'Add'}
                  </Text>
                </Pressable>
              </Pressable>
            );
          }}
        />
      )}
      {add.error ? <Text style={styles.error}>{add.error.message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md },
  input: {
    backgroundColor: colors.card,
    borderRadius: 10,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.md,
  },
  symbol: { color: colors.text, fontSize: 16, fontWeight: '700' },
  meta: { color: colors.textMuted, fontSize: 12 },
  addBtn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  addText: { color: colors.text, fontWeight: '600' },
  error: { color: colors.negative },
});
