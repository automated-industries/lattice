import { resolve } from 'node:path';
import { Lattice } from '../lattice.js';
import { TeamsClient, TeamsHttpError, type TeamConnection } from './client.js';

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
  name?: string | undefined;
  team?: string | undefined;
  teamId?: string | undefined;
  expires?: number | undefined;
  userId?: string | undefined;
}

const TEAMS_USAGE = [
  'lattice teams <subcommand> [options]',
  '',
  'Subcommands:',
  '  register   Bootstrap-register on a fresh cloud (no users yet)',
  '  create     Create a team (requires --cloud --token --name)',
  '  join       Redeem an invitation (requires --cloud --token --email --name)',
  '  list       List local team connections',
  '  members    List members of a team (--team or --team-id)',
  '  invite     Generate an invitation token (creator only; --team)',
  '  leave      Leave a team (--team)',
  '  destroy    Soft-delete a team (creator only; --team)',
  '',
  'Options:',
  '  --cloud <url>          Cloud server URL (e.g. http://localhost:4317)',
  '  --token <token>        Bearer API token or invitation token',
  '  --email <email>        Email address (for register / join)',
  '  --name <name>          Display name (for register / join) OR team name (for create)',
  '  --team <name>          Team name (resolves to a local connection)',
  '  --team-id <uuid>       Team id (disambiguates duplicate names)',
  '  --expires <hours>      Invitation expiry in hours (default: 168 = 7 days)',
  '  --user-id <uuid>       User id to kick (with members --kick)',
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
      case 'create':
        await runCreate(args);
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
  // Register doesn't persist locally — there's no team_id yet. The token
  // is printed; the operator passes it to subsequent `create` calls via
  // --token. After they create their first team, the connection (with the
  // team_id) lands in __lattice_team_connections.
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const result = await client.register(cloud, email, name);
    console.log(`Registered ${result.user.email} (user-id: ${result.user.id})`);
    console.log('');
    console.log('Bootstrap API token (shown ONCE — save it now):');
    console.log(`  ${result.raw_token}`);
    console.log('');
    console.log('Next: `lattice teams create --cloud <url> --token <above> --name "<team>"`');
  } finally {
    db.close();
  }
}

async function runCreate(args: TeamsCliArgs): Promise<void> {
  const cloud = requireArg(args, 'cloud', 'cloud');
  const token = requireArg(args, 'token', 'token');
  const name = requireArg(args, 'name', 'name');
  const db = await openLocal(args.config);
  try {
    const client = new TeamsClient(db);
    const team = await client.createTeam(cloud, token, name);
    const me = await client.me(cloud, token);
    await client.saveConnection({
      team_id: team.id,
      team_name: team.name,
      cloud_url: cloud,
      my_user_id: me.user.id,
      api_token: token,
    });
    console.log(`Created team "${team.name}" (team-id: ${team.id}); role: ${team.role}`);
    console.log(`Local connection saved.`);
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
      console.log('No team connections — use `lattice teams join` or `lattice teams create`.');
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
    const result = await client.invite(conn.cloud_url, conn.api_token, conn.team_id, args.expires);
    console.log(`Invitation generated (expires ${result.expires_at}).`);
    console.log('');
    console.log('Share this token with the invitee (one-time use):');
    console.log(`  ${result.raw_token}`);
    console.log('');
    console.log(
      `Invitee runs: lattice teams join --cloud ${conn.cloud_url} --token <above> --email <their-email> --name "<their-name>"`,
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
    await client.deleteTeam(conn.cloud_url, conn.api_token, conn.team_id);
    await client.deleteConnection(conn.team_id);
    console.log(`Destroyed team "${conn.team_name}".`);
  } finally {
    db.close();
  }
}
