#!/usr/bin/env node
/**
 * north doctor -- check what North Command Center can actually reach.
 *
 * Run this first when a panel says "unavailable". It reports the same probes
 * the dashboard uses, one line each, so you can tell a missing binary from a
 * stopped gateway from a permissions problem without reading the UI.
 *
 *   npm run doctor
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createTransport } from '../server/adapters/transport.js';
import { TtlCache } from '../server/lib/cache.js';
import { NorthAdapter } from '../server/adapters/openclaw.js';
import { WindowsAdapter } from '../server/adapters/windows.js';
import * as R from '../server/lib/result.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(ROOT);
const transport = createTransport(config);
const north = new NorthAdapter(transport, new TtlCache(), config);
const windows = new WindowsAdapter(config);

const PASS = '  ok  ';
const FAIL = ' FAIL ';
const WARN = ' warn ';

function line(mark, label, detail) {
  console.log(`[${mark}] ${label.padEnd(26)} ${detail ?? ''}`);
}

function report(label, result, { optional = false } = {}) {
  if (R.isOk(result)) {
    const ms = Number.isFinite(result.ms) ? `${Math.round(result.ms)}ms` : '';
    line(PASS, label, ms);
    return true;
  }
  line(optional ? WARN : FAIL, label, result.reason ?? result.state);
  return false;
}

console.log('\nNorth Command Center -- environment check\n');

line('  ..  ', 'Platform', `${process.platform} · node ${process.version}`);
line('  ..  ', 'OpenClaw home', config.openclawHome);
line(
  config.openclaw.configFound ? PASS : WARN,
  'openclaw.json',
  config.openclaw.configFound
    ? config.openclaw.configError
      ? `parsed with errors: ${config.openclaw.configError}`
      : `found · auth ${config.openclaw.authMode ?? 'unspecified'}`
    : 'not found (defaults will be used)',
);

const bin = transport.binary();
line(bin ? PASS : FAIL, 'openclaw binary', bin ?? 'not found on PATH — set openclawBin in north.config.json');

console.log('');

const health = await north.gatewayHealth();
report(`gateway :${config.gatewayPort}`, health);

if (R.isOk(health) || bin) {
  report('status', await north.gatewayStatus(), { optional: true });
  report('sessions.list', await north.sessions(), { optional: true });
  report('models.list', await north.models(), { optional: true });
  report('usage.status', await north.usage(), { optional: true });
  report('audit.activity.list', await north.activity(5), { optional: true });
  report('logs.tail', await north.logs(5), { optional: true });
  report('skills.status', await north.skills(), { optional: true });
  report('channels.status', await north.channels(), { optional: true });
  report('plugins.list', await north.plugins(), { optional: true });
  report('tools.effective', await north.tools(), { optional: true });
}

console.log('');
if (windows.supported) {
  report('PowerShell probe', await windows.system());
  report('Application list', await windows.apps());
} else {
  line(WARN, 'System telemetry', windows.unavailableReason);
}

console.log(`\nDashboard would serve on http://${config.host}:${config.port}\n`);
windows.shutdown();
process.exit(0);
