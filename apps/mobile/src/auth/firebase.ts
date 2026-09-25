import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApps, initializeApp } from 'firebase/app';
import * as FirebaseAuth from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

/** Firebase Auth is used when configured; otherwise the app falls back to dev login. */
export const firebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let auth: FirebaseAuth.Auth | undefined;

export function getFirebaseAuth(): FirebaseAuth.Auth {
  if (auth) return auth;
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  // getReactNativePersistence ships in the React Native build of firebase/auth but is
  // missing from the published type definitions.
  const { getReactNativePersistence } = FirebaseAuth as unknown as {
    getReactNativePersistence: (storage: typeof AsyncStorage) => FirebaseAuth.Persistence;
  };
  try {
    auth = FirebaseAuth.initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch {
    auth = FirebaseAuth.getAuth(app); // already initialised (fast refresh)
  }
  return auth;
}
