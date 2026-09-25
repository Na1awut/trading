/**
 * Shared helpers for the process-level validation scripts. They run the BUILT binaries
 * (apps/api/dist, apps/worker/dist) as child processes against a real Postgres database,
 * from a working directory outside the repository so the developer's `.env` is never
 * picked up: every setting a check depends on is passed explicitly.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const API_BIN = join(REPO_ROOT, 'apps/api/dist/server.js');
export const WORKER_BIN = join(REPO_ROOT, 'apps/worker/dist/main.js');
export const VALIDATION_DB_URL =
  process.env.VALIDATION_DATABASE_URL ??
  'postgresql://signals:signals@localhost:5432/signals_validation?schema=public';

/** Neutral cwd with no `.env` above it. */
export const NEUTRAL_CWD = mkdtempSync(join(tmpdir(), 'signals-validation-'));

/** Only what a process needs to start; nothing inherited from the developer's shell. */
export function baseEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.NODE_EXTRA_CA_CERTS
      ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
      : {}),
    LOG_LEVEL: 'info',
    DATABASE_URL: VALIDATION_DB_URL,
    ...extra,
  };
}

export interface Proc {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
  waitFor: (re: RegExp, timeoutMs?: number) => Promise<boolean>;
  stop: () => Promise<number | null>;
}

export function start(bin: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, [bin, ...args], { cwd: NEUTRAL_CWD, env });
  let out = '';
  const listeners = new Set<() => void>();
  const onData = (d: Buffer) => {
    out += d.toString();
    for (const l of listeners) l();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  let done = false;
  void exited.then(() => {
    done = true;
    for (const l of listeners) l();
  });
  return {
    child,
    output: () => out,
    exited,
    waitFor: (re, timeoutMs = 20_000) =>
      new Promise((resolveWait) => {
        const check = () => {
          if (re.test(out)) finish(true);
          else if (done) finish(false);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        const finish = (v: boolean) => {
          clearTimeout(timer);
          listeners.delete(check);
          resolveWait(v);
        };
        listeners.add(check);
        check();
      }),
    stop: async () => {
      if (!done) child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const code = await exited;
      clearTimeout(t);
      return code;
    },
  };
}

/** Run to completion (or kill after `timeoutMs`). */
export async function run(
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  const p = start(bin, args, env);
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    p.child.kill('SIGKILL');
  }, timeoutMs);
  const code = await p.exited;
  clearTimeout(t);
  return { code, output: p.output(), timedOut };
}

export async function freePort(): Promise<number> {
  return new Promise((r, j) => {
    const s = createServer();
    s.once('error', j);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });
}

export interface Check {
  section: string;
  name: string;
  pass: boolean;
  detail: string;
}

export class Report {
  readonly checks: Check[] = [];
  readonly notes: string[] = [];
  constructor(readonly title: string) {}

  check(section: string, name: string, pass: boolean, detail = ''): boolean {
    this.checks.push({ section, name, pass, detail });
    console.info(`${pass ? 'PASS' : 'FAIL'}  [${section}] ${name}${detail ? ` — ${detail}` : ''}`);
    return pass;
  }

  note(text: string) {
    this.notes.push(text);
    console.info(`NOTE  ${text}`);
  }

  get failed(): number {
    return this.checks.filter((c) => !c.pass).length;
  }

  write(kind: string, extra: Record<string, unknown> = {}): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(REPO_ROOT, 'validation-output', kind, stamp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'report.json'),
      JSON.stringify(
        { title: this.title, checks: this.checks, notes: this.notes, ...extra },
        null,
        2,
      ),
    );
    const lines = [
      `# ${this.title}`,
      '',
      `Generated ${new Date().toISOString()} — ${this.checks.length - this.failed}/${this.checks.length} checks passed.`,
      '',
      '| Result | Section | Check | Detail |',
      '| --- | --- | --- | --- |',
      ...this.checks.map(
        (c) =>
          `| ${c.pass ? 'PASS' : '**FAIL**'} | ${c.section} | ${c.name} | ${c.detail.replace(/\|/g, '\\|')} |`,
      ),
      '',
      ...(this.notes.length ? ['## Notes', '', ...this.notes.map((n) => `- ${n}`), ''] : []),
    ];
    writeFileSync(join(dir, 'report.md'), lines.join('\n'));
    console.info(`\nReport: ${join(dir, 'report.md')}`);
    return dir;
  }
}

/** Returns which of the given secret markers occur in `text` (names only, never values). */
export function leakedSecrets(text: string, secrets: Record<string, string>): string[] {
  return Object.entries(secrets)
    .filter(([, value]) => value.length > 0 && text.includes(value))
    .map(([name]) => name);
}
