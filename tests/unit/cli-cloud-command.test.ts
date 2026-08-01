/**
 * `lattice cloud` — the command bodies, driven directly.
 *
 * Running a shared workspace used to require the browser app: who is on it, who
 * gets added, who gets removed, what a row is shared with, and whether the
 * database is secured at all were all clicks. On a machine with no display the
 * only workaround was to publish that app on a network address it calls
 * unauthenticated. These verbs are what replaces that, so what they do — and
 * more importantly what they REFUSE to do — is worth pinning.
 *
 * The tests drive the subcommand module rather than the process, which is why
 * the logic lives outside the CLI entrypoint: that file runs `main()` at import
 * time and cannot be imported. Everything here runs against a local SQLite
 * workspace or a plain object; the owner-versus-member behaviour that needs real
 * Postgres roles is pinned in the integration suite.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import {
  runCloudCommand,
  resolveCloudTarget,
  resolveMemberRef,
  formatCloudMembers,
  formatCloudStatus,
  CLOUD_SUBCOMMANDS,
  CLOUD_URL_ENV,
  INVITE_TOKEN_ENV,
} from '../../src/cli-cloud.js';
import { mintInviteToken } from '../../src/cloud/invite.js';
import type { CloudMember } from '../../src/cloud/member-directory.js';
import { cloudErrorCode } from '../../src/cloud/errors.js';
import { NATIVE_ENTITY_NAMES } from '../../src/framework/native-entities.js';
import { addWorkspace, resolveWorkspacePaths } from '../../src/framework/workspace.js';
import { ensureRootAt } from '../../src/framework/lattice-root.js';
import { writeIdentity } from '../../src/framework/user-config.js';

let scratch: string;
const prev: Record<string, string | undefined> = {};
const opened: Lattice[] = [];
let dbSeq = 0;
let rootSeq = 0;

const KEY = Buffer.alloc(32, 9).toString('base64');

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lattice-cli-cloud-'));
  for (const key of ['LATTICE_CONFIG_DIR', 'LATTICE_ROOT', 'LATTICE_ENCRYPTION_KEY']) {
    prev[key] = process.env[key];
  }
  // Key + registry resolution stay inside the scratch dir — never the machine's
  // own config dir or home root.
  process.env.LATTICE_CONFIG_DIR = join(scratch, 'config');
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  process.env.LATTICE_ROOT = join(scratch, 'unused-root');
  process.env.LATTICE_ENCRYPTION_KEY = KEY;
});

afterAll(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed by the verb under test */
    }
  }
  for (const [key, value] of Object.entries(prev)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** A real local workspace: SQLite, the built-in tables registered, one user table. */
async function localWorkspace(): Promise<Lattice> {
  dbSeq++;
  const db = new Lattice(join(scratch, `local-${String(dbSeq)}.db`), { encryptionKey: KEY });
  db.define('notes', {
    columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: 'notes.md',
  });
  registerNativeEntities(db);
  await db.init();
  opened.push(db);
  return db;
}

/** Run a verb against `db`, the way the CLI wrapper does. */
async function run(db: Lattice, args: Parameters<typeof runCloudCommand>[0]): Promise<string[]> {
  return runCloudCommand({ configPath: 'ignored.yml', ...args, open: () => Promise.resolve(db) });
}

// ── Dispatch ────────────────────────────────────────────────────────────────

describe('the verb list', () => {
  it('refuses an unknown subcommand, naming the ones that exist', async () => {
    await expect(runCloudCommand({ subcommand: 'teams' })).rejects.toThrow(
      /Unknown cloud subcommand: teams/,
    );
    for (const verb of CLOUD_SUBCOMMANDS) {
      await expect(runCloudCommand({ subcommand: 'teams' })).rejects.toThrow(
        new RegExp(`\\b${verb}\\b`),
      );
    }
  });

  it('refuses an unknown subcommand WITHOUT opening a database', async () => {
    // Resolving a workspace and connecting to it is the expensive, side-effecting
    // half. A typo must not reach it.
    let openedIt = false;
    await expect(
      runCloudCommand({
        subcommand: 'nonsense',
        configPath: 'x.yml',
        open: () => {
          openedIt = true;
          return Promise.reject(new Error('should not be called'));
        },
      }),
    ).rejects.toThrow(/Unknown cloud subcommand/);
    expect(openedIt).toBe(false);
  });

  it('refuses --json on a verb that changes something', async () => {
    // A machine-readable "result" for an operation whose result is a side effect
    // would invite a script to parse an outcome nobody defined.
    await expect(
      runCloudCommand({ subcommand: 'secure', json: true, configPath: 'x.yml' }),
    ).rejects.toThrow(/--json describes a result that can be read/);
  });

  it('closes the workspace it opened, on success and on refusal alike', async () => {
    // A command that leaves a Postgres connection open is a pooled connection
    // held by a process that has already printed its answer and exited its work.
    let closed = 0;
    const stub = {
      getDialect: () => 'sqlite',
      close: () => {
        closed++;
      },
    } as unknown as Lattice;
    const openStub = (): Promise<Lattice> => Promise.resolve(stub);

    await runCloudCommand({ subcommand: 'status', configPath: 'x.yml', open: openStub });
    expect(closed).toBe(1);

    await expect(
      runCloudCommand({ subcommand: 'invite', configPath: 'x.yml', open: openStub }),
    ).rejects.toThrow(/Usage/);
    expect(closed, 'closed on the way out of a refusal too').toBe(2);
  });
});

// ── status ──────────────────────────────────────────────────────────────────

describe('cloud status', () => {
  it('says plainly that a local workspace is not a cloud', async () => {
    const db = await localWorkspace();
    const lines = (await run(db, { subcommand: 'status' })).join('\n');
    expect(lines).toContain('Database:   sqlite');
    expect(lines).toMatch(/Cloud:\s+no/);
    // Not a refusal, not an error — an answer. Somebody diagnosing a workspace
    // needs to be told what it IS.
    expect(lines).not.toMatch(/error/i);
  });

  it('is the default verb, because it is the one you reach for first', async () => {
    const db = await localWorkspace();
    expect((await run(db, {})).join('\n')).toContain('Database:   sqlite');
  });

  it('emits parseable JSON under --json', async () => {
    const db = await localWorkspace();
    const [payload] = await run(db, { subcommand: 'status', json: true });
    const parsed = JSON.parse(payload ?? '') as {
      dialect: string;
      standing: string;
      warnings: unknown[];
    };
    expect(parsed.dialect).toBe('sqlite');
    expect(parsed.standing).toBe('not-a-cloud');
    expect(parsed.warnings).toEqual([]);
  });
});

// ── members ─────────────────────────────────────────────────────────────────

describe('cloud members', () => {
  it('answers honestly on a workspace that has none', async () => {
    const db = await localWorkspace();
    expect((await run(db, { subcommand: 'members' })).join('\n')).toContain('Not a cloud');
  });

  it('renders the roster with the caller marked, and the owner first', () => {
    const roster: CloudMember[] = [
      { role: 'ada', name: 'Ada', email: 'ada@example.test', status: 'owner', isYou: true },
      { role: 'lm_bob_1', name: 'bob', email: 'bob@example.test', status: 'member', isYou: false },
      { role: 'lm_cy_2', name: 'cy', email: 'cy@example.test', status: 'invited', isYou: false },
    ];
    const lines = formatCloudMembers(roster);
    expect(lines[0]?.startsWith('*'), 'the caller is marked').toBe(true);
    expect(lines[1]?.startsWith(' ')).toBe(true);
    expect(lines.join('\n')).toContain('invited');
    expect(lines.join('\n')).toContain('lm_cy_2');
    expect(lines.join('\n')).toContain('<bob@example.test>');
  });
});

// ── naming a member ─────────────────────────────────────────────────────────

describe('naming a member', () => {
  const roster: CloudMember[] = [
    { role: 'ada', name: 'Ada', email: 'ada@example.test', status: 'owner', isYou: true },
    { role: 'lm_bob_1', name: 'bob', email: 'Bob@Example.test', status: 'member', isYou: false },
    { role: 'lm_bob_2', name: 'bob', email: 'bob2@example.test', status: 'invited', isYou: false },
    { role: 'lm_cy_3', name: 'cy', email: 'cy@example.test', status: 'member', isYou: false },
  ];

  it('takes the role, the email, or the name', () => {
    expect(resolveMemberRef(roster, 'lm_bob_1').role).toBe('lm_bob_1');
    expect(resolveMemberRef(roster, 'bob@example.test').role, 'case-insensitive').toBe('lm_bob_1');
    expect(resolveMemberRef(roster, 'cy').role).toBe('lm_cy_3');
  });

  it('refuses a name two people share rather than picking one', () => {
    // The operations behind this take somebody's access away. Guessing is not a
    // recoverable mistake.
    expect(() => resolveMemberRef(roster, 'bob')).toThrow(/matches 2 members/);
    expect(() => resolveMemberRef(roster, 'bob')).toThrow(/lm_bob_1, lm_bob_2/);
  });

  it('never resolves to the owner', () => {
    // An owner cannot be removed from their own cloud, and "share with yourself"
    // is not a thing — so the owner row is not a candidate at all.
    expect(() => resolveMemberRef(roster, 'ada')).toThrow(/No member "ada"/);
  });

  it('lists who there is when nothing matches', () => {
    expect(() => resolveMemberRef(roster, 'nobody')).toThrow(/lm_bob_1, lm_bob_2, lm_cy_3/);
  });
});

// ── secure ──────────────────────────────────────────────────────────────────

describe('cloud secure', () => {
  /** A workspace opened WITHOUT its built-in tables — the failure being guarded. */
  function partiallyOpened(tables: string[]): Lattice {
    return {
      getRegisteredTableNames: () => tables,
      close: () => undefined,
    } as unknown as Lattice;
  }

  it('refuses a workspace opened without the file index and secret store', async () => {
    // Securing walks the tables the workspace registered. A caller that opened it
    // without the built-ins would secure everything EXCEPT files, secrets, and
    // private conversations — and report success. That is a silent privacy hole,
    // so it is a refusal instead.
    await expect(
      runCloudCommand({
        subcommand: 'secure',
        configPath: 'x.yml',
        open: () => Promise.resolve(partiallyOpened(['notes'])),
      }),
    ).rejects.toThrow(/without its built-in tables/);
    await expect(
      runCloudCommand({
        subcommand: 'secure',
        configPath: 'x.yml',
        open: () => Promise.resolve(partiallyOpened(['notes'])),
      }),
    ).rejects.toThrow(/files.*secrets|secrets.*files/s);
  });

  it('refuses a database that cannot be a cloud at all', async () => {
    const db = await localWorkspace();
    await expect(run(db, { subcommand: 'secure' })).rejects.toThrow(/Only a Postgres database/);
  });

  it('refuses a managed session, the same as every other membership verb', async () => {
    // Securing is not the harmless re-run "already a cloud" makes it sound: it
    // re-installs row security, re-stamps row ownership, and re-applies member
    // access. Against a database a manager provisioned, that rewrites state the
    // manager owns and its records never see. The browser app refused this from
    // the start; the command must refuse it identically, and it did not.
    let opened = false;
    await expect(
      runCloudCommand({
        subcommand: 'secure',
        configPath: 'x.yml',
        managed: true,
        open: () => {
          opened = true;
          return Promise.resolve(partiallyOpened([...NATIVE_ENTITY_NAMES]));
        },
      }),
    ).rejects.toThrow(/managed by your team/);
    expect(opened, 'the refusal is allowed to happen after the open, but it must happen').toBe(
      true,
    );
  });

  it('reports that refusal with the code its callers branch on', async () => {
    let thrown: unknown;
    try {
      await runCloudCommand({
        subcommand: 'secure',
        configPath: 'x.yml',
        managed: true,
        open: () => Promise.resolve(partiallyOpened([...NATIVE_ENTITY_NAMES])),
      });
    } catch (e) {
      thrown = e;
    }
    expect(cloudErrorCode(thrown)).toBe('cloud_managed');
  });
});

// ── invite / share usage ────────────────────────────────────────────────────

describe('usage errors name the flag that is missing', () => {
  it('invite without an address', async () => {
    const db = await localWorkspace();
    await expect(run(db, { subcommand: 'invite' })).rejects.toThrow(
      /Usage: lattice cloud invite --email/,
    );
  });

  it('revoke without a member', async () => {
    const db = await localWorkspace();
    await expect(run(db, { subcommand: 'revoke' })).rejects.toThrow(
      /Usage: lattice cloud revoke <member>/,
    );
  });

  it('share without a row', async () => {
    const db = await localWorkspace();
    await expect(run(db, { subcommand: 'share', table: 'notes' })).rejects.toThrow(
      /Usage: lattice cloud share/,
    );
  });

  it('share that asks for both an audience and one person', async () => {
    // "everyone" and "just Bob" are different operations in the database.
    // Silently letting one win is how a row ends up shared with the whole cloud.
    const db = await localWorkspace();
    await expect(
      run(db, {
        subcommand: 'share',
        table: 'notes',
        pk: 'n1',
        visibility: 'everyone',
        to: 'bob',
      }),
    ).rejects.toThrow(/not both/);
  });

  it('share that names a row but no audience', async () => {
    const db = await localWorkspace();
    await expect(run(db, { subcommand: 'share', table: 'notes', pk: 'n1' })).rejects.toThrow(
      /--visibility <private\|everyone> or --to <member>/,
    );
  });
});

// ── join ────────────────────────────────────────────────────────────────────

describe('cloud join', () => {
  it('needs a token, and says so', async () => {
    await expect(runCloudCommand({ subcommand: 'join' })).rejects.toThrow(
      /Usage: lattice cloud join --token/,
    );
  });

  it('needs an address when this machine has no identity to fall back on', async () => {
    // The token is encrypted TO an email address — that address is half of what
    // decrypts it, so it is real input and not a lookup. Guessing is not an
    // option, and neither is a decrypt failure the caller cannot explain.
    writeIdentity({ display_name: '', email: '' });
    await expect(runCloudCommand({ subcommand: 'join', token: 'abc' })).rejects.toThrow(
      /bound to the email address it was sent to/,
    );
  });

  it('uses this machine identity when the address is not given', async () => {
    // The common case: the person joining is the person the machine belongs to.
    // Reaching decryption with THAT address (and failing on the token) is the
    // proof it was used, without needing a real invite.
    writeIdentity({ display_name: 'Ada', email: 'ada@example.test' });
    await expect(
      runCloudCommand({ subcommand: 'join', token: 'not-a-real-token' }),
    ).rejects.toThrow();
    await expect(
      runCloudCommand({ subcommand: 'join', token: 'not-a-real-token' }),
    ).rejects.not.toThrow(/bound to the email address/);
  });

  it('never opens the current workspace — joining makes a new one', async () => {
    // A join that touched the open workspace is exactly the bug the capability
    // was written to stop: it used to repoint whatever was in front of the user.
    let openedIt = false;
    writeIdentity({ display_name: 'Ada', email: 'ada@example.test' });
    await expect(
      runCloudCommand({
        subcommand: 'join',
        token: 'not-a-real-token',
        configPath: 'x.yml',
        open: () => {
          openedIt = true;
          return Promise.reject(new Error('should not be called'));
        },
      }),
    ).rejects.toThrow();
    expect(openedIt).toBe(false);
  });

  it('refuses --json, because its result is a side effect', async () => {
    await expect(runCloudCommand({ subcommand: 'join', token: 'abc', json: true })).rejects.toThrow(
      /--json describes a result that can be read/,
    );
  });
});

describe('cloud join — getting the token in without publishing it', () => {
  /**
   * An invite token is not a handle that gets looked up somewhere. It DECRYPTS,
   * on this machine, to the host, port, database, user and password of the
   * member role the owner minted, and `join` connects with exactly those — so it
   * is a credential in the same sense a connection string is. The address it was
   * sent to is the other half of what decrypts it, and that half is `--email` on
   * the same command line, so a token in an argument is read out of the process
   * list together with everything needed to spend it.
   *
   * It therefore gets the same three ways in the connection string gets, and the
   * piped one is the documented one.
   *
   * Every case below is separated by ONE observable: a token that decrypted gets
   * as far as the probe and fails to REACH the database, while a token that did
   * not get through — or never arrived at all — fails earlier and differently.
   * That is what makes "the piped bytes were used" a measurement rather than an
   * assumption.
   */
  const EMAIL = 'ada@example.test';
  const UNREACHED = /Cloud DB unreachable|ECONNREFUSED|connect/i;
  const NEVER_DECRYPTED = /malformed or from an unsupported version/;

  /** A real invite, minted for a member login on a port nothing answers on. */
  function realToken(): string {
    return mintInviteToken({
      coords: { host: '127.0.0.1', port: 1, dbname: 'shared' },
      user: 'lm_ada',
      password: 'never-stored-anywhere',
      role: 'lm_ada',
      email: EMAIL,
      expiresAt: new Date(Date.now() + 86_400_000),
      workspaceName: 'Acme Cloud',
    });
  }

  /** Run `join`, and hand back whatever it threw. */
  async function joinAndCatch(args: Parameters<typeof runCloudCommand>[0]): Promise<string> {
    try {
      await runCloudCommand({ subcommand: 'join', email: EMAIL, ...args });
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('join resolved against an unreachable database, which it must not');
  }

  /** Run `join` with console.warn captured, and hand back what it warned. */
  async function joinAndCollectWarnings(
    args: Parameters<typeof runCloudCommand>[0],
  ): Promise<string> {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...parts: unknown[]): void => {
      warnings.push(parts.map(String).join(' '));
    };
    try {
      await joinAndCatch(args);
    } finally {
      console.warn = realWarn;
    }
    return warnings.join('\n');
  }

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[INVITE_TOKEN_ENV];
  });

  it('reads it from standard input, where nothing else can see it', async () => {
    const token = realToken();
    const message = await joinAndCatch({
      tokenStdin: true,
      readStdin: () => Promise.resolve(token + '\n'),
    });
    expect(message).not.toMatch(NEVER_DECRYPTED);
    expect(message).toMatch(UNREACHED);
  });

  it('uses the piped token even when an argument carried a different one', async () => {
    // The precedence, stated as an outcome: the argument here is garbage, so if
    // it were the one spent the redeem would fail before ever reaching a socket.
    const token = realToken();
    const message = await joinAndCatch({
      token: 'not-a-real-token',
      tokenStdin: true,
      readStdin: () => Promise.resolve(token),
    });
    expect(message).not.toMatch(NEVER_DECRYPTED);
    expect(message).toMatch(UNREACHED);
  });

  it("treats a bare '-' the same way, the way every other tool spells it", async () => {
    const token = realToken();
    const message = await joinAndCatch({
      token: '-',
      readStdin: () => Promise.resolve(token),
    });
    expect(message).not.toMatch(NEVER_DECRYPTED);
    expect(message).toMatch(UNREACHED);
  });

  it('reads it from the environment when nothing was typed', async () => {
    process.env[INVITE_TOKEN_ENV] = realToken();
    const message = await joinAndCatch({});
    expect(message).not.toMatch(NEVER_DECRYPTED);
    expect(message).toMatch(UNREACHED);
  });

  it('refuses when none of the three offered anything, and says all three', async () => {
    const message = await joinAndCatch({});
    expect(message).toContain('--token-stdin');
    expect(message).toContain(INVITE_TOKEN_ENV);
    expect(message).toContain('--token <token>');
  });

  it('refuses an empty pipe rather than falling through to a worse source', async () => {
    process.env[INVITE_TOKEN_ENV] = realToken();
    const message = await joinAndCatch({
      tokenStdin: true,
      readStdin: () => Promise.resolve('   \n'),
    });
    expect(message).toMatch(/Nothing arrived on standard input/);
  });

  it('still accepts the argument, and warns that the login must be treated as exposed', async () => {
    const warned = await joinAndCollectWarnings({ token: realToken() });
    expect(warned).toMatch(/process list/);
    expect(warned).toMatch(/history/);
    expect(warned).toMatch(/--token-stdin/);
    expect(warned).toContain(INVITE_TOKEN_ENV);
  });

  it('says nothing when the token never went through the process list', async () => {
    const token = realToken();
    const warned = await joinAndCollectWarnings({
      tokenStdin: true,
      readStdin: () => Promise.resolve(token),
    });
    expect(warned).not.toMatch(/process list/);
  });
});

