#!/usr/bin/env node
// Wait until a version that was just published is installable from the npm
// registry, then confirm that the `latest` dist-tag names it.
//
// A successful `npm publish` no longer means the version is installable. The
// registry scans every new version before releasing it and answers 404 for that
// version until the scan is done. The registry describes the delay as
// "typically around five minutes", longer at peak times or for larger packages,
// and not guaranteed. So this check waits for the registry's own answer instead
// of allowing a fixed number of seconds:
//
//   1. poll the exact version until the registry serves it;
//   2. poll the dist-tags until `latest` names it.
//
// It exits 0 as soon as both hold. It exits 1 only at the deadline (30 minutes
// by default, twice the upper end of the registry's stated range), saying where
// the release stands. A version that is still missing by then has most likely
// been held for manual review or blocked by the scan. Its status is visible to
// the package's maintainers on the registry website; it is not visible to an
// anonymous client such as this one.
//
// Neither endpoint polled here is cached while the version is missing, so the
// release is seen on the first poll after it happens.
//
// Usage:
//   node scripts/await-npm-release.mjs <package> <version>
//     [--registry <url>] [--timeout-minutes <n>] [--interval-seconds <n>]

const DEFAULTS = {
  registry: 'https://registry.npmjs.org',
  timeoutMinutes: 30,
  intervalSeconds: 15,
};
const PROGRESS_EVERY_MS = 60_000;
const REQUEST_LIMIT_MS = 20_000;
// Even at the deadline, a request gets this long, so a release that lands in the
// final seconds is still seen rather than lost to an aborted request.
const REQUEST_FLOOR_MS = 5_000;

function usage(message) {
  console.error(`::error::${message}`);
  console.error(
    'usage: node scripts/await-npm-release.mjs <package> <version> [--registry <url>] [--timeout-minutes <n>] [--interval-seconds <n>]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--registry') opts.registry = argv[++i] ?? '';
    else if (arg === '--timeout-minutes') opts.timeoutMinutes = Number(argv[++i]);
    else if (arg === '--interval-seconds') opts.intervalSeconds = Number(argv[++i]);
    else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
    else positional.push(arg);
  }
  const [name, version] = positional;
  if (!name || !version || positional.length > 2) usage('expected <package> <version>');
  if (!opts.registry) usage('--registry needs a URL');
  if (!(opts.timeoutMinutes > 0)) usage('--timeout-minutes must be a positive number');
  if (!(opts.intervalSeconds > 0)) usage('--interval-seconds must be a positive number');
  return { name, version, ...opts, registry: opts.registry.replace(/\/+$/, '') };
}

function formatElapsed(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The registry's path form of a package name: a scoped name keeps its "@" and
// escapes the slash.
function registryPath(name) {
  return name.replace('/', '%2f');
}

async function getJson(url, remainingMs) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(
      Math.max(REQUEST_FLOOR_MS, Math.min(REQUEST_LIMIT_MS, remainingMs)),
    ),
  });
  if (res.status !== 200) return { status: res.status };
  return { status: 200, body: await res.json() };
}

async function main() {
  const { name, version, registry, timeoutMinutes, intervalSeconds } = parseArgs(
    process.argv.slice(2),
  );
  const spec = `${name}@${version}`;
  const intervalMs = intervalSeconds * 1000;
  const start = Date.now();
  const deadline = start + timeoutMinutes * 60_000;
  const versionUrl = `${registry}/${registryPath(name)}/${encodeURIComponent(version)}`;
  const tagsUrl = `${registry}/-/package/${registryPath(name)}/dist-tags`;

  let released = false; // the registry serves the exact version
  let lastAnswer = 'no answer yet';
  let lastLatest = '';
  let lastProgress = start;
  const seen = new Set();
  const note = (key, message) => {
    if (!seen.has(key)) {
      seen.add(key);
      console.log(message);
    }
  };

  console.log(
    `Waiting for the registry to release ${spec} (it scans each new version first; ` +
      `typically about five minutes). Deadline: ${timeoutMinutes} minutes.`,
  );

  for (;;) {
    const remaining = deadline - Date.now();
    try {
      if (!released) {
        const r = await getJson(versionUrl, remaining);
        lastAnswer = `HTTP ${r.status}`;
        if (r.status === 200 && r.body && r.body.version === version) {
          released = true;
          console.log(
            `${spec} is installable (${formatElapsed(Date.now() - start)} after publish).`,
          );
          continue;
        }
        if (r.status === 404)
          note('404', `${spec} is not installable yet: the registry is still processing it.`);
        else
          note(
            `status-${r.status}`,
            `The registry answered HTTP ${r.status} for ${spec}; retrying.`,
          );
      } else {
        const r = await getJson(tagsUrl, remaining);
        lastAnswer = `HTTP ${r.status}`;
        lastLatest = r.status === 200 && r.body ? String(r.body.latest ?? '') : lastLatest;
        if (lastLatest === version) {
          console.log(`latest = ${version}. Release confirmed.`);
          return 0;
        }
        note(
          `latest-${lastLatest}`,
          `latest still names ${lastLatest || 'nothing'}; waiting for ${version}.`,
        );
      }
    } catch (err) {
      lastAnswer = `request failed (${err && err.message ? err.message : String(err)})`;
      note(`error-${lastAnswer}`, `Registry request for ${spec} failed: ${lastAnswer}; retrying.`);
    }

    const now = Date.now();
    if (now >= deadline) break;
    if (now - lastProgress >= PROGRESS_EVERY_MS) {
      lastProgress = now;
      console.log(
        `  still waiting for ${released ? 'latest to move' : 'the release'}: ` +
          `${formatElapsed(now - start)} of ${timeoutMinutes}m (last answer: ${lastAnswer})`,
      );
    }
    await sleep(Math.min(intervalMs, deadline - now));
  }

  const waited = formatElapsed(Date.now() - start);
  if (!released) {
    console.error(
      `::error::${spec} is still not installable ${waited} after a successful publish ` +
        `(last answer: ${lastAnswer}). The registry scans each new version before releasing it, ` +
        'normally in about five minutes. A version still missing after this long has most likely ' +
        "been held for manual review or blocked; maintainers can see its status on the package's page " +
        'on the registry website.',
    );
  } else {
    console.error(
      `::error::${spec} is installable, but latest still names ${lastLatest || 'nothing'} ` +
        `after ${waited} (last answer: ${lastAnswer}).`,
    );
  }
  return 1;
}

process.exitCode = await main();
