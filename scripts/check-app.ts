/**
 * Application checks for CI and local use: runs each step in order and stops at the first failure.
 * Children get SANCTUM_ENV=test and no provider credentials, so external side effects stay disabled.
 */
import { spawnSync } from 'node:child_process';
import { validateManifest } from '../benchmarks/result-format.ts';

const CREDENTIAL = /^(DEEPGRAM|CARTESIA|CEREBRAS|ANTHROPIC|PYANNOTE|PIPEDREAM|R2|AWS)_/;

export function childEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(source).filter(([name]) => !CREDENTIAL.test(name));
  return { ...Object.fromEntries(kept), SANCTUM_ENV: 'test' };
}

interface Step { name: string; run: () => boolean }

const command = (name: string, file: string, args: string[]): Step => ({
  name,
  run: () => spawnSync(file, args, { stdio: 'inherit', env: childEnv(process.env) }).status === 0,
});

function manifestIsValid(): boolean {
  const errors = validateManifest();
  errors.forEach(error => console.error(error));
  return errors.length === 0;
}

const STEPS: Step[] = [
  command('Workspace typechecks', 'npm', ['run', 'typecheck', '--workspaces', '--if-present']),
  command('Vitest suites', 'npx', ['vitest', 'run']),
  command('Web build', 'npm', ['run', 'build', '-w', 'web-app']),
  command('Browser end-to-end', 'npm', ['run', 'test:e2e', '-w', 'web-app']),
  { name: 'Benchmark manifest', run: manifestIsValid },
];

function timed(step: Step): boolean {
  console.log(`\n==> ${step.name}`);
  const started = performance.now();
  const ok = step.run();
  console.log(`<== ${step.name}: ${ok ? 'passed' : 'FAILED'} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  return ok;
}

if (import.meta.main) {
  if (process.argv.includes('--help')) console.log(`Usage: npm run check:app\nSteps, in order:\n${STEPS.map(step => `  - ${step.name}`).join('\n')}`);
  else if (!STEPS.every(timed)) process.exitCode = 1;
}
