/**
 * Vitest global setup: one MySQL 8.4 server per test run, shared by every suite in it.
 * `SANCTUM_TEST_MYSQL_URL` (an account allowed to CREATE/DROP DATABASE) reuses an external
 * server; otherwise a uniquely named throwaway `mysql:8.4` container with small memory
 * settings is started and removed on exit. Suites isolate themselves with `testDatabase`.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mysqlAdminUrl: string;
  }
}

const IMAGE = 'mysql:8.4';
const LOW_MEMORY = [
  '--innodb-buffer-pool-size=32M',
  '--innodb-log-buffer-size=4M',
  '--performance-schema=OFF',
  '--skip-log-bin',
  '--max-connections=200',
  '--table-open-cache=400',
];

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

async function waitForServer(url: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      const connection = await createConnection(url);
      await connection.end();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

function startContainer(): { url: string; name: string } {
  const name = `sanctum-test-${process.pid}-${randomBytes(3).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  docker('run', '--detach', '--rm', '--name', name, '--memory', '512m', '--publish', '127.0.0.1::3306',
    '--env', `MYSQL_ROOT_PASSWORD=${password}`, '--env', 'TZ=UTC', IMAGE, ...LOW_MEMORY);
  const port = docker('port', name, '3306/tcp').split('\n')[0]!.split(':').at(-1)!;
  return { name, url: `mysql://root:${password}@127.0.0.1:${port}` };
}

export default async function setup(project: TestProject) {
  const external = process.env.SANCTUM_TEST_MYSQL_URL;
  const container = external ? null : startContainer();
  const url = external ?? container!.url;
  const stop = () => {
    if (container) execFileSync('docker', ['rm', '--force', '--volumes', container.name], { stdio: 'ignore' });
  };
  process.once('exit', stop);
  try {
    await waitForServer(url, Date.now() + 90_000);
  } catch (error) {
    stop();
    throw error;
  }
  project.provide('mysqlAdminUrl', url);
  return stop;
}
