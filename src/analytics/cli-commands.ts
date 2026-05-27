import {
  readAnalyticsConfig,
  writeAnalyticsConfig,
  type AnalyticsConfig,
} from '../framework/analytics.js';

export interface AnalyticsCliArgs {
  subcommand?: string | undefined;
}

const USAGE = [
  'lattice analytics <subcommand>',
  '',
  'Subcommands:',
  '  on       Enable usage analytics (default).',
  '  off      Disable usage analytics. Zero network calls afterward.',
  '  status   Print the current config (enabled, anonymous_id, set_at).',
  '',
  'Analytics are opt-out. Function names + package version + a per-install',
  "random anonymous_id are sent to https://www.latticesql.com/api/telemetry.",
  'No PII, no row data, no cloud URLs. Override with LATTICE_ANALYTICS=off.',
].join('\n');

function printStatus(cfg: AnalyticsConfig): void {
  console.log(`enabled:      ${cfg.enabled ? 'on' : 'off'}`);
  console.log(`anonymous_id: ${cfg.anonymous_id}`);
  console.log(`set_at:       ${cfg.set_at}`);
}

export function runAnalyticsCommand(args: AnalyticsCliArgs): void {
  const sub = args.subcommand;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return;
  }
  switch (sub) {
    case 'on': {
      const next = writeAnalyticsConfig({ enabled: true });
      console.log('Lattice analytics enabled.');
      printStatus(next);
      return;
    }
    case 'off': {
      const next = writeAnalyticsConfig({ enabled: false });
      console.log('Lattice analytics disabled. Zero network calls.');
      printStatus(next);
      return;
    }
    case 'status': {
      printStatus(readAnalyticsConfig());
      return;
    }
    default:
      console.error(`Unknown subcommand "${sub}".\n\n${USAGE}`);
      process.exitCode = 1;
  }
}