// ── migrate ─────────────────────────────────────────────────────────────────

describe('cloud migrate', () => {
  it('needs somewhere to migrate to', async () => {
    const db = await localWorkspace();
    await expect(run(db, { subcommand: 'migrate' })).rejects.toThrow(
      /Usage: lattice cloud migrate --url-stdin/,
    );
  });

  it('refuses anything that is not a Postgres URL, and points at probe', async () => {
    const db = await localWorkspace();
    await expect(run(db, { subcommand: 'migrate', action: './some/file.db' })).rejects.toThrow(
      /Postgres database/,
    );
    await expect(run(db, { subcommand: 'migrate', action: './some/file.db' })).rejects.toThrow(
      /lattice cloud probe/,
    );
  });

  it('refuses a name that cannot become a credential key', async () => {
    // The name becomes the `${LATTICE_DB:…}` key, which is read back with a
    // strict charset — a name with nothing usable in it would resolve to
    // nothing, and open an empty database with no error at all.
    const db = await localWorkspace();
    await expect(
      run(db, {
        subcommand: 'migrate',
        action: 'postgres://u:p@127.0.0.1:1/shared',
        displayName: '!!!',
      }),
    ).rejects.toThrow(/needs at least one letter or number/);
  });

  it('reports an unreachable target as a refusal, and touches nothing', async () => {
    const db = await localWorkspace();
    await expect(
      run(db, { subcommand: 'migrate', action: 'postgres://u:p@127.0.0.1:1/shared' }),
    ).rejects.toThrow();
    // The source is still open and usable — the refusal happened before any of
    // the moving parts ran.
    expect(db.getDialect()).toBe('sqlite');
  });

  it('closes the workspace exactly once even though it hands the handle over', async () => {
    // Migrating surrenders the open handle part-way through, because the file
    // behind it has to be renamed. Closing twice is a real crash on some
    // adapters, so the hand-over and the outer cleanup have to agree.
    let closed = 0;
    const stub = {
      getDialect: () => 'sqlite',
      close: () => {
        closed++;
      },
    } as unknown as Lattice;
    await expect(
      runCloudCommand({
        subcommand: 'migrate',
        action: 'postgres://u:p@127.0.0.1:1/shared',
        configPath: 'x.yml',
        open: () => Promise.resolve(stub),
      }),
    ).rejects.toThrow();
    expect(closed).toBe(1);
  });

  it('refuses --json, because its result is a side effect', async () => {
    await expect(
      runCloudCommand({ subcommand: 'migrate', configPath: 'x.yml', json: true }),
    ).rejects.toThrow(/--json describes a result that can be read/);
  });
});

