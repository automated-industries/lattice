import { resolve } from 'node:path';
import { Lattice } from '../lattice.js';
import { TeamsClient, TeamsHttpError, type TeamConnection } from './client.js';
import { serializeSchema, type SchemaSpec } from './schema-spec.js';

/**
 * Argument shape for `lattice teams <subcommand>`. Parsed by the top-
 * level CLI; this module just consumes the parsed values.
 */
export interface TeamsCliArgs {
  subcommand?: string | undefined;
  config: string;
  cloud?: string | undefined;
  token?: string | undefined;
  email?: string | undefined;
  /** For invite: the email the invitation is addressed to. */
  inviteeEmail?: string | undefined;
  name?: string | undefined;
  /** For register: the name to give the team being created. */
  teamName?: string | undefined;
  team?: string | undefined;
  teamId?: string | undefined;
  expires?: number | undefined;
  userId?: string | undefined;
  table?: string | undefined;
  pk?: string | undefined;
}

const TEAMS_USAGE = [
  'lattice teams <subcommand> [options]',
  '',
  'Subcommands:',
  '  register   Bootstrap on a fresh cloud: create user + team in one call',
  '             (requires --cloud --email --name --team-name)',
  '  join       Redeem an invitation (requires --cloud --token --email --name)',
  '  list       List your local team connections',
  '  members    List members of the team (--team)',
  '  invite     Generate an invitation (creator only; --team --invitee-email)',
  '  leave      Leave the team (--team)',
  '  destroy    Destroy the team (creator only; --team)',
  '  share      Share a local table (--team --table)',
  '  unshare    Stop sharing a table (--team --table)',
  '  shared     List shared objects (--team)',
  '  sync       Apply cloud-shared schemas locally (--team)',
  '  link       Link a local row (--team --table --pk)',
  '  unlink     Unlink a row (--team --table --pk)',
  '  pull       Pull change envelopes (--team)',
  '  push       Drain the outbox (--team)',
  '  status     Show sync status (--team)',
  '',
  'Options:',
  '  --cloud <url>          Cloud server URL (e.g. http://localhost:4317)',
  '  --token <token>        Bearer API token or invitation token',
  '  --email <email>        Your email (for register / join)',
  '  --invitee-email <e>    Recipient email (for invite — invitations are bound)',
  '  --name <name>          Your display name (for register / join)',
  '  --team-name <name>     Team name (for register)',
  '  --team <name>          Team name (resolves to a local connection)',
  '  --team-id <uuid>       Team id (disambiguates duplicate names)',
  '  --table <name>         Table name (for share / unshare / link / unlink)',
  '  --pk <id>              Row primary key (for link / unlink)',
  '  --expires <hours>      Invitation expiry in hours (default: 168 = 7 days)',
  '  --user-id <uuid>       User id to kick',
  '  --config, -c <path>    Local lattice config (default: ./lattice.config.yml)',
].join('\n');

export async function runTeamsCommand(args: TeamsCliArgs): Promise<void> {
  const sub = args.subcommand;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(TEAMS_USAGE);
    return;
  }

  try {
    switch (sub) {
      case 'register':
        await runRegister(args);
        return;
      case 'join':
        await runJoin(args);
        return;
      case 'list':
        await runList(args);
        return;
      case 'members':
        await runMembers(args);
        return;
      case 'invite':
        await runInvite(args);
        return;
      case 'leave':
        await runLeave(args);
        return;
      case 'destroy':
        await runDestroy(args);
        return;
      case 'share':
        await runShare(args);
        return;
      case 'unshare':
        await runUnshare(args);
        return;
      case 'shared':
        await runShared(args);
        return;
      case 'sync':
        await runSync(args);
        return;
      case 'link':
        await runLink(args);
        return;
      case 'unlink':
        await runUnlinkRow(args);
        return;
      case 'pull':
        await runPull(args);
        return;
      case 'push':
        await runPush(args);
        return;
      case 'status':
        await runStatus(args);
        return;
      default:
        console.error(`Unknown teams subcommand: ${sub}`);
        console.error(TEAMS_USAGE);
        process.exit(1);
    }
  } catch (e) {
    if (e instanceof TeamsHttpError) {
      console.error(`Error: ${e.message}`);
    } else {
      console.error(`Error: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function requireArg(args: TeamsCliArgs, key: keyof TeamsCliArgs, label: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Missing required option: --${label}`);
  }
  return v.trim();
}

async function openLocal(configPath: string): Promise<Lattice> {
  const db = new Lattice({ config: resolve(configPath) });
  await db.init();
  return db;
}

async function resolveConnection(client: TeamsClient, args: TeamsCliArgs): Promise<TeamConnection> {
  if (args.teamId) {
    const conns = await client.listConnections();
    const conn = conns.find((c) => c.team_id === args.teamId);
    if (!conn) throw new Error(`No local connection for team-id "${args.teamId}"`);
    return conn;
  }
  const team = requireArg(args, 'team', 'team');
  const conn = await client.findConnectionByName(team);
  if (!conn) throw new Error(`No local connection for team "${team}" — join it first`);
  return conn;
}

