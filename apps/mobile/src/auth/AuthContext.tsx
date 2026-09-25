import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { configureApiAuth } from '../api/client';
import { firebaseConfigured, getFirebaseAuth } from './firebase';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: Status;
  email: string | null;
  mode: 'firebase' | 'dev';
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const DEV_EMAIL_KEY = 'dev-auth-email';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [email, setEmail] = useState<string | null>(null);
  const mode = firebaseConfigured ? 'firebase' : 'dev';

  useEffect(() => {
    if (firebaseConfigured) {
      return onAuthStateChanged(getFirebaseAuth(), (user) => {
        setEmail(user?.email ?? null);
        setStatus(user ? 'signedIn' : 'signedOut');
      });
    }
    AsyncStorage.getItem(DEV_EMAIL_KEY)
      .then((stored) => {
        setEmail(stored);
        setStatus(stored ? 'signedIn' : 'signedOut');
      })
      .catch(() => setStatus('signedOut'));
    return undefined;
  }, []);

  const signOut = useCallback(async () => {
    if (firebaseConfigured) await firebaseSignOut(getFirebaseAuth());
    else await AsyncStorage.removeItem(DEV_EMAIL_KEY);
    setEmail(null);
    setStatus('signedOut');
  }, []);

  useEffect(() => {
    configureApiAuth(
      async () => {
        if (firebaseConfigured) return (await getFirebaseAuth().currentUser?.getIdToken()) ?? null;
        return email ? `dev:${email}` : null;
      },
      () => {
        if (status === 'signedIn') void signOut();
      },
    );
  }, [email, status, signOut]);

  const signIn = useCallback(async (rawEmail: string, password: string) => {
    const e = rawEmail.trim().toLowerCase();
    if (firebaseConfigured) {
      await signInWithEmailAndPassword(getFirebaseAuth(), e, password);
      return;
    }
    // Dev mode: no password check - the API must run with AUTH_MODE=dev.
    await AsyncStorage.setItem(DEV_EMAIL_KEY, e);
    setEmail(e);
    setStatus('signedIn');
  }, []);

  const signUp = useCallback(
    async (rawEmail: string, password: string) => {
      if (firebaseConfigured) {
        await createUserWithEmailAndPassword(getFirebaseAuth(), rawEmail.trim(), password);
        return;
      }
      await signIn(rawEmail, password);
    },
    [signIn],
  );

  const value = useMemo(
    () => ({ status, email, mode, signIn, signUp, signOut }) as AuthContextValue,
    [status, email, mode, signIn, signUp, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