// ── Where the connection string comes from ──────────────────────────────────

describe('getting a connection string in without publishing it', () => {
  /**
   * A connection string carries the OWNER password — the role that can create
   * member roles. An argument is the worst place for it: while the command runs
   * every other user of the machine can read it out of the process list, and
   * afterwards the shell keeps it in a history file. The whole premise of this
   * command group is that administering a shared workspace from a server should
   * not require publishing a secret on that server, so it must not require
   * publishing one either.
   */
  const URL = 'postgres://owner:hunter2@127.0.0.1:1/shared';

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[CLOUD_URL_ENV];
  });

  it('reads it from standard input, where nothing else can see it', async () => {
    const db = await localWorkspace();
    // Unreachable target, so the verb refuses at the probe — what matters is
    // that it got the URL at all, and it can only have come from stdin.
    await expect(
      run(db, {
        subcommand: 'migrate',
        urlStdin: true,
        readStdin: () => Promise.resolve(URL + '\n'),
      }),
    ).rejects.toThrow(/Cloud DB unreachable|ECONNREFUSED|connect/i);
  });

  it("treats a bare '-' the same way, the way every other tool spells it", async () => {
    await expect(
      runCloudCommand({
        subcommand: 'probe',
        action: '-',
        readStdin: () => Promise.resolve(URL),
      }),
    ).resolves.toEqual(expect.arrayContaining([expect.stringContaining('Reachable:')]));
  });

  it('reads it from the environment when nothing was typed', async () => {
    process.env[CLOUD_URL_ENV] = URL;
    const lines = await runCloudCommand({ subcommand: 'probe' });
    expect(lines.join('\n')).toContain('Reachable:');
  });

  it('refuses when none of the three offered anything, and says all three', async () => {
    let thrown = '';
    try {
      await runCloudCommand({ subcommand: 'probe' });
    } catch (e) {
      thrown = (e as Error).message;
    }
    expect(thrown).toContain('--url-stdin');
    expect(thrown).toContain(CLOUD_URL_ENV);
  });

  it('refuses an empty pipe rather than falling through to a worse source', async () => {
    process.env[CLOUD_URL_ENV] = URL;
    await expect(
      runCloudCommand({
        subcommand: 'probe',
        urlStdin: true,
        readStdin: () => Promise.resolve('   \n'),
      }),
    ).rejects.toThrow(/Nothing arrived on standard input/);
  });

  it('still accepts the argument, and warns that the password must be treated as exposed', async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await runCloudCommand({ subcommand: 'probe', action: URL });
    } finally {
      console.warn = realWarn;
    }
    expect(warnings.join('\n')).toMatch(/process list/);
    expect(warnings.join('\n')).toMatch(/--url-stdin/);
  });

  it('says nothing when the string never went through the process list', async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await runCloudCommand({
        subcommand: 'probe',
        urlStdin: true,
        readStdin: () => Promise.resolve(URL),
      });
    } finally {
      console.warn = realWarn;
    }
    expect(warnings.join('\n')).not.toMatch(/process list/);
  });
});