// ── Subcommands ────────────────────────────────────────────────────────────

async function runRegister(args: TeamsCliArgs): Promise<void> {
  const cloud = requireArg(args, 'cloud', 'cloud');
  const email = requireArg(args, 'email', 'email');
  const name = requireArg(args, 'name', 'name');
  const teamName = requireArg(args, 'teamName', 'team-name');
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const result = await client.register(cloud, email, name, teamName);
    await client.saveConnection({
      team_id: result.team.id,
      team_name: result.team.name,
      cloud_url: cloud,
      my_user_id: result.user.id,
      api_token: result.raw_token,
    });
    console.log(`Registered ${result.user.email} and created team "${result.team.name}".`);
    console.log(`  user-id: ${result.user.id}`);
    console.log(`  team-id: ${result.team.id}`);
    console.log('');
    console.log('Bootstrap API token (shown ONCE — save it now):');
    console.log(`  ${result.raw_token}`);
    console.log('');
    console.log(
      `Next: invite teammates with \`lattice teams invite --team ${result.team.name} --invitee-email <addr>\`.`,
    );
  } finally {
    db.close();
  }
}

async function runJoin(args: TeamsCliArgs): Promise<void> {
  const cloud = requireArg(args, 'cloud', 'cloud');
  const token = requireArg(args, 'token', 'token');
  const email = requireArg(args, 'email', 'email');
  const name = requireArg(args, 'name', 'name');
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const result = await client.redeemInvite(cloud, token, email, name);
    await client.saveConnection({
      team_id: result.team.id,
      team_name: result.team.name,
      cloud_url: cloud,
      my_user_id: result.user.id,
      api_token: result.raw_token,
    });
    console.log(`Joined team "${result.team.name}" (team-id: ${result.team.id}).`);
    console.log(`Local connection saved.`);
  } finally {
    db.close();
  }
}

async function runList(args: TeamsCliArgs): Promise<void> {
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conns = await client.listConnections();
    if (conns.length === 0) {
      console.log('No team connections — use `lattice teams register` or `lattice teams join`.');
      return;
    }
    for (const c of conns) {
      console.log(`${c.team_name}  (id: ${c.team_id})  @ ${c.cloud_url}`);
    }
  } finally {
    db.close();
  }
}

async function runMembers(args: TeamsCliArgs): Promise<void> {
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conn = await resolveConnection(client, args);
    const members = await client.listMembers(conn.cloud_url, conn.api_token, conn.team_id);
    if (members.length === 0) {
      console.log(`Team "${conn.team_name}" has no members (?!).`);
      return;
    }
    for (const m of members) {
      const label = m.name ?? m.email ?? '(unknown)';
      console.log(`${m.role.padEnd(8)} ${label}  <${m.email ?? ''}>  (user-id: ${m.user_id})`);
    }
  } finally {
    db.close();
  }
}

async function runInvite(args: TeamsCliArgs): Promise<void> {
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conn = await resolveConnection(client, args);
    const inviteeEmail = requireArg(args, 'inviteeEmail', '--invitee-email');
    const result = await client.invite(
      conn.cloud_url,
      conn.api_token,
      conn.team_id,
      inviteeEmail,
      args.expires,
    );
    console.log(`Invitation generated for ${inviteeEmail} (expires ${result.expires_at}).`);
    console.log('');
    console.log('Share this token with the invitee (one-time use):');
    console.log(`  ${result.raw_token}`);
    console.log('');
    console.log(
      `Invitee runs: lattice teams join --cloud ${conn.cloud_url} --token <above> --email ${inviteeEmail} --name "<their-name>"`,
    );
  } finally {
    db.close();
  }
}

async function runLeave(args: TeamsCliArgs): Promise<void> {
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conn = await resolveConnection(client, args);
    // Phase 2 doesn't have a dedicated /leave endpoint — a member kicks
    // themselves via the kick endpoint on their own user_id. The cloud
    // accepts a creator kicking themselves only via destroy (handled
    // separately); members can self-kick freely.
    try {
      await client.kickMember(conn.cloud_url, conn.api_token, conn.team_id, conn.my_user_id);
    } catch (e) {
      if (e instanceof TeamsHttpError && e.status === 400) {
        // Creator self-kick is blocked — they need to destroy instead.
        throw new Error(
          `You are the creator of "${conn.team_name}". Use \`lattice teams destroy --team "${conn.team_name}"\` to remove it.`,
        );
      }
      throw e;
    }
    await client.deleteConnection(conn.team_id);
    console.log(`Left team "${conn.team_name}".`);
  } finally {
    db.close();
  }
}

async function runDestroy(args: TeamsCliArgs): Promise<void> {
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conn = await resolveConnection(client, args);
    await client.destroyTeam(conn.cloud_url, conn.api_token);
    await client.deleteConnection(conn.team_id);
    console.log(`Destroyed team "${conn.team_name}".`);
  } finally {
    db.close();
  }
}

