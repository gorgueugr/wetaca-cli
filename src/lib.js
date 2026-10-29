// wetaca-cli — core library: config, errors, GraphQL client, output.
// Zero dependencies. Node >= 18.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;

// ---------- exit codes (stable contract) ----------
export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,       // bug or unknown failure
  USAGE: 2,            // bad flags/args, validation refused, declined confirmation
  AUTH: 3,             // no/invalid token -> run `wetaca auth login`
  NETWORK: 4,          // cannot reach api.wetaca.com
  NOT_FOUND: 5,        // unknown id / no resource
  API: 6,              // Wetaca API refused the operation (see details)
  DRIFT: 7,            // API contract drift: expected field missing / shape changed
};

export class CliError extends Error {
  constructor(exitCode, message, extra = {}) {
    super(message);
    this.exitCode = exitCode;
    this.extra = extra; // { reason, retryable, suggested_commands, details }
  }
}

export function usageError(message, extra = {}) {
  return new CliError(EXIT.USAGE, message, { reason: 'usage', retryable: false, ...extra });
}

// ---------- config ----------
export function configDir() {
  if (process.env.WETACA_CONFIG_DIR) return process.env.WETACA_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg || path.join(os.homedir(), '.config'), 'wetaca-cli');
}

export function configPath() { return path.join(configDir(), 'config.json'); }
// Secretos (token/refreshToken) en fichero aparte con permisos restrictivos.
// El config.json nunca lleva secretos.
export function credentialsPath() { return path.join(configDir(), 'credentials.json'); }

const SECRET_KEYS = ['token', 'login', 'password', 'refreshToken'];

// Permisos restrictivos: 0600 en POSIX; en Windows, ACL solo para el usuario actual.
function restrictPerms(p) {
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = child_process;
      execFileSync('icacls', [p, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { stdio: 'ignore', windowsHide: true });
    } else {
      fs.chmodSync(p, 0o600);
    }
  } catch { /* best effort: si falla, el fichero queda con permisos por defecto */ }
}

export function saveCreds(creds) {
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = credentialsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, credentialsPath());
  restrictPerms(credentialsPath());
}

export function loadCreds() {
  try { return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')); } catch { return { profiles: {} }; }
}

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return { defaultProfile: 'default', profiles: {} };
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, configPath());
}

export function getProfile(name, { create = false } = {}) {
  const cfg = loadConfig();
  name = name || cfg.defaultProfile || 'default';
  // combined view: config.json (public) + credentials.json (secrets); the legacy
  // one with secrets inside config.json keeps being read until migrated
  const creds = loadCreds().profiles?.[name] || {};
  const legacy = cfg.profiles?.[name] || {};
  const p = { ...legacy, ...creds };
  if (!legacy.token && !legacy.email && !legacy.login && !legacy.password && !Object.keys(creds).length) {
    if (!create) return { name, token: null, email: null };
    cfg.profiles = { ...(cfg.profiles || {}), [name]: { token: null, email: null } };
    saveConfig(cfg);
    return { name, token: null, email: null };
  }
  return { name, ...p };
}

export function saveProfile(name, data) {
  const cfg = loadConfig();
  name = name || cfg.defaultProfile || 'default';
  const creds = loadCreds();
  let credsDirty = false;
  // secretos → credentials.json; resto → config.json
  const sec = {}, pub = {};
  for (const [k, v] of Object.entries(data)) (SECRET_KEYS.includes(k) ? sec : pub)[k] = v;
  if (Object.keys(sec).length) {
    creds.profiles = { ...(creds.profiles || {}), [name]: { ...(creds.profiles?.[name] || {}), ...sec } };
    credsDirty = true;
  }
  // migration of legacy config.json: token/refreshToken move to credentials.json;
  // login/password are DELETED (the CLI no longer stores passwords, user's decision)
  for (const [pname, p] of Object.entries(cfg.profiles || {})) {
    const legacy = SECRET_KEYS.filter((k) => p[k] != null);
    if (!legacy.length) continue;
    for (const k of legacy) {
      if (k === 'login' || k === 'password') { delete p[k]; continue; }
      creds.profiles = { ...(creds.profiles || {}) };
      creds.profiles[pname] = { ...(creds.profiles?.[pname] || {}) };
      creds.profiles[pname][k] ??= p[k];
      delete p[k];
    }
    credsDirty = true;
  }
  if (credsDirty) saveCreds(creds);
  if (Object.keys(pub).length) {
    cfg.profiles = { ...(cfg.profiles || {}), [name]: { ...(cfg.profiles?.[name] || {}), ...pub } };
  }
  if (!cfg.defaultProfile) cfg.defaultProfile = name;
  saveConfig(cfg);
}

