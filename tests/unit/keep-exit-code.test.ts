/**
 * A local test run that fails must not exit 0.
 *
 * Local runs boot a disposable database through embedded-postgres, which loads
 * async-exit-hook. That library's `beforeExit` handler ends the process with
 * `process.exit(0)`, replacing the failure code the test runner had set, so a run
 * with failing tests reported success. `keepExitCode()` restores the code. Each
 * case runs a real child process, because an exit code cannot be observed from
 * inside the process that is exiting.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const HELPER = pathToFileURL(join(REPO_ROOT, 'tests', 'setup', 'keep-exit-code.mjs')).href;

/** Register an async-exit-hook handler, then fail the way the test runner does. */
function exitCodeOf(withHelper: boolean): number | null {
  const script = [
    "import hook from 'async-exit-hook';",
    withHelper ? `import { keepExitCode } from ${JSON.stringify(HELPER)}; keepExitCode();` : '',
    'hook((done) => done());',
    'process.exitCode = 1;',
  ].join('\n');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  expect(run.error, 'the child process started').toBeUndefined();
  expect(run.stderr, 'the child process ran cleanly').toBe('');
  return run.status;
}

describe('a failing local test run keeps its failure exit code', () => {
  it('async-exit-hook on its own turns a failure into exit 0 (what this guards against)', () => {
    expect(
      exitCodeOf(false),
      'async-exit-hook no longer forces exit 0, so keepExitCode() can be removed',
    ).toBe(0);
  });

  it('with keepExitCode() the failure code survives', () => {
    expect(exitCodeOf(true)).toBe(1);
  });
});
