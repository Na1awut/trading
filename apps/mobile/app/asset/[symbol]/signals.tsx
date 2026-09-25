import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  SIGNAL_CATEGORY_GROUP_LABELS,
  type SignalCategory,
  type SignalDTO,
  type SignalType,
} from '@signals/types';
import { api } from '../../../src/api/client';
import { keys, useAssetSignals } from '../../../src/api/hooks';
import {
  Button,
  Card,
  Chip,
  Disclaimer,
  ErrorState,
  Loading,
  SectionTitle,
} from '../../../src/components/ui';
import { colors, spacing } from '../../../src/theme';

const CATEGORY_ORDER: SignalCategory[] = ['MOVING_AVERAGE', 'MOMENTUM', 'VOLUME', 'PRICE'];

const CUSTOM_TYPES: { type: SignalType; label: string; unit: string; hint: string }[] = [
  { type: 'PRICE_ABOVE', label: 'Price above', unit: '$', hint: 'Candle closes above this price' },
  { type: 'PRICE_BELOW', label: 'Price below', unit: '$', hint: 'Candle closes below this price' },
  {
    type: 'PCT_MOVE_UP',
    label: 'Move up %',
    unit: '%',
    hint: 'Rises at least this % in one candle',
  },
  {
    type: 'PCT_MOVE_DOWN',
    label: 'Move down %',
    unit: '%',
    hint: 'Falls at least this % in one candle',
  },
];

export default function SignalConfigScreen() {
  const { symbol: raw } = useLocalSearchParams<{ symbol: string }>();
  const symbol = decodeURIComponent(raw ?? '').toUpperCase();
  const qc = useQueryClient();
  const { data, error, isLoading, refetch } = useAssetSignals(symbol);
  const [customType, setCustomType] = useState<SignalType>('PRICE_ABOVE');
  const [threshold, setThreshold] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: keys.assetSignals(symbol) });
  const toggle = useMutation({
    mutationFn: (s: { id: string; enabled: boolean }) =>
      api.updateSignal(s.id, { enabled: s.enabled }),
    onSuccess: invalidate,
  });
  const create = useMutation({
    mutationFn: () =>
      api.createSignal({
        ticker: symbol,
        signalType: customType,
        parameters: { threshold: Number(threshold) },
      }),
    onSuccess: () => {
      setThreshold('');
      void invalidate();
    },
    onError: (e) => setFormError(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteSignal(id),
    onSuccess: invalidate,
  });

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const presets = data.signals.filter((s) => s.isPreset);
  const custom = data.signals.filter((s) => !s.isPreset);
  const selected = CUSTOM_TYPES.find((c) => c.type === customType)!;

  const submit = () => {
    setFormError(null);
    const n = Number(threshold);
    if (!threshold || !Number.isFinite(n) || n <= 0) return setFormError('Enter a positive number');
    create.mutate();
  };

  const renderSignal = (s: SignalDTO, deletable: boolean) => (
    <View key={s.id} style={styles.signalRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.signalName}>{s.name}</Text>
        <Text style={styles.signalDesc}>
          {s.timeframe} · {s.description}
        </Text>
      </View>
      {deletable ? (
        <Pressable
          hitSlop={8}
          onPress={() =>
            Alert.alert('Delete alert?', s.name, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => del.mutate(s.id) },
            ])
          }
        >
          <Text style={styles.delete}>Delete</Text>
        </Pressable>
      ) : null}
      <Switch
        value={s.enabled}
        onValueChange={(enabled) => toggle.mutate({ id: s.id, enabled })}
        trackColor={{ true: colors.positive, false: colors.cardRaised }}
      />
    </View>
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: `${symbol} signals` }} />
      <Text style={styles.intro}>
        Signals are evaluated on completed candles and notify you once when the condition becomes
        true.
      </Text>

      {CATEGORY_ORDER.map((cat) => {
        const items = presets.filter((s) => s.category === cat);
        if (items.length === 0) return null;
        return (
          <View key={cat}>
            <SectionTitle>{SIGNAL_CATEGORY_GROUP_LABELS[cat]}</SectionTitle>
            <Card style={{ paddingVertical: spacing.sm }}>
              {items.map((s) => renderSignal(s, false))}
            </Card>
          </View>
        );
      })}

      <SectionTitle>Custom alerts</SectionTitle>
      <Card style={{ gap: spacing.md }}>
        {custom.length > 0 ? <View>{custom.map((s) => renderSignal(s, true))}</View> : null}
        <View style={styles.chips}>
          {CUSTOM_TYPES.map((c) => (
            <Chip
              key={c.type}
              label={c.label}
              selected={c.type === customType}
              onPress={() => setCustomType(c.type)}
            />
          ))}
        </View>
        <Text style={styles.signalDesc}>{selected.hint}</Text>
        <View style={styles.inputRow}>
          <Text style={styles.unit}>{selected.unit}</Text>
          <TextInput
            style={styles.input}
            keyboardType="decimal-pad"
            placeholder={selected.unit === '$' ? '190.00' : '3'}
            placeholderTextColor={colors.textFaint}
            value={threshold}
            onChangeText={setThreshold}
          />
        </View>
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Button title="Create alert" onPress={submit} loading={create.isPending} />
      </Card>
      <Disclaimer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  intro: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  signalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  signalName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  signalDesc: { color: colors.textMuted, fontSize: 12, marginTop: 2, lineHeight: 17 },
  delete: { color: colors.negative, fontSize: 13, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  unit: { color: colors.textMuted, fontSize: 18, width: 20, textAlign: 'center' },
  input: {
    flex: 1,
    backgroundColor: colors.cardRaised,
    color: colors.text,
    fontSize: 16,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  error: { color: colors.negative },
});
