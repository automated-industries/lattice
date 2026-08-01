/**
 * A published doc that describes a product other than the one in the box is a
 * defect in the package, not a tidiness problem — it is the only description most
 * readers ever get, and it ships inside the tarball.
 *
 * Three of them had drifted, all in the same direction: each denied a capability
 * that now exists, so a reader is told to go and do something a different way, or
 * that they cannot do it at all.
 *
 *   1. The assistant is described as GUI-only. There is a command for it.
 *   2. The cloud section says an invite is a set of credentials and "there is no
 *      token to redeem". There are commands to mint a token and to redeem one.
 *   3. The import guide describes the importer as reading a JSON object or an
 *      Excel workbook. It also reads delimited files and Word / PowerPoint
 *      documents.
 *
 * A fourth had drifted the OTHER way, which is worse: both the import guide and
 * the assistant guide called an import "undoable", and it was not — nothing about
 * an import could be reversed, in one action or any number. A doc that promises
 * less than the product costs a reader a detour; a doc that promises a safety net
 * the product does not have costs them their data.
 *
 * Every claim here is checked in two steps, in this order: first find out what the
 * product ACTUALLY does by driving the real command as its own process (or the
 * real reader function), then hold the doc to that. Asserting on the prose alone
 * would pin today's wording and re-rot the moment the code moved again — the
 * point is to fail when the doc and the product disagree, whichever of them moved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readImportSource } from '../../src/ops/import-apply.js';
import { homeOfItsOwn } from './helpers/home-of-its-own.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');
/** Runs the command's own source as a real process — no build step required. */
const RUNNER = join(REPO_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');

const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
const ASSISTANT_DOC = readFileSync(join(REPO_ROOT, 'docs', 'assistant.md'), 'utf8');
const IMPORTING_DOC = readFileSync(join(REPO_ROOT, 'docs', 'importing.md'), 'utf8');
const CLI_DOC = readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8');
const CLOUD_DOC = readFileSync(join(REPO_ROOT, 'docs', 'cloud.md'), 'utf8');

let scratch: string;
/** The home every command below is given, in place of the one running the tests. */
let home: { HOME: string; USERPROFILE: string };

beforeAll(() => {
  expect(existsSync(RUNNER), `command runner missing at ${RUNNER}`).toBe(true);
  scratch = mkdtempSync(join(tmpdir(), 'lattice-docs-truth-'));
  home = homeOfItsOwn(join(scratch, 'home'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Run the real command as its own process, entirely inside the scratch tree. */
function runCli(args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [RUNNER, '--root', REPO_ROOT, CLI_ENTRY, '--', ...args], {
      cwd: REPO_ROOT,
      timeout: 120_000,
      env: {
        ...process.env,
        ...home,
        LATTICE_CONFIG_DIR: join(scratch, 'machine-config'),
        LATTICE_ROOT: join(scratch, 'lattice-root'),
        LATTICE_ENCRYPTION_KEY: Buffer.alloc(32, 61).toString('base64'),
        LATTICE_IDENTITY_MANIFEST: 'http://127.0.0.1:1/nowhere',
      },
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (out += c));
    child.on('error', fail);
    child.on('close', (status) => {
      settle({ status, output: out });
    });
  });
}

/** The one sentence an unknown verb produces. Anything else means it is real. */
const UNKNOWN = /Unknown command/;

describe('the assistant is not GUI-only, and the docs must not say it is', () => {
  it('there is a command for it', async () => {
    const help = await runCli(['--help']);
    expect(help.output, 'the command list offers it').toMatch(/\bask\b/);
    expect(help.output).toMatch(/Ask the assistant one question/);

    // And it is a real verb, not a listed one that falls through: asked with no
    // workspace and no credential it refuses for its OWN reason.
    const run = await runCli(['ask', 'what is in here?']);
    expect(run.output, 'it is dispatched, not rejected as unknown').not.toMatch(UNKNOWN);
    expect(run.status, 'and it exits as a failure, having nothing to answer with').not.toBe(0);
  });

  it('neither doc claims the assistant is GUI-only', () => {
    for (const [name, text] of [
      ['README.md', README],
      ['docs/assistant.md', ASSISTANT_DOC],
    ] as const) {
      expect(text, `${name} does not call the assistant GUI-only`).not.toMatch(/GUI-only/i);
    }
  });

  it('both docs point at the command', () => {
    expect(ASSISTANT_DOC, 'the assistant guide names the command').toMatch(/lattice ask/);
    expect(README, 'and so does the README').toMatch(/lattice ask/);
  });
});

describe('a cloud invite IS a token, and the README must not deny it', () => {
  it('there are commands to mint one and to redeem one', async () => {
    const help = await runCli(['cloud', '--help']);
    expect(help.output, 'minting is listed').toMatch(/cloud invite --email/);
    expect(help.output, 'redeeming is listed').toMatch(/cloud join --token/);

    // Real verbs: driven with nothing behind them they refuse with their own
    // usage line, not as an unrecognised subcommand.
    const join_ = await runCli(['cloud', 'join']);
    expect(join_.output).not.toMatch(UNKNOWN);
    expect(join_.output).toMatch(/lattice cloud join --token/);
    expect(join_.status).not.toBe(0);
  });

  it('the README does not say there is no token to redeem', () => {
    expect(README, 'the denial is gone').not.toMatch(/no token to redeem/i);
    expect(
      README,
      'and the credentials-are-the-invite framing does not stand alone as the only way in',
    ).toMatch(/lattice cloud invite/);
    expect(README, 'the redeeming half is documented too').toMatch(/lattice cloud join/);
  });
});

describe('the importer reads more than JSON and Excel, and the guide must say so', () => {
  it('a delimited file and a Word document both go through the real reader', async () => {
    const csv = join(scratch, 'rates.csv');
    writeFileSync(csv, 'name,rate\nalpha,10\nbeta,20\n', 'utf8');
    const source = await readImportSource(csv, 'rates.csv');
    expect(
      Object.keys(source.data).length,
      'the delimited file produced records, so CSV is a supported source',
    ).toBeGreaterThan(0);

    // The document branch is chosen by extension before any parsing, so the
    // proof it exists is that identical bytes take a DIFFERENT path under a
    // .docx name than under an unrecognized one. Naming it .docx yields a
    // document read; naming it .bin falls through to JSON and complains.
    const bytes = 'not really a document';
    const asDocx = join(scratch, 'report.docx');
    const asUnknown = join(scratch, 'report.bin');
    mkdirSync(dirname(asDocx), { recursive: true });
    writeFileSync(asDocx, bytes, 'utf8');
    writeFileSync(asUnknown, bytes, 'utf8');

    const doc = await readImportSource(asDocx, 'report.docx');
    expect(doc.name, 'the document branch handled it').toBe('report.docx');
    await expect(
      readImportSource(asUnknown, 'report.bin'),
      'the same bytes under an unknown name fall through to JSON — so .docx is its own path',
    ).rejects.toThrow(/not valid JSON/);
  });

  it('the guide does not frame the importer as JSON plus Excel only', () => {
    const lead = IMPORTING_DOC.slice(0, IMPORTING_DOC.indexOf('## What it does'));
    expect(lead, 'the opening names the delimited sources').toMatch(/\bCSV\b/i);
    expect(lead, 'and the document sources').toMatch(/\.docx|Word/i);
  });
});

describe('an import is not undoable, and neither guide may say it is', () => {
  it('a real import records that it cannot be undone in one step', async () => {
    const home = join(scratch, 'stock');
    mkdirSync(join(home, 'data'), { recursive: true });
    const configPath = join(home, 'lattice.config.yml');
    writeFileSync(configPath, 'db: ./data/stock.db\n\nentities: {}\n', 'utf8');
    const csv = join(home, 'stock.csv');
    writeFileSync(csv, 'part,depot,onhand\nP-1,North,4\nP-2,South,9\nP-3,North,2\n', 'utf8');

    const imported = await runCli(['import', csv, '--config', configPath]);
    expect(imported.status, `import failed:\n${imported.output}`).toBe(0);
    expect(imported.output).toMatch(/Imported stock\.csv/);

    // The change log is what a reader is being pointed at, so read back what the
    // import really left in it. The entry must state that this cannot be undone in
    // one step — which is what makes a doc calling an import "undoable" a
    // contradiction of the product itself, not of this test's taste in wording.
    const { openConfig, disposeActive } = await import('../../src/gui/lifecycle.js');
    const active = await openConfig(configPath, join(home, 'context'));
    try {
      const entries = (await active.db.query('_lattice_gui_audit', {})) as {
        operation: string;
        after_json: string | null;
      }[];
      const entry = entries.find((e) => e.operation === 'schema.import');
      expect(entry, 'the import left an entry in the change log').toBeTruthy();
      const payload = JSON.parse(entry!.after_json ?? '{}') as {
        reversible?: boolean;
        note?: string;
      };
      expect(payload.reversible, 'the product says an import is not reversible').toBe(false);
      expect((payload.note ?? '').toLowerCase()).toContain('cannot be undone in one step');
    } finally {
      await disposeActive(active);
    }
  });

  it('neither guide calls an import undoable', () => {
    // Scanned on a whitespace-FLATTENED document, not line by line. Both claims
    // this replaced were wrapped across two lines ("reported in the activity feed
    // (and is⏎undoable)"), so a per-line scan would have matched neither — a guard
    // that cannot fire on the very sentence it exists to stop is worse than none.
    //
    // The window back from "undoable" is a whole paragraph's worth, not a clause:
    // in the sentence this replaced, the subject ("Dropping a file imports it")
    // opened the paragraph and the claim closed it, 200 characters apart. A
    // tighter window reproduces the same blind spot in a different shape.
    const LOOKBACK = 400;
    for (const [name, doc] of [
      ['docs/importing.md', IMPORTING_DOC],
      ['docs/assistant.md', ASSISTANT_DOC],
    ] as const) {
      const flat = doc.replace(/\s+/g, ' ');
      const claims: string[] = [];
      for (const m of flat.matchAll(/\bundoable\b/gi)) {
        const from = Math.max(0, m.index - LOOKBACK);
        const context = flat.slice(from, m.index + 40);
        if (/\bimport(s|ed|ing|er)?\b/i.test(context)) claims.push('…' + context + '…');
      }
      expect(
        claims,
        `${name} still tells a reader an import is undoable, which the product refuses: ` +
          claims.join(' / '),
      ).toEqual([]);
    }
  });

  it('the import guide says what taking one back does and does not restore', () => {
    expect(
      IMPORTING_DOC,
      'the guide states plainly that an import cannot be undone in one step',
    ).toMatch(/cannot be undone in one step/i);
    expect(IMPORTING_DOC, 'and what an undo will NOT restore').toMatch(/will not remove/i);
  });
});

/**
 * The reference is the doc a reader opens to answer "what can I type?". A command
 * the product offers and the reference never mentions is unreachable in practice —
 * the reader has no reason to believe it exists. Rather than pin a list (which
 * re-rots the moment a command lands), ASK the product for its own command list and
 * hold the reference to that, so a command added without a doc fails here.
 */
describe('the CLI reference documents every command the product offers', () => {
  it('every verb in the product help has a section of its own', async () => {
    const help = await runCli(['--help']);
    expect(help.status, `--help failed:\n${help.output}`).toBe(0);

    // The help lists its commands in one indented block under "Commands:", each
    // starting a line as `  <name>  <summary>` with wrapped continuation lines
    // indented further. Take the first word of each command line.
    const block = help.output.split(/^Commands:\s*$/m)[1] ?? '';
    const listing = block.split(/\n\s*\n/)[0] ?? '';
    const commands = [
      ...new Set(
        listing
          .split('\n')
          .map((line) => /^ {2}([a-z][a-z-]*) {2,}\S/.exec(line)?.[1])
          .filter((name): name is string => name !== undefined),
      ),
    ];
    // A parse that finds nothing would make every assertion below vacuous.
    expect(commands.length, `parsed no commands out of the help:\n${help.output}`).toBeGreaterThan(
      10,
    );

    // A command counts as documented when the reference gives it a heading — a
    // passing mention inside another command's prose is how a reader misses it.
    // A heading may cover several related verbs at once (the retrieval group), so
    // the name is accepted either as `lattice <name>` or as its own code span.
    const headings = [...CLI_DOC.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1] ?? '');
    const undocumented = commands.filter((name) => {
      const named = new RegExp(`\\blattice ${name}\\b|\`${name}\\b`);
      return !headings.some((h) => named.test(h));
    });
    expect(
      undocumented,
      `docs/cli.md has no section for: ${undocumented.join(', ')} — a reader has no way to find them`,
    ).toEqual([]);
  });
});

/**
 * Administering a shared workspace was the flagship browser-only surface, and
 * docs/cloud.md is where somebody goes to learn how. It described the browser and
 * the library and never mentioned that there are commands — so the reader most in
 * need of them (a cloud on a server with no display) was told, in effect, to bind
 * the unauthenticated browser app to a network address.
 */
describe('a cloud is administered from a terminal, and its guide must say so', () => {
  it('the product offers every verb the guide should name', async () => {
    const help = await runCli(['cloud', '--help']);
    expect(help.status, `cloud --help failed:\n${help.output}`).toBe(0);
    for (const verb of [
      'status',
      'members',
      'secure',
      'invite',
      'join',
      'revoke',
      'share',
      'migrate',
      'probe',
    ]) {
      expect(help.output, `the product offers cloud ${verb}`).toMatch(
        new RegExp(`lattice cloud ${verb}\\b`),
      );
    }
  });

  it('the cloud guide names them', () => {
    for (const verb of [
      'status',
      'members',
      'secure',
      'invite',
      'join',
      'revoke',
      'share',
      'migrate',
      'probe',
    ]) {
      expect(CLOUD_DOC, `docs/cloud.md names \`lattice cloud ${verb}\``).toMatch(
        new RegExp(`lattice cloud ${verb}\\b`),
      );
    }
  });

  it('and does not present the browser as the way in', () => {
    // The three flows each used to open "From the GUI:" and nothing else. Each
    // must now offer a terminal path in the same breath.
    for (const flow of ['migrate', 'join', 'invite']) {
      const heading = new RegExp(`### \\d\\. ${flow}[^\\n]*\\n`, 'i');
      const at = heading.exec(CLOUD_DOC);
      expect(at, `docs/cloud.md still has a "${flow}" flow section`).toBeTruthy();
      const section = CLOUD_DOC.slice(at!.index, at!.index + 1200);
      expect(section, `the ${flow} flow offers a command, not only a click`).toMatch(
        /lattice cloud/,
      );
    }
  });
});

/**
 * Pointing a machine at a model is the FIRST thing anyone does, and the assistant
 * guide sent every reader to a settings screen — which a machine with no display
 * does not have, making every other headless surface moot.
 */
describe('a model is connected from a terminal, and the assistant guide must say so', () => {
  it('the product offers the verbs', async () => {
    const help = await runCli(['model', '--help']);
    expect(help.status, `model --help failed:\n${help.output}`).toBe(0);
    for (const verb of ['status', 'connect', 'subscription', 'account', 'use', 'test']) {
      expect(help.output, `the product offers model ${verb}`).toMatch(
        new RegExp(`lattice model ${verb}\\b`),
      );
    }

    // Real verb, not a listed one that falls through: with nothing configured it
    // refuses for its own reason rather than as an unknown command.
    const run = await runCli(['model', 'test']);
    expect(run.output).not.toMatch(UNKNOWN);
    expect(run.status, 'and it exits as a failure, having no model to test').not.toBe(0);
  });

  it('the assistant guide points at them rather than only at a settings screen', () => {
    expect(ASSISTANT_DOC, 'the guide names the command group').toMatch(/lattice model\b/);
    expect(ASSISTANT_DOC, 'and the verb that reports what is blocking a turn').toMatch(
      /lattice model status/,
    );
  });
});
