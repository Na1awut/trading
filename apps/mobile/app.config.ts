/// <reference types="node" />
import { existsSync } from 'node:fs';
import type { ExpoConfig } from 'expo/config';

// google-services.json / GoogleService-Info.plist come from the Firebase console and are
// git-ignored. They are only needed for native builds with FCM push.
const androidGoogleServices =
  process.env.GOOGLE_SERVICES_JSON ??
  (existsSync('./google-services.json') ? './google-services.json' : undefined);
const iosGoogleServices =
  process.env.GOOGLE_SERVICE_INFO_PLIST ??
  (existsSync('./GoogleService-Info.plist') ? './GoogleService-Info.plist' : undefined);

const config: ExpoConfig = {
  name: 'Signal Alerts',
  slug: 'stock-signal-alerts',
  scheme: 'stocksignals',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  backgroundColor: '#0B0E14',
  ios: {
    bundleIdentifier: 'com.example.stocksignals',
    supportsTablet: false,
    ...(iosGoogleServices ? { googleServicesFile: iosGoogleServices } : {}),
  },
  android: {
    package: 'com.example.stocksignals',
    ...(androidGoogleServices ? { googleServicesFile: androidGoogleServices } : {}),
  },
  plugins: [
    'expo-router',
    'expo-status-bar',
    'expo-secure-store',
    ['expo-notifications', { color: '#22C55E', defaultChannel: 'signals' }],
  ],
};

export default config;
