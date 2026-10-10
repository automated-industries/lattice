/**
 * Keep the test runner's failure exit code.
 *
 * embedded-postgres registers async-exit-hook when it loads, and that library's
 * `beforeExit` handler ends the process with `process.exit(0)`. The test runner
 * reports failures by setting `process.exitCode` and letting the process end, so
 * a local run with failing tests exited 0. This records the code when `beforeExit`
 * fires, ahead of any other handler, and puts it back on `exit`, the last point at
 * which the process's exit code can still change.
 */
export function keepExitCode() {
  let intended;
  process.prependListener('beforeExit', () => {
    intended = process.exitCode;
  });
  process.on('exit', () => {
    if (intended !== undefined && Number(intended) !== 0) process.exitCode = intended;
  });
}