export function getToken(profileName) {
  if (process.env.WETACA_TOKEN) return process.env.WETACA_TOKEN;
  return getProfile(profileName).token || null;
}

// ---------- GraphQL client ----------
const API_URL = process.env.WETACA_API_URL || 'https://api.wetaca.com/graphql';
const UA = `wetaca-cli/${VERSION} (+https://github.com/gorgueugr/wetaca-cli)`;

async function rawRequest(query, variables, tok, debug) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
  };
  if (tok) headers.authorization = `Bearer ${tok}`;
  let res;
  const started = Date.now();
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables: variables || {} }),
    });
  } catch (e) {
    throw new CliError(EXIT.NETWORK, `Could not connect to the Wetaca API: ${e.cause?.code || e.message}`,
      { reason: 'network', retryable: true });
  }
  if (debug) console.error(`wetaca: POST ${API_URL} -> ${res.status} (${Date.now() - started} ms)`);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const e = new CliError(EXIT.AUTH, 'The API rejected the session (401/403). The token may have expired.',
        { reason: 'auth_rejected', retryable: false, suggested_commands: ['wetaca auth login'] });
      e.auth = true;
      throw e;
    }
    throw new CliError(EXIT.API, `The API responded with HTTP ${res.status}`,
      { reason: 'http_' + res.status, retryable: res.status >= 500 || res.status === 429 });
  }
  let body;
  try { body = await res.json(); } catch {
    throw new CliError(EXIT.DRIFT, 'The API returned a non-JSON response (possible contract change).',
      { reason: 'contract_drift', retryable: false });
  }
  return body;
}

// Stored credential for auto-refresh: ONLY the refresh-token (120-day cookie).
// The password is never requested nor stored (user's decision).
function storedRefreshToken(profile) {
  if (process.env.WETACA_REFRESH_TOKEN) return process.env.WETACA_REFRESH_TOKEN;
  const cfg = loadConfig();
  const name = profile || cfg.defaultProfile || 'default';
  const c = loadCreds().profiles?.[name];
  return c?.refreshToken || null;
}