// ── probe ───────────────────────────────────────────────────────────────────

describe('cloud probe', () => {
  it('needs a URL', async () => {
    await expect(runCloudCommand({ subcommand: 'probe' })).rejects.toThrow(
      /Usage: lattice cloud probe/,
    );
  });

  it('works with no workspace at all — it is what you run before you have one', async () => {
    // No configPath, no open function: probing must not require a workspace,
    // because the whole point is to check a database before pointing one at it.
    const lines = await runCloudCommand({ subcommand: 'probe', action: '/tmp/not-a-cloud.db' });
    expect(lines.join('\n')).toContain('Reachable:  yes');
    expect(lines.join('\n')).toContain('Database:   sqlite');
    expect(lines.join('\n')).toMatch(/Cloud:\s+no/);
  });

  it('reports an unreachable database as an answer, not a crash', async () => {
    const lines = await runCloudCommand({
      subcommand: 'probe',
      action: 'postgres://nobody:nothing@127.0.0.1:1/none',
    });
    expect(lines.join('\n')).toContain('Reachable:  no');
    expect(lines.join('\n')).toMatch(/Error:/);
  });

  it('emits parseable JSON under --json', async () => {
    const [payload] = await runCloudCommand({
      subcommand: 'probe',
      action: '/tmp/not-a-cloud.db',
      json: true,
    });
    const parsed = JSON.parse(payload ?? '') as { reachable: boolean; isCloud: boolean };
    expect(parsed.reachable).toBe(true);
    expect(parsed.isCloud).toBe(false);
  });
});

