import { Redirect } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { API_URL } from '../src/api/client';
import { useAuth } from '../src/auth/AuthContext';
import { Button, Disclaimer } from '../src/components/ui';
import { colors, spacing } from '../src/theme';

export default function LoginScreen() {
  const { status, mode, signIn, signUp } = useAuth();
  const [email, setEmail] = useState(mode === 'dev' ? 'demo@example.com' : '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'signedIn') return <Redirect href="/" />;

  const submit = async (action: 'in' | 'up') => {
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError('Enter a valid email address');
    if (mode === 'firebase' && password.length < 6)
      return setError('Password must be at least 6 characters');
    setBusy(true);
    try {
      await (action === 'in' ? signIn(email, password) : signUp(email, password));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace('Firebase: ', '') : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
    >
      <View style={styles.inner}>
        <Text style={styles.logo}>Signal Alerts</Text>
        <Text style={styles.tagline}>Technical signals for your watchlist, explained.</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        {mode === 'firebase' ? (
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={colors.textFaint}
            secureTextEntry
            autoComplete="password"
            value={password}
            onChangeText={setPassword}
          />
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Button title="Sign in" onPress={() => void submit('in')} loading={busy} />
        {mode === 'firebase' ? (
          <Button
            title="Create account"
            variant="secondary"
            onPress={() => void submit('up')}
            disabled={busy}
          />
        ) : (
          <Text style={styles.devNote}>
            Dev login (no Firebase configured): any email works with an API running AUTH_MODE=dev.
            {'\n'}
            API: {API_URL}
          </Text>
        )}
        <Disclaimer />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  inner: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  logo: { color: colors.text, fontSize: 32, fontWeight: '800' },
  tagline: { color: colors.textMuted, fontSize: 15, marginBottom: spacing.lg },
  input: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
  },
  error: { color: colors.negative },
  devNote: { color: colors.textFaint, fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
