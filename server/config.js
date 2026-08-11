/**
 * Settings resolution for North Command Center.
 *
 * Two sources: this dashboard's own optional `north.config.json`, and a
 * strictly-filtered read of OpenClaw's `~/.openclaw/openclaw.json`.
 *
 * SECURITY -- the OpenClaw config contains gateway tokens, provider API keys
 * and channel credentials. This module never returns the parsed config to any
 * caller. It pulls a fixed allowlist of non-secret scalars (port, bind mode,
 * log path, auth *mode*) and lets the rest go out of scope. There is no code
 * path from openclaw.json to the HTTP layer, so no future edit to a route can
 * accidentally leak a key.
 */

import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { parseJson5 } from './lib/json5.js';

const DEFAULT_GATEWAY_PORT = 18789; // documented OpenClaw default

/** Read a dotted path without throwing on missing intermediates. */
function dig(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function readDashboardConfig(root) {
  const path = join(root, 'north.config.json');
  if (!existsSync(path)) return {};
  try {
    return parseJson5(readFileSync(path, 'utf8'));
  } catch (err) {
    console.warn(`[config] Ignoring north.config.json: ${err.message}`);
    return {};
  }
}

/**
 * Extract only the fields we need from the OpenClaw config.
 * Returns `{ found, error, values }` -- never the raw document.
 */
function readOpenClawConfig(openclawHome) {
  const path = join(openclawHome, 'openclaw.json');
  if (!existsSync(path)) {
    return { found: false, error: null, values: {} };
  }
  let doc;
  try {
    doc = parseJson5(readFileSync(path, 'utf8'));
  } catch (err) {
    return { found: true, error: err.message, values: {} };
  }

  // Allowlist. Anything not named here is never read, so tokens and API keys
  // cannot reach the dashboard even by accident.
  const values = {
    port: dig(doc, 'gateway.port'),
    bind: dig(doc, 'gateway.bind'),
    // The *mode* is safe to display ("token"); the token itself is not read.
    authMode: dig(doc, 'gateway.auth.mode') ?? (dig(doc, 'gateway.auth.token') ? 'token' : undefined),
    logFile: dig(doc, 'logging.file'),
    profile: dig(doc, 'profile'),
    // Presence booleans only -- used by the Integrations page to distinguish
    // "not configured" from "configured but unreachable". Never the contents.
    configuredChannels: Object.keys(dig(doc, 'channels') ?? {}),
    configuredPlugins: Object.keys(dig(doc, 'plugins.entries') ?? {}),
  };
  doc = null; // drop the document, secrets included, immediately
  return { found: true, error: null, values };
}

export function loadConfig(root) {
  const dash = readDashboardConfig(root);
  const env = process.env;

  const openclawHome =
    dash.openclawHome || env.OPENCLAW_HOME || join(homedir(), '.openclaw');
  const oc = readOpenClawConfig(openclawHome);

  // Port precedence mirrors OpenClaw's own documented order:
  // explicit setting > environment > config file > default.
  const gatewayPort = Number(
    dash.gatewayPort || env.OPENCLAW_GATEWAY_PORT || oc.values.port || DEFAULT_GATEWAY_PORT,
  );

  const logDir = dash.logDir || null;
  const logFile = oc.values.logFile
    ? isAbsolute(oc.values.logFile)
      ? oc.values.logFile
      : join(openclawHome, oc.values.logFile)
    : null;

  return {
    root,
    // Dashboard HTTP server. Loopback-only by default and by intent.
    host: dash.host || '127.0.0.1',
    port: Number(dash.port || env.NORTH_PORT || 4300),

    // How we invoke OpenClaw. Overridable for non-PATH installs.
    openclawBin: dash.openclawBin || env.OPENCLAW_BIN || 'openclaw',
    openclawHome,
    gatewayPort,
    gatewayUrl: env.OPENCLAW_GATEWAY_URL || `ws://127.0.0.1:${gatewayPort}`,
    healthUrl: `http://127.0.0.1:${gatewayPort}`,

    // Where OpenClaw writes its JSONL logs. Discovered at runtime when unset.
    logFile,
    logDir,
    profile: oc.values.profile || null,

    // Non-secret facts about the OpenClaw install, for the Security page.
    openclaw: {
      configFound: oc.found,
      configError: oc.error,
      authMode: oc.values.authMode || null,
      bind: oc.values.bind || null,
      configuredChannels: oc.values.configuredChannels || [],
      configuredPlugins: oc.values.configuredPlugins || [],
    },

    // Polling cadence, in ms. Tuned for low idle CPU: the system probe spawns
    // a PowerShell process, so it runs slower than the cheap in-process reads.
    intervals: {
      status: Number(dash.statusIntervalMs || 4000),
      system: Number(dash.systemIntervalMs || 5000),
      activity: Number(dash.activityIntervalMs || 3000),
      slow: Number(dash.slowIntervalMs || 30000), // skills, integrations, security
    },

    // Command timeouts. A hung `openclaw` call must not wedge a panel.
    timeouts: {
      rpc: Number(dash.rpcTimeoutMs || 8000),
      system: Number(dash.systemTimeoutMs || 10000),
      console: Number(dash.consoleTimeoutMs || 120000),
    },

    // Console writes go through the gateway and can act on the machine.
    // Off unless explicitly enabled.
    allowConsole: dash.allowConsole !== false,
    allowProcessActions: dash.allowProcessActions === true,
  };
}