// ── which workspace ─────────────────────────────────────────────────────────

describe('choosing which workspace the command is about', () => {
  function newRoot(): string {
    rootSeq++;
    return ensureRootAt(join(scratch, `root-${String(rootSeq)}`));
  }

  it('uses an explicitly named config', () => {
    const path = join(scratch, 'explicit.yml');
    writeFileSync(path, 'name: x\ndb: ./x.db\nentities: {}\n', 'utf8');
    expect(resolveCloudTarget({ config: path, explicitConfig: true }).configPath).toBe(path);
  });

  it('refuses a named config that is not there, rather than falling back', () => {
    // A silent fallback to some other workspace would run an owner operation
    // against a database the caller did not name.
    expect(() =>
      resolveCloudTarget({ config: join(scratch, 'missing.yml'), explicitConfig: true }),
    ).toThrow(/No config file at/);
  });

  it('falls back to the active workspace in the root', () => {
    const root = newRoot();
    const ws = addWorkspace(root, { displayName: 'Shared' });
    const target = resolveCloudTarget({
      config: join(scratch, 'nothing-here.yml'),
      explicitConfig: false,
      root,
    });
    expect(target.configPath).toBe(resolveWorkspacePaths(root, ws).configPath);
    expect(target.latticeRoot).toBe(root);
  });

  it('says what to do when there is nothing to operate on', () => {
    const empty = join(scratch, 'no-root-here');
    mkdirSync(empty, { recursive: true });
    expect(() =>
      resolveCloudTarget({
        config: join(scratch, 'nothing-here.yml'),
        explicitConfig: false,
        root: empty,
      }),
    ).toThrow(/lattice init/);
  });
});

