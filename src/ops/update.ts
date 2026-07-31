/**
 * "Is there a newer version, and can this copy take it?", headless.
 *
 * Two different questions get answered together here because answering either
 * one alone is useless. A version number with no install context tells an
 * operator a release exists but not whether their machine can move to it; an
 * install context with no version tells them how they would upgrade but not
 * whether there is anything to upgrade to. Every caller wants both, and the
 * routes that used to hold this asked them together too.
 *
 * This REPORTS. It never installs, so it is safe to call anywhere — a health
 * check, a fleet inventory, a start-up banner. Installing is a separate
 * capability precisely so that reporting can be run without consequence.
 *
 * A failed check is reported as a failed check. That distinction is the whole
 * reason this returns a record rather than a version string: a registry that
 * cannot be reached produces the same `null` as a copy that is already current,
 * and reading the first as the second tells somebody they are up to date when
 * nobody has any idea whether they are. "Could not be reached" includes an
 * answer that arrived and was not an answer — a proxy's 403, a mirror's 404 —
 * which is why the sources this uses raise rather than resolve to null.
 *
 * And the question is put to the channel the copy is actually upgraded from. A
 * packaged desktop application is replaced by a signed installer published as a
 * release, not by a package install, and the two advance separately; asking the
 * registry on its behalf can name a version its own channel cannot yet serve.
 */
import { checkForUpdate, desktopReleaseBaseUrl, readManifestForUpdate } from '../update-check.js';
import { detectInstallContext, type InstallContext, type InstallKind } from '../update-context.js';

/** What a version check found, and what this copy could do about it. */
export interface UpdateAvailability {
  /** The version running now — whatever the caller said it was. */
  current: string;
  /**
   * The newest published version when it is newer than {@link current}, and null
   * otherwise. Null is only meaningful alongside {@link checked}.
   */
  latest: string | null;
  /** How this copy was installed, which is what decides the next field. */
  kind: InstallKind;
  /** Whether an ordinary package install may upgrade this copy where it stands. */
  installable: boolean;
  /** Why {@link installable} is what it is, in a sentence fit to show somebody. */
  reason: string;
  /**
   * Whether the registry answered. FALSE means nothing was learned — not that
   * the copy is current. A caller that reports "up to date" without reading this
   * is reporting an outcome it never observed.
   */
  checked: boolean;
  /** What went wrong when {@link checked} is false, else null. */
  error: string | null;
}

/** How to run the check. Every input is optional and every default is the real one. */
export interface UpdateCheckOptions {
  /** The version running now. Required — nothing else can know it reliably. */
  currentVersion: string;
  /** Skip any cached answer and ask the registry. Defaults to true. */
  force?: boolean;
  /** The package to ask about. Defaults to this one. */
  packageName?: string;
  /**
   * The install context to report against. Detected from the running process
   * when omitted; injectable so a caller can ask about a copy other than its own
   * and so the detection is testable without a filesystem to imitate.
   */
  context?: InstallContext;
  /**
   * Where the packaged desktop application's releases are published. Defaults to
   * the real release location; overridable for a deployment that mirrors it.
   * Ignored for every other install kind, which is not upgraded from there.
   */
  releaseManifestUrl?: string;
  /**
   * Where "the newest published version" comes from. Defaults to the channel that
   * matches the install kind — see {@link checkForNewerVersion}. Supplied by a
   * deployment that publishes through a mirror — and by a test, which must not
   * reach the network to prove that an unreachable source is reported as
   * unreachable.
   */
  check?: (force: boolean) => Promise<string | null>;
}

/**
 * The channel a given install is actually upgraded from.
 *
 * A packaged desktop application is not an npm install and cannot become one: it
 * is replaced by a signed installer published as a release, and the two channels
 * advance separately — a release exists on npm the moment it publishes, while the
 * desktop artifacts appear only once their build finishes and can fail
 * independently. Asking npm on behalf of a desktop copy therefore answers a
 * question nobody asked and, in the window between the two, names a version that
 * surface cannot install. It has happened, so this asks the desktop's own release
 * manifest for the desktop, and the registry for the installs the registry serves.
 */
function channelFor(
  opts: UpdateCheckOptions,
  ctx: InstallContext,
): (f: boolean) => Promise<string | null> {
  if (ctx.kind === 'desktop') {
    const base = opts.releaseManifestUrl ?? desktopReleaseBaseUrl();
    return () => readManifestForUpdate(base, opts.currentVersion);
  }
  return (f: boolean) =>
    checkForUpdate(opts.packageName ?? 'latticesql', opts.currentVersion, { force: f });
}

/**
 * Ask whether a newer version exists, and describe what this copy could do about
 * it.
 *
 * The question is asked of the channel this copy is actually upgraded from — the
 * release manifest for a packaged desktop application, the package registry for
 * everything installed from it (see {@link channelFor}). Answering from the wrong
 * channel is not a smaller version of the right answer; it names a version this
 * machine cannot move to.
 *
 * Never throws for a source that could not be asked — an unreachable registry is
 * an answer this function was asked to produce, and it comes back as
 * `checked:false` with the message. A fault inside the detection itself would
 * still throw.
 */
export async function checkForNewerVersion(opts: UpdateCheckOptions): Promise<UpdateAvailability> {
  const ctx = opts.context ?? detectInstallContext();
  const base = {
    current: opts.currentVersion,
    kind: ctx.kind,
    installable: ctx.installable,
    reason: ctx.reason,
  };
  const force = opts.force ?? true;
  const check = opts.check ?? channelFor(opts, ctx);
  try {
    return { ...base, latest: await check(force), checked: true, error: null };
  } catch (e) {
    return { ...base, latest: null, checked: false, error: (e as Error).message };
  }
}
