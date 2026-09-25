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
      JSON.parse(Buffer.from(options.serviceAccountBase64, 'base64').toString('utf8')),
    );
  } else if (options.serviceAccountPath) {
    credential = cert(JSON.parse(readFileSync(options.serviceAccountPath, 'utf8')));
  } else {
    credential = applicationDefault();
  }
  return initializeApp({ credential, projectId: options.projectId });
}
