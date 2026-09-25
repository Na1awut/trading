import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import {
  SIGNAL_CATEGORIES,
  SIGNAL_CATEGORY_GROUP_LABELS,
  SIGNAL_STRENGTHS,
  type SignalCategory,
} from '@signals/types';
import { API_URL, api } from '../../src/api/client';
import { useMe, useUpdateSettings } from '../../src/api/hooks';
import { useAuth } from '../../src/auth/AuthContext';
import { registerForPush } from '../../src/notifications/push';
import {
  Button,
  Card,
  Chip,
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

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function QuietHoursCard({
  start,
  end,
  timezone,
  saving,
  onSave,
}: {
  start: string | null;
  end: string | null;
  timezone: string;
  saving: boolean;
  onSave: (patch: {
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
    timezone?: string;
  }) => void;
}) {
  const [from, setFrom] = useState(start ?? '22:00');
  const [to, setTo] = useState(end ?? '07:00');
  const [error, setError] = useState<string | null>(null);
  const enabled = Boolean(start && end && start !== end);
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const save = (on: boolean) => {
    setError(null);
    if (!on) return onSave({ quietHoursStart: null, quietHoursEnd: null });
    if (!HHMM.test(from) || !HHMM.test(to)) return setError('Use 24-hour HH:mm, e.g. 22:00');
    if (from === to) return setError('Start and end must differ');
    onSave({ quietHoursStart: from, quietHoursEnd: to });
  };

  return (
    <Card style={{ gap: spacing.md }}>
      <ToggleRow
        label="Pause notifications at night"
        hint="Signals are still recorded; their notifications are delivered when quiet hours end."
        value={enabled}
        onChange={save}
      />
      <View style={styles.timeRow}>
        <TextInput
          style={styles.timeInput}
          value={from}
          onChangeText={setFrom}
          placeholder="22:00"
          placeholderTextColor={colors.textFaint}
          maxLength={5}
        />
        <Text style={styles.note}>to</Text>
        <TextInput
          style={styles.timeInput}
          value={to}
          onChangeText={setTo}
          placeholder="07:00"
          placeholderTextColor={colors.textFaint}
          maxLength={5}
        />
        <Button title="Save" variant="secondary" onPress={() => save(true)} loading={saving} />
      </View>
      {error ? <Text style={{ color: colors.negative }}>{error}</Text> : null}
      <Row label="Timezone" value={timezone} />
      {deviceTz && deviceTz !== timezone ? (
        <Button
          title={`Use this device's timezone (${deviceTz})`}
          variant="secondary"
          onPress={() => onSave({ timezone: deviceTz })}
        />
      ) : null}
    </Card>
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

      <SectionTitle>Quiet hours</SectionTitle>
      <QuietHoursCard
        start={s.quietHoursStart}
        end={s.quietHoursEnd}
        timezone={s.timezone}
        saving={update.isPending}
        onSave={(patch) => update.mutate(patch)}
      />

      <SectionTitle>Minimum signal strength</SectionTitle>
      <Card>
        <View style={styles.chips}>
          {SIGNAL_STRENGTHS.map((level) => (
            <Chip
              key={level}
              label={level}
              selected={s.minimumSignalStrength === level}
              onPress={() => update.mutate({ minimumSignalStrength: level })}
            />
          ))}
        </View>
        <Text style={styles.note}>
          Strength counts how many technical conditions agree (e.g. volume and trend confirming a
          crossover). LOW notifies for every signal. Muted signals still appear in History. It is
          not a measure of expected return.
        </Text>
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
  chips: { flexDirection: 'row', gap: spacing.sm },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  timeInput: {
    backgroundColor: colors.cardRaised,
    color: colors.text,
    fontSize: 16,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    width: 76,
    textAlign: 'center',
  },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
});
