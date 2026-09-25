import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import {
  SIGNAL_CATEGORIES,
  SIGNAL_CATEGORY_GROUP_LABELS,
  type SignalCategory,
} from '@signals/types';
import { API_URL, api } from '../../src/api/client';
import { useMe, useUpdateSettings } from '../../src/api/hooks';
import { useAuth } from '../../src/auth/AuthContext';
import { registerForPush } from '../../src/notifications/push';
import {
  Button,
  Card,
  Disclaimer,
  ErrorState,
  Loading,
  Row,
  SectionTitle,
} from '../../src/components/ui';
import { colors, spacing } from '../../src/theme';

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.toggleLabel, disabled && { color: colors.textFaint }]}>{label}</Text>
        {hint ? <Text style={styles.toggleHint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: colors.positive, false: colors.cardRaised }}
      />
    </View>
  );
}

export default function SettingsScreen() {
  const { email, mode, signOut } = useAuth();
  const me = useMe();
  const update = useUpdateSettings();
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me.isLoading) return <Loading />;
  if (me.error || !me.data)
    return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  const s = me.data.settings;

  const toggleCategory = (cat: SignalCategory, on: boolean) => {
    const set = new Set(s.disabledCategories);
    if (on) set.delete(cat);
    else set.add(cat);
    update.mutate({ disabledCategories: [...set] });
  };

  const testPush = async () => {
    setBusy(true);
    setPushMsg(null);
    try {
      const reg = await registerForPush();
      if (reg.status === 'unsupported')
        setPushMsg('Push needs a physical device with a development build (not Expo Go).');
      else if (reg.status === 'denied') setPushMsg('Notifications are blocked in system settings.');
      else if (reg.status === 'error') setPushMsg(`Registration failed: ${reg.error}`);
      const r = await api.sendTestNotification();
      setPushMsg((m) => m ?? `Sent to ${r.delivered} of ${r.devices} device(s).`);
    } catch (e) {
      setPushMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
    >
      <SectionTitle>Notifications</SectionTitle>
      <Card>
        <ToggleRow
          label="Signal alerts"
          hint="Master switch. Signals are still recorded in history when off."
          value={s.alertsEnabled}
          onChange={(v) => update.mutate({ alertsEnabled: v })}
        />
      </Card>

      <SectionTitle>Indicator types</SectionTitle>
      <Card>
        {SIGNAL_CATEGORIES.map((cat) => (
          <ToggleRow
            key={cat}
            label={SIGNAL_CATEGORY_GROUP_LABELS[cat]}
            value={!s.disabledCategories.includes(cat)}
            onChange={(on) => toggleCategory(cat, on)}
            disabled={!s.alertsEnabled}
          />
        ))}
        <Text style={styles.note}>
          Per-ticker and per-signal switches are on each asset's Signals screen.
        </Text>
      </Card>

      <SectionTitle>Coming soon</SectionTitle>
      <Card>
        <Row label="Timezone" value={s.timezone} />
        <Row
          label="Quiet hours"
          value={
            s.quietHoursStart && s.quietHoursEnd ? `${s.quietHoursStart}–${s.quietHoursEnd}` : 'Off'
          }
        />
        <Row
          label="Frequency"
          value={s.notificationFrequency === 'REALTIME' ? 'Real-time' : s.notificationFrequency}
        />
      </Card>

      <SectionTitle>Push</SectionTitle>
      <Card style={{ gap: spacing.md }}>
        <Button
          title="Send test notification"
          variant="secondary"
          onPress={() => void testPush()}
          loading={busy}
        />
        {pushMsg ? <Text style={styles.note}>{pushMsg}</Text> : null}
      </Card>

      <SectionTitle>Account</SectionTitle>
      <Card style={{ gap: spacing.md }}>
        <Row label="Signed in as" value={email ?? '—'} />
        <Row label="Auth" value={mode === 'firebase' ? 'Firebase' : 'Dev login'} />
        <Row label="Server" value={API_URL.replace(/^https?:\/\//, '')} />
        <Button title="Sign out" variant="danger" onPress={() => void signOut()} />
      </Card>
      <Disclaimer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  toggleLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  toggleHint: { color: colors.textMuted, fontSize: 12, marginTop: 2, lineHeight: 17 },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
});