// ── formatting ──────────────────────────────────────────────────────────────

describe('the status report', () => {
  it('spells out every warning it found, and says so when there are none', () => {
    const clean = formatCloudStatus(
      { dialect: 'postgres', secured: true, role: 'ada', standing: 'owner', warnings: [] },
      '/w/x.yml',
    ).join('\n');
    expect(clean).toContain('You are:    the owner');
    expect(clean).toContain('Warnings:   none');

    const dirty = formatCloudStatus(
      {
        dialect: 'postgres',
        secured: true,
        role: 'ada',
        standing: 'owner',
        warnings: [{ table: 'notes', reason: 'row security is not forced' }],
      },
      '/w/x.yml',
    ).join('\n');
    expect(dirty).toContain('Warnings:   1');
    expect(dirty).toContain('- notes: row security is not forced');
  });

  it('tells a member what they are, without claiming they own anything', () => {
    const lines = formatCloudStatus(
      { dialect: 'postgres', secured: true, role: 'lm_bob', standing: 'member', warnings: [] },
      '/w/x.yml',
    ).join('\n');
    expect(lines).toContain('You are:    a member');
    expect(lines).not.toContain('owner');
  });

  it('points an unsecured Postgres at the command that secures it', () => {
    const lines = formatCloudStatus(
      { dialect: 'postgres', secured: false, role: 'ada', standing: 'not-a-cloud', warnings: [] },
      '/w/x.yml',
    ).join('\n');
    expect(lines).toContain('NOT installed');
    expect(lines).toContain('lattice cloud secure');
  });
});