async function runShare(args: TeamsCliArgs): Promise<void> {
  const table = requireArg(args, 'table', 'table');
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conn = await resolveConnection(client, args);
    const columns = db.getRegisteredColumns(table);
    if (!columns) {
      throw new Error(
        `Table "${table}" is not registered in this local lattice. Ensure it's declared in your config and that you ran the share command from the right project directory.`,
      );
    }
    const pkCols = db.getPrimaryKey(table);
    const spec: SchemaSpec = serializeSchema({ columns, render: () => '', outputFile: '' }, pkCols);
    const result = await client.shareObject(
      conn.cloud_url,
      conn.api_token,
      conn.team_id,
      table,
      spec,
    );
    console.log(
      `Shared "${table}" with "${conn.team_name}" (schema_version ${result.schema_version.toString()}, seq ${result.seq.toString()}).`,
    );
  } finally {
    db.close();
  }
}

async function runUnshare(args: TeamsCliArgs): Promise<void> {
  const table = requireArg(args, 'table', 'table');
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conn = await resolveConnection(client, args);
    await client.unshareObject(conn.cloud_url, conn.api_token, conn.team_id, table);
    console.log(`Unshared "${table}" from "${conn.team_name}".`);
  } finally {
    db.close();
  }
}

async function runShared(args: TeamsCliArgs): Promise<void> {
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conn = await resolveConnection(client, args);
    const objects = await client.listSharedObjects(conn.cloud_url, conn.api_token, conn.team_id);
    if (objects.length === 0) {
      console.log(`Team "${conn.team_name}" has no shared objects.`);
      return;
    }
    for (const obj of objects) {
      const colCount = Object.keys(obj.schema_spec.columns).length;
      console.log(
        `${obj.table.padEnd(24)}  v${obj.schema_version.toString().padEnd(3)}  ${colCount.toString().padStart(3)} cols  updated ${obj.updated_at}`,
      );
    }
  } finally {
    db.close();
  }
}

async function runSync(args: TeamsCliArgs): Promise<void> {
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conn = await resolveConnection(client, args);
    const result = await client.syncSharedSchemas(conn);
    if (result.applied.length === 0 && result.conflicts.length === 0) {
      console.log(`Already up to date with "${conn.team_name}".`);
    }
    for (const a of result.applied) {
      console.log(`✓ ${a.table}  (schema_version ${a.schema_version.toString()})`);
    }
    for (const c of result.conflicts) {
      console.error(`✗ ${c.table}: ${c.reason}`);
    }
    if (result.conflicts.length > 0) {
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

async function runLink(args: TeamsCliArgs): Promise<void> {
  const table = requireArg(args, 'table', 'table');
  const pk = requireArg(args, 'pk', 'pk');
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    await client.attachWriteHooks();
    const conn = await resolveConnection(client, args);
    const result = await client.linkRow(conn, table, pk);
    console.log(
      `Linked "${table}":${pk} to "${conn.team_name}" (owner-user-id: ${result.owner_user_id}; seq ${result.seq.toString()}).`,
    );
  } finally {
    db.close();
  }
}

async function runUnlinkRow(args: TeamsCliArgs): Promise<void> {
  const table = requireArg(args, 'table', 'table');
  const pk = requireArg(args, 'pk', 'pk');
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conn = await resolveConnection(client, args);
    await client.unlinkRow(conn, table, pk);
    console.log(`Unlinked "${table}":${pk} from "${conn.team_name}".`);
  } finally {
    db.close();
  }
}

async function runPull(args: TeamsCliArgs): Promise<void> {
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    await client.attachWriteHooks();
    const conn = await resolveConnection(client, args);
    const result = await client.pullChanges(conn);
    console.log(
      `Pulled ${result.applied.toString()} envelope(s) from "${conn.team_name}". ` +
        `last_seq=${result.last_seq.toString()}, dlq+=${result.dlq_count.toString()}.`,
    );
  } finally {
    db.close();
  }
}

async function runPush(args: TeamsCliArgs): Promise<void> {
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    await client.attachWriteHooks();
    const conn = await resolveConnection(client, args);
    const result = await client.drainOutbox(conn);
    console.log(
      `Pushed ${result.pushed.toString()} outbox entries to "${conn.team_name}"; ${result.failed.toString()} failed (will retry).`,
    );
    if (result.failed > 0) process.exit(1);
  } finally {
    db.close();
  }
}

async function runStatus(args: TeamsCliArgs): Promise<void> {
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const conn = await resolveConnection(client, args);
    const status = await client.getStatus(conn);
    console.log(`Team:           ${status.team_name}  (${status.team_id})`);
    console.log(`Last change seq: ${status.last_change_seq?.toString() ?? '(never pulled)'}`);
    console.log(`Local links:     ${status.local_links.toString()}`);
    console.log(
      `Outbox depth:    ${status.outbox_depth.toString()}  (failing: ${status.outbox_failing.toString()})`,
    );
    console.log(`DLQ depth:       ${status.dlq_depth.toString()}`);
  } finally {
    db.close();
  }
}
