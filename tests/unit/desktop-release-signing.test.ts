/**
 * The desktop release pipeline, and the guide that ships next to it, held to each
 * other and to the same two rules.
 *
 * 1. A SIGNING STEP MUST BE ABLE TO NOT RUN. Signing credentials are the one
 *    input a release cannot supply for itself: a fork does not have them, and
 *    neither does the repository on the day before somebody provisions them. An
 *    unconditional step that consumes them does not merely skip signing when they
 *    are absent — it FAILS, and it fails inside a job the whole release depends
 *    on. The Windows build fails, so no Release is created, so the auto-update
 *    manifest is never published, so the npm publish (which deliberately waits
 *    for the desktop channel rather than racing ahead of it) times out and
 *    refuses. One missing secret, and a tag ships nothing on either channel,
 *    three quarters of an hour later. The macOS half of the same workflow has
 *    always answered this by checking first and exiting cleanly; the Windows half
 *    was added without it.
 *
 * 2. THE GUIDE MUST DESCRIBE THIS PIPELINE. It is the only description most
 *    readers get, and it ships inside the package. A guide that calls the
 *    installer unsigned — and walks the reader through clicking past the warning
 *    that signing exists to remove — teaches exactly the habit the signing was
 *    bought to stop, while the changelog on the same tag says the opposite.
 *
 * Both are read from the real files: the workflow decides what the release does,
 * and the secret names come OUT of the workflow rather than being retyped here,
 * so provisioning a differently-named credential cannot leave the guide behind.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'desktop-release.yml');
const WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, 'utf8');
const DESKTOP_DOC = readFileSync(join(REPO_ROOT, 'docs', 'desktop.md'), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  env?: Record<string, string>;
  steps?: Step[];
}

const WORKFLOW = parse(WORKFLOW_TEXT) as { jobs: Record<string, Job> };

/** Every `secrets.NAME` the workflow reads, anywhere. */
function secretsReferenced(text: string): string[] {
  return [...new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
}

/** The text of one step, as written — where its secret references live. */
function stepText(step: Step): string {
  return JSON.stringify(step);
}

describe('the desktop release workflow', () => {
  it('lets every signing step stand down when its credentials are absent', () => {
    // Not "the Windows step specifically" — ANY step in a build job that consumes
    // a signing secret. Naming the one that was broken would leave the next one
    // to be added just as unguarded.
    const buildJobs = Object.entries(WORKFLOW.jobs).filter(([name]) => name.startsWith('build-'));
    expect(buildJobs.length, 'the workflow must have build jobs').toBeGreaterThan(0);

    const unguarded: string[] = [];
    for (const [jobName, job] of buildJobs) {
      const jobEnv = job.env ?? {};
      for (const step of job.steps ?? []) {
        const consumed = secretsReferenced(stepText(step));
        if (consumed.length === 0) continue;

        // Either the step DECIDES FOR ITSELF — its script branches on whether one
        // of the credentials it holds is empty, so the absent case takes a
        // working path — or it is SKIPPED by a condition. A condition cannot read
        // the secrets context, so it has to read a job-level env var holding one.
        const boundToSecret = (env: Record<string, unknown> | undefined): string[] =>
          Object.entries(env ?? {})
            .filter(([, v]) => typeof v === 'string' && /secrets\.[A-Z0-9_]+/.test(v))
            .map(([k]) => k);

        const own = boundToSecret((step as { env?: Record<string, unknown> }).env);
        const decidesForItself =
          typeof step.run === 'string' &&
          own.some((k) => new RegExp(`-[zn] "\\$${k}"`).test(step.run!));

        const guardEnv = boundToSecret(jobEnv);
        const skippable =
          typeof step.if === 'string' && guardEnv.some((k) => step.if!.includes(`env.${k}`));

        if (!decidesForItself && !skippable) {
          unguarded.push(
            `${jobName} / "${step.name ?? step.uses ?? 'unnamed step'}" consumes ` +
              `${consumed.join(', ')} and cannot be skipped without them — ` +
              `absent credentials would fail the build and publish nothing, on either channel. ` +
              `Give it an "if:" on a job-level env var bound to one of those secrets, ` +
              `or have it check and exit 0 the way the macOS preparation does.`,
          );
        }
      }
    }
    expect(unguarded.join('\n')).toBe('');
  });

  it('still signs when the credentials ARE there', () => {
    // The guard must be a condition on the step, not a deletion of it.
    const win = WORKFLOW.jobs['build-windows'];
    expect(win, 'the workflow must build Windows').toBeTruthy();
    const signing = (win.steps ?? []).filter((s) => secretsReferenced(stepText(s)).length > 0);
    expect(signing.length, 'the Windows build must still have a signing step').toBe(1);
    expect(signing[0].uses, 'signing must still run a signing action').toBeTruthy();
    // And it must sign the artifact the release actually publishes.
    expect(JSON.stringify(signing[0].with)).toMatch(/msi/i);
  });

  it('is described by the guide that ships with it, not contradicted by it', () => {
    const signsWindows = WORKFLOW_TEXT.includes('Sign Windows installer');
    expect(signsWindows, 'this test is about a pipeline that signs the Windows installer').toBe(
      true,
    );

    // The published installer is signed, so the guide must not tell a reader it
    // is not — nor walk them through the warning that signing removes.
    expect(DESKTOP_DOC).not.toMatch(/`\.msi` is unsigned/);
    expect(DESKTOP_DOC).not.toMatch(/no Authenticode certificate/i);
    expect(DESKTOP_DOC).not.toMatch(/More info → Run anyway/);

    // Every credential the pipeline needs is written down where somebody
    // provisioning it would look. Taken FROM the workflow, so a renamed or added
    // secret fails here instead of quietly going undocumented.
    const signingSecrets = secretsReferenced(WORKFLOW_TEXT).filter((s) => s.includes('SIGNING'));
    expect(signingSecrets.length, 'the pipeline must read signing credentials').toBeGreaterThan(0);
    for (const secret of signingSecrets) {
      expect(DESKTOP_DOC, `docs/desktop.md must document ${secret}`).toContain(secret);
    }
  });
});
