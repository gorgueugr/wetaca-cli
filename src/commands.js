// wetaca-cli command implementations.
import readline from 'node:readline/promises';
import child_process from 'node:child_process';
import {
  CliError, usageError, EXIT, gql, cents, fmtDate, emit,
  getToken, loadConfig, saveConfig, saveProfile, configPath, configDir,
} from './lib.js';
import * as Q from './queries.js';

// ---------- helpers ----------

async function confirm(flags, summary) {
  if (flags.yes) return;
  if (flags.noInput || !process.stdin.isTTY) {
    throw usageError(
      `Operación con efectos reales; se pide confirmación. Resumen: ${summary}\n` +
      'Sin terminal: repite con --yes para confirmar.',
      { reason: 'confirmation_required', suggested_commands: ['repite el comando con --yes'] });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ans = (await rl.question(`\n${summary}\n¿Confirmar? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (ans !== 'y' && ans !== 'yes' && ans !== 's' && ans !== 'si') {
    throw usageError('Cancelado por el usuario.', { reason: 'declined' });
  }
}

function requireId(v, what) {
  if (!v) throw usageError(`Falta <${what}>.`);
  return v;
}

async function nextSuggestionId(profile, debug) {
  const d = await gql(`query nextSuggestionId { nextSuggestion { id } }`, {}, { profile, debug });
  if (!d.nextSuggestion?.id) {
    throw new CliError(EXIT.NOT_FOUND, 'No hay sugerencia activa para la semana próxima.', { reason: 'no_suggestion' });
  }
  return d.nextSuggestion.id;
}

// ---------- auth: Google OAuth ----------
// Flujo de la web de Wetaca: consent de Google -> redirect a
// https://wetaca.com/google-oauth-redirection?code=...&state=<ruta> -> la SPA canjea el
// code con signUpWithGoogle(code, redirectUri). Nosotros reproducimos el canje.
export const GOOGLE_CLIENT_ID = process.env.WETACA_GOOGLE_CLIENT_ID ||
  '339479386320-c6eg1bujf7nph17kmpspsljrmgr2le38.apps.googleusercontent.com'; // client_id público de wetaca.com
const GOOGLE_REDIRECT_URI = 'https://wetaca.com/google-oauth-redirection';

export function googleAuthUrl({ state = '/' } = {}) {
  const params = new URLSearchParams({
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email',
    client_id: GOOGLE_CLIENT_ID,
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/auth?${params.toString().replace(/%20/g, '%20')}`;
}

function openBrowser(url) {
  const { spawn } = child_process;
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

export async function authLoginGoogle(args, flags, ctx) {
  const url = googleAuthUrl({ state: flags.state || '/' });
  if (ctx.dryRun || flags['no-open']) {
    // sin apertura de navegador: imprime la URL y termina
    if (ctx.dryRun) return { dryRun: true, authUrl: url, nextStep: 'abre la URL, inicia sesión con Google y copia el parámetro code de la barra de direcciones' };
    console.error('wetaca: abre esta URL, inicia sesión con Google y copia el parámetro code de la barra de direcciones (wetaca.com/?code=...):');
    console.error(url);
  } else {
    const opened = openBrowser(url);
    console.error(opened
      ? 'wetaca: se ha abierto tu navegador. Inicia sesión con Google; al volver a wetaca.com copia el parámetro code de la barra de direcciones (wetaca.com/?code=...).'
      : 'wetaca: no pude abrir el navegador. Abre esta URL, inicia sesión y copia el parámetro code:');
    if (!opened) console.error(url);
  }

  let code = flags.code;
  if (!code) {
    if (ctx.noInput || !process.stdin.isTTY) {
      throw usageError('Sin terminal hace falta --code <code> (o usa --dry-run / --no-open).');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    code = (await rl.question('Pega el code: ')).trim();
    rl.close();
  }
  // en la barra de direcciones el code va URL-encodado (4%2F0A...); aceptamos ambas formas
  code = code.trim().replace(/^["']|["']$/g, '');
  if (code.includes('%2F') || code.includes('%3D')) code = decodeURIComponent(code);
  if (!code) throw usageError('Code vacío.');

  const d = await gql(Q.SIGN_UP_WITH_GOOGLE, { code, redirectUri: GOOGLE_REDIRECT_URI, segmentSlug: null, locale: 'es' },
    { anon: true, debug: ctx.debug });
  const res = d.signUpWithGoogle;
  if (res?.requireLinkAccounts || res?.tokenId) {
    throw new CliError(EXIT.AUTH,
      `Google devolvió una cuenta que requiere vinculación (email ${res.email}). ` +
      'Entrando una vez en wetaca.com con Google y con contraseña quedará vinculado; ' +
      'entonces usa `wetaca auth login --email <email> --password <pw>`.',
      { reason: 'google_linkage_required' });
  }
  if (!res?.jwtToken) {
    throw new CliError(EXIT.AUTH, 'El canje del code no devolvió token.', { reason: 'google_exchange_failed' });
  }
  const token = res.jwtToken;
  const v = await gql(Q.TOKEN_IS_VALID, { token }, { token, debug: ctx.debug });
  if (v.tokenIsValid !== true) {
    throw new CliError(EXIT.AUTH, 'El token de Google no superó la validación.', { reason: 'invalid_token' });
  }
  saveProfile(ctx.profile, { token });
  return { ok: true, profile: ctx.profile, isNewCustomer: !!res.isNewCustomer, token: token.slice(0, 8) + '…' };
}

// ---------- auth ----------

export async function authLogin(args, flags, ctx) {
  const email = flags.email || process.env.WETACA_LOGIN;
  const password = flags.password || process.env.WETACA_PASSWORD;
  let token = flags.token;

  if (token) {
    // token supplied directly (advanced). Validate it.
    const d = await gql(Q.TOKEN_IS_VALID, { token }, { token, debug: ctx.debug });
    if (d.tokenIsValid !== true) {
      throw new CliError(EXIT.AUTH, 'El token no es válido (tokenIsValid = false).', { reason: 'invalid_token' });
    }
  } else {
    if (!email || !password) {
      if (ctx.noInput || !process.stdin.isTTY) {
        throw usageError('Sin terminal hace falta --email y --password (o --token, o WETACA_LOGIN/WETACA_PASSWORD).');
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      var login = (await rl.question('Email de Wetaca: ')).trim();
      var pass = (await rl.question('Contraseña: ')).trim();
      rl.close();
    } else { var login = email, pass = password; }

    const d = await gql(Q.SESSION_BY_PASSWORD, { login, password: pass, segmentSlug: null }, { anon: true, debug: ctx.debug });
    const s = d.sessionTokenData;
    if (!s?.jwtToken) {
      throw new CliError(EXIT.AUTH, 'La API no devolvió token para esas credenciales.', { reason: 'login_failed' });
    }
    if (s.requirePhoneNumber) {
      throw new CliError(EXIT.AUTH,
        'La cuenta exige verificación SMS. Haz login una vez en wetaca.com y luego usa `wetaca auth login --token` con el token de sesión.',
        { reason: 'sms_required' });
    }
    token = s.jwtToken;
    // sanity check
    const v = await gql(Q.TOKEN_IS_VALID, { token }, { token, debug: ctx.debug });
    if (v.tokenIsValid !== true) {
      throw new CliError(EXIT.AUTH, 'El token devuelto no superó la validación.', { reason: 'invalid_token' });
    }
  }

  saveProfile(ctx.profile, { token, email: email || null });
  return { ok: true, profile: ctx.profile, token: token.slice(0, 8) + '…' };
}

export async function authStatus(args, flags, ctx) {
  const token = getToken(ctx.profile);
  if (!token) return { authenticated: false, profile: ctx.profile };
  let valid = null, customer = null, err = null;
  try {
    const d = await gql(Q.TOKEN_IS_VALID, { token }, { profile: ctx.profile, debug: ctx.debug });
    valid = d.tokenIsValid;
    if (valid) {
      const c = await gql(Q.CUSTOMER, {}, { profile: ctx.profile, debug: ctx.debug });
      customer = c.customer;
    }
  } catch (e) { err = e.message; }
  return { authenticated: valid === true, tokenValid: valid, profile: ctx.profile, customer, error: err };
}

export async function authLogout(args, flags, ctx) {
  const token = getToken(ctx.profile);
  if (token) { try { await gql(Q.LOGOUT, {}, { profile: ctx.profile, debug: ctx.debug }); } catch { /* best effort */ } }
  const cfg = loadConfig();
  if (cfg.profiles?.[ctx.profile]) { cfg.profiles[ctx.profile].token = null; saveConfig(cfg); }
  return { ok: true, profile: ctx.profile };
}

// ---------- me ----------

export async function meShow(args, flags, ctx) {
  const c = await gql(Q.CUSTOMER, {}, { profile: ctx.profile, debug: ctx.debug });
  const s = await gql(Q.SUBSCRIBER_STATUS, {}, { profile: ctx.profile, debug: ctx.debug });
  const w = await gql(Q.WALLET, {}, { profile: ctx.profile, debug: ctx.debug });
  const acc = s.subscriptionAccountByCustomer;
  return {
    customer: c.customer,
    subscription: acc ? { id: acc.id, isActive: acc.isActive, cancelled: acc.cancelled, pausedUntil: acc.pausedUntil } : null,
    walletBalance: w.walletBalance,
    walletBalanceEur: w.walletBalance != null ? cents(w.walletBalance) : null,
  };
}

// ---------- subscription ----------

export async function subShow(args, flags, ctx) {
  const d = await gql(Q.SUBSCRIPTION_FULL, {}, { profile: ctx.profile, debug: ctx.debug });
  const acc = d.subscriptionAccountByCustomer;
  return {
    id: acc.id,
    isActive: acc.isActive,
    cancelled: acc.cancelled,
    pausedUntil: acc.pausedUntil,
    dateCreated: acc.dateCreated,
    delivery: acc.delivery,
    pricing: acc.subscriptionAccountPricing,
    pricingEur: {
      toPay: cents(acc.subscriptionAccountPricing?.toPay),
      shipping: cents(acc.subscriptionAccountPricing?.shipping),
    },
    recurring: acc.recurringSubscriptionType,
    profiles: acc.profiles?.map((p) => ({ id: p.id, name: p.name, email: p.email, price: p.price, priceEur: cents(p.price), isActive: p.isActive })),
    nextSuggestion: d.nextSuggestion,
  };
}

export async function subPause(args, flags, ctx) {
  const weeks = flags.weeks ? parseInt(flags.weeks, 10) : null;
  if (flags.weeks && (!Number.isInteger(weeks) || weeks < 1)) {
    throw usageError('--weeks debe ser un entero ≥ 1.');
  }
  const d0 = await gql(Q.SUBSCRIBER_STATUS, {}, { profile: ctx.profile, debug: ctx.debug });
  const acc = d0.subscriptionAccountByCustomer;
  if (!acc?.isActive) throw new CliError(EXIT.API, 'La suscripción no está activa; nada que pausar.', { reason: 'not_active' });
  const summary = `Pausar la suscripción ${acc.id}${weeks ? ` durante ${weeks} semana(s)` : ' (pausa indefinida)'}.`;
  await confirm(flags, summary);
  const d = await gql(Q.CANCEL_SUBSCRIPTION, {
    subscriptionAccountId: acc.id, path: '/pausar', pausedWeeks: weeks, feedback: flags.feedback || null,
  }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, paused: d.subscriptionAccount };
}

export async function subResume(args, flags, ctx) {
  const d0 = await gql(Q.SUBSCRIBER_STATUS, {}, { profile: ctx.profile, debug: ctx.debug });
  const acc = d0.subscriptionAccountByCustomer;
  if (!acc) throw new CliError(EXIT.NOT_FOUND, 'No hay cuenta de suscripción en este perfil.', { reason: 'no_account' });
  if (acc.isActive) return { ok: true, alreadyActive: true, subscriptionAccount: acc };
  await confirm(flags, `Reactivar la suscripción ${acc.id}.`);
  const d = await gql(Q.ACTIVATE_SUBSCRIPTION, { subscriptionAccountId: acc.id }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, subscriptionAccount: d.subscriptionAccount };
}

// ---------- suggestion (menu semanal) ----------

export async function sugShow(args, flags, ctx) {
  const d = await gql(Q.NEXT_SUGGESTION, {}, { profile: ctx.profile, debug: ctx.debug });
  const s = d.nextSuggestion;
  if (!s) throw new CliError(EXIT.NOT_FOUND, 'No hay sugerencia activa para la semana próxima.', { reason: 'no_suggestion' });
  return {
    id: s.id,
    skip: s.skip,
    pausedAt: s.pausedAt,
    validUntil: s.validUntil,
    isBeingCharged: s.isBeingCharged,
    deliveryWindow: s.delivery?.option ? { start: s.delivery.option.start, end: s.delivery.option.end } : null,
    address: s.delivery?.address,
    week: s.menuMetadata,
    pricing: s.suggestionPricing,
    pricingEur: {
      toPay: cents(s.suggestionPricing?.toPay),
      shipping: cents(s.suggestionPricing?.shipping),
      profiles: cents(s.suggestionPricing?.profilesTotal?.toPay),
    },
    profiles: s.profileSuggestions?.map((ps) => ({
      profileSuggestionId: ps.id,
      profileId: ps.profileId,
      skip: ps.skip,
      hasChanges: ps.hasChanges,
      products: ps.products,
      productMap: ps.productMap,
    })),
  };
}

export async function sugPause(args, flags, ctx) {
  const sid = flags.suggestion || await nextSuggestionId(ctx.profile, ctx.debug);
  await confirm(flags, `Saltar (pausar) la entrega de la semana próxima (suggestion ${sid}).`);
  const d = await gql(Q.PAUSE_SUGGESTION, { suggestionId: sid, path: '/menu', feedback: flags.feedback || null }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, paused: d.paused };
}

export async function sugResume(args, flags, ctx) {
  const sid = flags.suggestion || await nextSuggestionId(ctx.profile, ctx.debug);
  await confirm(flags, `Reactivar la entrega de la semana próxima (suggestion ${sid}).`);
  const d = await gql(Q.RESUME_SUGGESTION, { suggestionId: sid }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, resumed: d.resumed };
}

// `suggestion edit --profile-suggestion ID --set "productId:qty,productId:qty"`
export async function sugEdit(args, flags, ctx) {
  const psid = requireId(flags['profile-suggestion'] || flags.profileSuggestion, '--profile-suggestion');
  if (!flags.set) throw usageError('Falta --set "productId:qty,...". Ejemplo: --set "abc123:2,def456:1".');
  const productsInput = flags.set.split(',').map((pair) => {
    const [id, qty] = pair.split(':').map((x) => x.trim());
    if (!id || !qty) throw usageError(`Par inválido en --set: '${pair}' (formato id:cantidad).`);
    const n = parseInt(qty, 10);
    if (!Number.isInteger(n) || n < 0) throw usageError(`Cantidad inválida en '${pair}'.`);
    return { id, quantity: n };
  });
  const payload = { profileSuggestionId: psid, productsInput, resumeAccountSuggestion: flags.resume === undefined ? undefined : flags.resume === 'true' || flags.resume === true };
  if (ctx.dryRun) return { dryRun: true, wouldSend: { query: 'editProfileSuggestionMenu', variables: payload } };
  await confirm(flags, `Cambiar el menú del perfil-sugerencia ${psid} a: ${flags.set}.`);
  const d = await gql(Q.EDIT_PROFILE_SUGGESTION_MENU, payload, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, result: d.editProfileSuggestionProducts };
}

// ---------- deliveries / orders ----------

export async function deliveriesNext(args, flags, ctx) {
  const d = await gql(Q.PENDING_DELIVERY, {}, { profile: ctx.profile, debug: ctx.debug });
  return d;
}

export async function ordersList(args, flags, ctx) {
  const limit = parseInt(flags.limit || '10', 10);
  const offset = parseInt(flags.offset || '0', 10);
  const d = await gql(Q.PREVIOUS_DELIVERIES, { limit, offset }, { profile: ctx.profile, debug: ctx.debug });
  const rows = d.previousDeliveries.map((o) => ({ ...o, priceEur: cents(o.price) }));
  return ctx.format === 'json' || ctx.format === 'jsonl' ? rows : { items: rows, limit, offset, count: rows.length };
}

export async function ordersShow(args, flags, ctx) {
  const id = parseInt(requireId(args[0], '<order-id>'), 10);
  if (!Number.isInteger(id)) throw usageError('El id de pedido debe ser numérico.');
  const d = await gql(Q.ORDER_DETAILS, { id }, { profile: ctx.profile, debug: ctx.debug });
  return { ...d.order, priceEur: cents(d.order.price) };
}

export async function ordersCancel(args, flags, ctx) {
  const id = parseInt(requireId(args[0], '<order-id>'), 10);
  if (!Number.isInteger(id)) throw usageError('El id de pedido debe ser numérico.');
  if (ctx.dryRun) return { dryRun: true, wouldSend: { query: 'cancelConfirmedOrder', variables: { orderId: id } } };
  await confirm(flags, `Cancelar el pedido ${id} (cobra efecto en Wetaca).`);
  const d = await gql(Q.CANCEL_ORDER, { orderId: id }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, cancelled: d.cancelConfirmedOrder, refundEur: cents(d.cancelConfirmedOrder?.amount) };
}

// ---------- addresses / vouchers ----------

export async function addrList(args, flags, ctx) {
  const d = await gql(Q.ADDRESSES, {}, { profile: ctx.profile, debug: ctx.debug });
  return d.addresses;
}

export async function vouchersList(args, flags, ctx) {
  const d = await gql(Q.VOUCHERS, {}, { profile: ctx.profile, debug: ctx.debug });
  return d.vouchers.map((v) => ({
    ...v,
    discountEur: v.discount?.price != null ? cents(v.discount.price) : null,
    subscriptionDiscountEur: v.subscriptionDiscount?.price != null ? cents(v.subscriptionDiscount.price) : null,
  }));
}

export async function walletShow(args, flags, ctx) {
  const d = await gql(Q.WALLET, {}, { profile: ctx.profile, debug: ctx.debug });
  return { balance: d.walletBalance, balanceEur: cents(d.walletBalance) };
}

// ---------- config ----------

export async function configCmd(verb, args, flags, ctx) {
  if (verb === 'path') return { path: configPath() };
  const cfg = loadConfig();
  if (verb === 'list') return { defaultProfile: cfg.defaultProfile, config: { ...cfg.profiles, _meta: { redacted: true } }, note: 'los tokens no se muestran' };
  if (verb === 'get') {
    const key = args[0];
    if (!key) throw usageError('Falta la clave: config get <ruta.punto>');
    const val = key.split('.').reduce((acc, k) => acc?.[k], cfg);
    return { key, value: val === undefined ? null : (String(key).endsWith('token') ? '***' : val) };
  }
  if (verb === 'set') {
    const [key, ...rest] = args;
    if (!key || rest.length === 0) throw usageError('Uso: config set <clave> <valor>');
    if (key.endsWith('token')) throw usageError('El token se gestiona con `wetaca auth login --token`.');
    const value = rest.join(' ') === 'true' ? true : rest.join(' ') === 'false' ? false : rest.join(' ');
    const parts = key.split('.');
    let obj = cfg;
    for (let i = 0; i < parts.length - 1; i++) obj = (obj[parts[i]] ??= {});
    obj[parts[parts.length - 1]] = value;
    saveConfig(cfg);
    return { ok: true, key, value };
  }
  throw usageError(`Verbos de config: path | list | get | set`);
}

// ---------- doctor ----------

export async function doctor(args, flags, ctx) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ check: name, ok, detail });

  const nodeOk = parseInt(process.versions.node.split('.')[0], 10) >= 18;
  push('node >= 18', nodeOk, process.versions.node);

  let apiOk = false, apiDetail;
  try {
    const res = await fetch(process.env.WETACA_API_URL || 'https://api.wetaca.com/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query { __typename }' }),
    });
    const j = await res.json();
    apiOk = res.ok && !!j.data?.__typename;
    apiDetail = `HTTP ${res.status}`;
  } catch (e) { apiDetail = `sin conexión: ${e.cause?.code || e.message}`; }
  push('api.wetaca.com alcanzable', apiOk, apiDetail);

  const token = getToken(ctx.profile);
  push('sesión presente', !!token, token ? 'token configurado' : 'sin token — wetaca auth login');
  if (token) {
    try {
      const d = await gql(Q.TOKEN_IS_VALID, { token }, { profile: ctx.profile, debug: ctx.debug });
      push('token válido', d.tokenIsValid === true, `tokenIsValid=${d.tokenIsValid}`);
    } catch (e) {
      push('token válido', false, e.message);
    }
  }
  push('directorio de config', true, configDir());
  return { ok: checks.every((c) => c.ok), checks };
}
