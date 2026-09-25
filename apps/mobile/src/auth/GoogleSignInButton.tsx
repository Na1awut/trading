import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Button } from '../components/ui';
import { colors } from '../theme';
import { useAuth } from './AuthContext';
import { firebaseConfigured } from './firebase';

WebBrowser.maybeCompleteAuthSession();

/** OAuth client IDs from Google Cloud console (Firebase > Authentication > Google). */
const clientIds = {
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
};

export const googleSignInConfigured = firebaseConfigured && Boolean(clientIds.webClientId);

/**
 * Google sign-in: expo-auth-session obtains a Google ID token, which Firebase exchanges for
 * a Firebase session. The API then sees an ordinary Firebase ID token - no server changes.
 * Rendered only when Firebase and the Google client IDs are configured.
 */
export function GoogleSignInButton() {
  const { signInWithGoogleIdToken } = useAuth();
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest(clientIds);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (response?.type !== 'success') return;
    const idToken = response.params.id_token;
    if (!idToken) {
      setError('Google did not return an ID token');
      return;
    }
    setBusy(true);
    signInWithGoogleIdToken(idToken)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Google sign-in failed'))
      .finally(() => setBusy(false));
  }, [response, signInWithGoogleIdToken]);

  return (
    <>
      <Button
        title="Continue with Google"
        variant="secondary"
        disabled={!request}
        loading={busy}
        onPress={() => {
          setError(null);
          void promptAsync();
        }}
      />
      {error ? <Text style={{ color: colors.negative }}>{error}</Text> : null}
    </>
  );
}
