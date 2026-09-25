import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { usePushNotifications } from '../src/notifications/push';
import { colors, navTheme } from '../src/theme';

function RootNavigator() {
  const { status } = useAuth();
  usePushNotifications(status === 'signedIn');
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="search" options={{ title: 'Add ticker', presentation: 'modal' }} />
      <Stack.Screen name="asset/[symbol]/index" options={{ title: '' }} />
      <Stack.Screen name="asset/[symbol]/signals" options={{ title: 'Signals' }} />
      <Stack.Screen name="event/[id]" options={{ title: 'Signal explained' }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider value={navTheme}>
          <StatusBar style="light" />
          <RootNavigator />
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
