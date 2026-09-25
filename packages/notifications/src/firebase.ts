import { readFileSync } from 'node:fs';
import { applicationDefault, cert, getApps, initializeApp, type App } from 'firebase-admin/app';

export interface FirebaseAdminOptions {
  projectId?: string;
  serviceAccountPath?: string;
  serviceAccountBase64?: string;
}

/**
 * Lazily initialise the Firebase Admin SDK once per process. Credentials are read from
 * (in order) a base64 secret, a JSON file path, or Application Default Credentials
 * (GOOGLE_APPLICATION_CREDENTIALS / workload identity). Never commit service accounts.
 */
export function getFirebaseAdminApp(options: FirebaseAdminOptions): App {
  const existing = getApps()[0];
  if (existing) return existing;

  let credential;
  if (options.serviceAccountBase64) {
    credential = cert(
      parseServiceAccount(
        Buffer.from(options.serviceAccountBase64, 'base64').toString('utf8'),
        'FIREBASE_SERVICE_ACCOUNT_BASE64',
      ),
    );
  } else if (options.serviceAccountPath) {
    credential = cert(
      parseServiceAccount(
        readFileSync(options.serviceAccountPath, 'utf8'),
        'FIREBASE_SERVICE_ACCOUNT_PATH',
      ),
    );
  } else {
    credential = applicationDefault();
  }
  return initializeApp({ credential, projectId: options.projectId });
}

/**
 * Parse service-account JSON without leaking it: Node's JSON.parse error messages quote a
 * snippet of the input, which would put key material into startup logs.
 */
export function parseServiceAccount(json: string, source: string): object {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error(`${source} does not contain valid service-account JSON`);
  }
}