// Renews the token with the refresh-token cookie (120 days) via POST /session/refresh,
// just like the web does (bundles: auth-token + refresh-token cookies, x-wetaca-session).
// Also exported for `auth login --refresh-token`.
export async function sessionRefresh(rt, profile, debug) {
  let res;
  try {
    res = await fetch(`${API_URL}/session/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `refresh-token=${rt}`,
        'x-wetaca-session': '1',
        'User-Agent': UA,
      },
    });
  } catch (e) {
    throw new CliError(EXIT.NETWORK, `Could not connect to the Wetaca API: ${e.cause?.code || e.message}`,
      { reason: 'network', retryable: true });
  }
  if (res.status === 400 || res.status === 401) {
    throw new CliError(EXIT.AUTH, 'The refresh-token is invalid (copied incorrectly, expired, or revoked). Copy it from wetaca.com while logged in: F12 → Application → Cookies → wetaca.com → refresh-token (full value).',
      { reason: 'refresh_token_invalid', retryable: false, suggested_commands: ['wetaca auth login --token T'] });
  }
  if (!res.ok) {
    throw new CliError(EXIT.API, `The API responded with HTTP ${res.status} while refreshing the session`,
      { reason: 'http_' + res.status, retryable: res.status >= 500 });
  }
  let j;
  try { j = await res.json(); } catch {
    throw new CliError(EXIT.DRIFT, 'The API returned a non-JSON response while refreshing the session.',
      { reason: 'contract_drift', retryable: false });
  }
  if (!j?.token) {
    throw new CliError(EXIT.DRIFT, 'The refresh did not return a token (possible contract change).',
      { reason: 'contract_drift', retryable: false });
  }
  saveProfile(profile, { token: j.token });
  // rotation: if the API issues a new refresh-token in Set-Cookie, we save it
  const sc = res.headers.get('set-cookie');
  const m = sc && sc.match(/(?:^|,\s*)refresh-token=([^;\s]+)/);
  if (m && m[1] && m[1] !== rt) saveProfile(profile, { refreshToken: m[1] });
  if (debug) console.error('wetaca: token automatically renewed (refresh-token)');
  return j.token;
}

export async function gql(query, variables, { token, profile, debug, anon = false } = {}) {
  const tok0 = token ?? getToken(profile);
  if (!tok0 && !anon) {
    throw new CliError(EXIT.AUTH, 'No session. Run `wetaca auth login` (or set WETACA_TOKEN).',
      { reason: 'auth_required', retryable: false, suggested_commands: ['wetaca auth login'] });
  }
  // Auto-refresh: if the request fails due to an expired session and a refresh-token is stored,
  // renew via /session/refresh and retry ONCE (only with the stored token).
  const canRefresh = !anon && !token && !!storedRefreshToken(profile);
  const call = async (tok) => {
    const body = await rawRequest(query, variables, tok, debug);
    if (body.errors?.length) {
      const codes = body.errors.map((e) => e.extensions?.code).filter(Boolean);
      if (codes.includes('UNAUTHENTICATED')) {
        const e = new CliError(EXIT.AUTH, 'The session is not valid for this operation.',
          { reason: 'auth_required', retryable: false, suggested_commands: ['wetaca auth login'] });
        e.auth = true;
        throw e;
      }
      throw new CliError(EXIT.API, body.errors.map((e) => e.message).join('; '),
        { reason: 'graphql_error', retryable: false, details: body.errors });
    }
    // OJO: los campos top-level null son NORMALES en esta API (p. ej. nextPaymentPendingOrder
    // null = "no hay pagos pendientes"); no implican deriva de contrato. Cada comando decide.
    return body.data;
  };
  try {
    return await call(tok0);
  } catch (e) {
    if (!canRefresh || !e.auth) throw e;
    const rt = storedRefreshToken(profile);
    if (!rt) throw e;
    return call(await sessionRefresh(rt, profile, debug));
  }
}

// ---------- money / dates helpers ----------
export function cents(v) {
  if (v == null) return null;
  return (v / 100).toFixed(2).replace('.', ',') + ' €';
}

export function fmtWindow(option) {
  if (!option) return null;
  return fmtDate(option.start) + ' → ' + fmtDate(option.end);
}

export function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const p = (n) => String(n).padStart(2, '0');
  return `${wd} ${p(d.getDate())} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- output ----------
export function isJsonFormat(fmt) { return fmt === 'json' || fmt === 'jsonl'; }

export function emit(data, { format, jsonl }) {
  if (format === 'pretty') { printPretty(data); return; }
  if (jsonl) {
    const arr = Array.isArray(data) ? data : data.items;
    if (Array.isArray(arr)) { for (const x of arr) console.log(JSON.stringify(x)); return; }
  }
  console.log(JSON.stringify(data, null, 2));
}

function printPretty(data, indent = '') {
  if (Array.isArray(data)) {
    if (data.length && typeof data[0] === 'object') printTable(data); else data.forEach((x) => console.log(indent + '- ' + x));
    return;
  }
  if (typeof data !== 'object' || data === null) { console.log(indent + String(data)); return; }
  for (const [k, v] of Object.entries(data)) {
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      console.log(indent + k + ':');
      printPretty(v, indent + '  ');
    } else if (Array.isArray(v)) {
      console.log(indent + k + ':');
      printPretty(v, indent + '  ');
    } else {
      // prices in cents → euros in pretty mode
      const isCents = /price|toPay|balance/i.test(k) && typeof v === 'number' && v > 100;
      console.log(indent + `${k}: ${isCents ? cents(v) : v}`);
    }
  }
}

function printTable(rows) {
  const cols = Object.keys(rows[0]);
  const cell = (v, k) => {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map((x) => cell(x)).join(', ');
    if (typeof v === 'object') {
      if (typeof v.name === 'string') return v.name;
      return Object.entries(v).filter(([, x]) => x != null && typeof x !== 'object')
        .map(([kk, x]) => `${kk}=${x}`).join(' ');
    }
    if (typeof v === 'number' && /price|toPay/i.test(k || '') && v > 100) return cents(v);
    return String(v);
  };
  const w = {};
  for (const c of cols) w[c] = Math.min(Math.max(c.length, ...rows.map((r) => cell(r[c], c).length)), 40);
  const line = (l, m, r) => l + cols.map((c) => '─'.repeat(w[c])).join(m) + r;
  console.log(line('┌', '┬', '┐'));
  console.log('│' + cols.map((c) => c.padEnd(w[c])).join('│') + '│');
  console.log(line('├', '┼', '┤'));
  for (const r of rows) console.log('│' + cols.map((c) => cell(r[c], c).slice(0, w[c]).padEnd(w[c])).join('│') + '│');
  console.log(line('└', '┴', '┘'));
}

export function printError(err, errorFormat, debug = false) {
  if (errorFormat === 'json') {
    console.error(JSON.stringify({
      error: {
        code: err.exitCode,
        category: Object.entries(EXIT).find(([, v]) => v === err.exitCode)?.[0]?.toLowerCase() || 'unexpected',
        reason: err.extra?.reason || 'unexpected',
        retryable: !!err.extra?.retryable,
        message: err.message,
        suggested_commands: err.extra?.suggested_commands || [],
        ...(debug && err.extra?.details ? { details: err.extra.details } : {}),
      },
    }, null, 2));
  } else {
    console.error('wetaca: ' + err.message);
    if (err.extra?.suggested_commands?.length) console.error('  → ' + err.extra.suggested_commands.join(' ; '));
  }
}
