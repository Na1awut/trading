import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { configureApiAuth } from '../api/client';
import { firebaseConfigured, getFirebaseAuth } from './firebase';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: Status;
  email: string | null;
  emailVerified: boolean;
  mode: 'firebase' | 'dev';
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  /** Google (or any OAuth) sign-in: exchange the provider ID token for a Firebase session. */
  signInWithGoogleIdToken(idToken: string): Promise<void>;
  resetPassword(email: string): Promise<void>;
  signOut(): Promise<void>;
  /** Runs before sign-out (e.g. unregister this device's push token). */
  setBeforeSignOut(fn: (() => Promise<void>) | null): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const DEV_EMAIL_KEY = 'dev-auth-email';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [email, setEmail] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const beforeSignOut = useRef<(() => Promise<void>) | null>(null);
  const mode = firebaseConfigured ? 'firebase' : 'dev';

  useEffect(() => {
    if (firebaseConfigured) {
      return onAuthStateChanged(getFirebaseAuth(), (user) => {
        setEmail(user?.email ?? null);
        setEmailVerified(user?.emailVerified ?? false);
        setStatus(user ? 'signedIn' : 'signedOut');
      });
    }
    AsyncStorage.getItem(DEV_EMAIL_KEY)
      .then((stored) => {
        setEmail(stored);
        setEmailVerified(true);
        setStatus(stored ? 'signedIn' : 'signedOut');
      })
      .catch(() => setStatus('signedOut'));
    return undefined;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await beforeSignOut.current?.();
    } catch {
      // best effort - never block sign-out
    }
    if (firebaseConfigured) await firebaseSignOut(getFirebaseAuth());
    else await AsyncStorage.removeItem(DEV_EMAIL_KEY);
    setEmail(null);
    setStatus('signedOut');
  }, []);

  // Register the API token getter DURING RENDER (once), reading current state from refs.
  // Registering it in an effect raced with the first screen queries: React runs child
  // effects before parent effects, so cold-start requests went out without a token (401).
  const emailRef = useRef(email);
  const statusRef = useRef(status);
  emailRef.current = email;
  statusRef.current = status;
  const configured = useRef(false);
  if (!configured.current) {
    configured.current = true;
    configureApiAuth(
      async (forceRefresh) => {
        // Firebase caches the ID token and refreshes it before expiry; forceRefresh is used
        // once after a 401 (e.g. clock skew or a just-verified email).
        if (firebaseConfigured) {
          return (await getFirebaseAuth().currentUser?.getIdToken(forceRefresh)) ?? null;
        }
        return emailRef.current ? `dev:${emailRef.current}` : null;
      },
      () => {
        if (statusRef.current === 'signedIn') void signOut();
      },
    );
  }

  const signIn = useCallback(async (rawEmail: string, password: string) => {
    const e = rawEmail.trim().toLowerCase();
    if (firebaseConfigured) {
      await signInWithEmailAndPassword(getFirebaseAuth(), e, password);
      return;
    }
    // Dev mode: no password check - the API must run with AUTH_MODE=dev.
    await AsyncStorage.setItem(DEV_EMAIL_KEY, e);
    setEmail(e);
    setEmailVerified(true);
    setStatus('signedIn');
  }, []);

  const signUp = useCallback(
    async (rawEmail: string, password: string) => {
      if (firebaseConfigured) {
        const cred = await createUserWithEmailAndPassword(
          getFirebaseAuth(),
          rawEmail.trim(),
          password,
        );
        // Needed when the API runs with AUTH_REQUIRE_EMAIL_VERIFIED=true.
        await sendEmailVerification(cred.user).catch(() => undefined);
        return;
      }
      await signIn(rawEmail, password);
    },
    [signIn],
  );

  const signInWithGoogleIdToken = useCallback(async (idToken: string) => {
    if (!firebaseConfigured) throw new Error('Google sign-in requires Firebase configuration');
    await signInWithCredential(getFirebaseAuth(), GoogleAuthProvider.credential(idToken));
  }, []);

  const resetPassword = useCallback(async (rawEmail: string) => {
    if (!firebaseConfigured) throw new Error('Password reset requires Firebase configuration');
    await sendPasswordResetEmail(getFirebaseAuth(), rawEmail.trim());
  }, []);

  const setBeforeSignOut = useCallback((fn: (() => Promise<void>) | null) => {
    beforeSignOut.current = fn;
  }, []);

  const value = useMemo(
    () =>
      ({
        status,
        email,
        emailVerified,
        mode,
        signIn,
        signUp,
        signInWithGoogleIdToken,
        resetPassword,
        signOut,
        setBeforeSignOut,
      }) as AuthContextValue,
    [
      status,
      email,
      emailVerified,
      mode,
      signIn,
      signUp,
      signInWithGoogleIdToken,
      resetPassword,
      signOut,
      setBeforeSignOut,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
