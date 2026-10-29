// wetaca-cli command implementations.
import readline from 'node:readline/promises';
import child_process from 'node:child_process';
import fs from 'node:fs';
import {
  CliError, usageError, EXIT, gql, cents, fmtDate, fmtWindow, emit,
  getToken, loadConfig, saveConfig, saveProfile, configPath, configDir,
  loadCreds, saveCreds, credentialsPath, sessionRefresh,
} from './lib.js';
import * as Q from './queries.js';

// ---------- helpers ----------

// Extrae la cookie refresh-token de wetaca.com de un export del navegador.
// Formatos aceptados: Netscape cookies.txt, JSON de
// Cookie-Editor/EditThisCookie (array o {url, cookies}), lista de cookies DevTools,
// cabecera "Cookie: ..." o el valor pelado.
export function extractRefreshToken(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // JSON: array de cookies o {url, cookies}
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      const list = Array.isArray(j) ? j : (Array.isArray(j.cookies) ? j.cookies : null);
      if (list) {
        const c = list.find((x) => x && /(^|\.)wetaca\.com$/i.test(String(x.domain || ''))
          && x.name === 'refresh-token');
        return c?.value ? String(c.value) : null;
      }
    } catch { /* no era JSON, seguimos */ }
  }
  // Netscape cookies.txt: domain \t flag \t path \t secure \t expiry \t name \t value
  // (httpOnly cookies carry the "#HttpOnly_" prefix on the line)
  const lines = t.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw) continue;
    const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw;
    if (line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length >= 7 && /(^|\.)wetaca\.com$/i.test(parts[0]) && parts[5] === 'refresh-token') {
      return parts[6] || null;
    }
  }
  // Cabecera "Cookie: name=value; name=value" o pares sueltos
  const m = t.match(/(?:^|[\s;])refresh-token=([^;\s"']+)/);
  if (m) return m[1];
  // Bare value (a single line with no tabs and no ';'); an "=" can be base64 padding
  if (lines.length === 1 && !t.includes('\t') && !t.includes(';')) {
    const eq = t.indexOf('=');
    if (eq === -1) return t;
    const name = t.slice(0, eq);
    // si lo que hay antes del "=" es el nombre de una cookie conocida, no es un valor pelado
    const KNOWN = ['refresh-token', 'auth-token', 'customer-token', 'token-voucher-pending'];
    return KNOWN.includes(name) ? null : t;
  }
  return null;
}

async function confirm(flags, summary) {
  if (flags.yes) return;
  if (flags.noInput || !process.stdin.isTTY) {
    throw usageError(
      `Real-effect operation; confirmation required. Summary: ${summary}\n` +
      'No terminal: repeat with --yes to confirm.',
      { reason: 'confirmation_required', suggested_commands: ['repeat the command with --yes'] });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ans = (await rl.question(`\n${summary}\nConfirm? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (ans !== 'y' && ans !== 'yes' && ans !== 's' && ans !== 'si') {
    throw usageError('Cancelled by the user.', { reason: 'declined' });
  }
}

function requireId(v, what) {
  if (!v) throw usageError(`Missing <${what}>.`);
  return v;
}

async function nextSuggestionId(profile, debug) {
  const d = await gql(`query nextSuggestionId { nextSuggestion { id } }`, {}, { profile, debug });
  if (!d.nextSuggestion?.id) {
    throw new CliError(EXIT.NOT_FOUND, 'No active suggestion for next week.', { reason: 'no_suggestion' });
  }
  return d.nextSuggestion.id;
}

// ---------- auth ----------

// Pregunta por terminal; hidden=true lee en modo raw (sin eco, como sudo)
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (!hidden) {
      // API de promesas (readline/promises): question() devuelve Promise, no acepta callback
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      rl.question(question).then((a) => { rl.close(); resolve(a.trim()); });
      return;
    }
    const stdin = process.stdin;
    process.stderr.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume(); // mantiene vivo el loop tras cerrar el readline del email
    let buf = '';
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(buf.trim());
          return;
        } else if (ch === '\u0003') { // Ctrl+C
          stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          process.exit(130);
        } else if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
        } else if (ch >= ' ') {
          buf += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

export async function authLogin(args, flags, ctx) {
  let token = flags.token;
  let viaRefresh = false;

  if (flags.clipboard) {
    // read the token from the clipboard (e.g. extracted from the wetaca.com DevTools console)
    const { execSync } = child_process;
    try {
      const out = process.platform === 'win32'
        ? execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8' })
        : process.platform === 'darwin' ? execSync('pbpaste', { encoding: 'utf8' })
        : execSync('xclip -selection clipboard -o', { encoding: 'utf8' });
      const m = String(out).match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      token = m ? m[0] : String(out).trim();
    } catch (e) {
      throw usageError('Could not read the clipboard: ' + e.message);
    }
    if (!token) throw usageError('The clipboard is empty.');
  }

  let customer = null;
  // --cookies FILE / --cookies-stdin: importar desde un export del navegador.
  // Netscape cookies.txt, JSON Cookie-Editor/EditThisCookie, header
  // Cookie: o valor pelado. Solo se leen cookies de wetaca.com.
  let cookieFileInput = null;
  if (flags.cookies || flags['cookies-stdin']) {
    try {
      if (flags['cookies-stdin']) {
        cookieFileInput = fs.readFileSync(0, 'utf8');
      } else {
        cookieFileInput = fs.readFileSync(String(flags.cookies).trim(), 'utf8');
      }
    } catch (e) {
      throw usageError('Could not read the cookies file: ' + e.message);
    }
  }
  if (cookieFileInput != null || flags['refresh-token'] || process.env.WETACA_REFRESH_TOKEN) {
    // Import the refresh-token from the web (120-day cookie)
    // and let /session/refresh mint the session tokens. No password is ever requested.
    let rt;
    if (cookieFileInput != null) {
      rt = extractRefreshToken(cookieFileInput);
    } else {
      rt = String(flags['refresh-token'] || process.env.WETACA_REFRESH_TOKEN).trim();
    }
    if (!rt) {
      throw new CliError(EXIT.AUTH,
        'The cookie export contains no "refresh-token" cookie from wetaca.com. ' +
        'Make sure to export the cookies while logged in to wetaca.com (the cookie is created on login).',
        { reason: 'refresh_token_missing', suggested_commands: ['wetaca auth login --refresh-token VALOR'] });
    }
    saveProfile(ctx.profile, { refreshToken: rt });
    try {
      token = await sessionRefresh(rt, ctx.profile, ctx.debug);
      viaRefresh = true;
    } catch (e) {
      throw new CliError(e.exitCode || EXIT.AUTH,
        'Could not refresh the session with that refresh-token. ' + e.message,
        { reason: 'invalid_refresh_token', suggested_commands: ['wetaca auth login --token T'] });
    }
    const c = await gql(Q.CUSTOMER, {}, { token, debug: ctx.debug });
    customer = c.customer;
  } else if (token) {
    // token supplied directly (advanced). Limpiar y validar llamando a la API de verdad
    // (the test that matters is that `customer` responds; tokenIsValid is diagnostics only).
    token = token.trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '');
    if (!token) throw usageError('The token was empty.');
    try {
      const d = await gql(Q.CUSTOMER, {}, { token, debug: ctx.debug });
      customer = d.customer;
    } catch (e) {
      let isValid = null;
      try {
        const v = await gql(Q.TOKEN_IS_VALID, { token }, { token, debug: ctx.debug });
        isValid = v.tokenIsValid;
      } catch { /* seguimos con el error original */ }
      throw new CliError(EXIT.AUTH,
        `The API rejected the token${isValid === false ? ' (tokenIsValid=false)' : ''}. ` +
        'Check that you copied ONLY what comes after "Bearer " in the authorization header ' +
        '(without the word Bearer, without quotes). Original error: ' + e.message,
        { reason: 'invalid_token' });
    }
  } else {
    // Without --refresh-token or --token: prompt for it on the terminal (hidden). Accepts the
    // refresh-token cookie (preferred, lasts 120 days) or a direct session JWT.
    if (ctx.noInput || !process.stdin.isTTY) {
      throw usageError('Without a terminal you need --refresh-token VALUE (a wetaca.com cookie, F12 → Application → Cookies), or --token VALUE / --token --clipboard.');
    }
    const pasted = await ask('Paste the refresh-token (or the session token) and press Enter: ', { hidden: true });
    const v = (pasted || '').trim().replace(/^["']|["']$/g, '');
    if (!v) throw usageError('No token was pasted.');
    if (v.startsWith('eyJ')) {
      token = v; // direct session JWT
    } else {
      saveProfile(ctx.profile, { refreshToken: v });
      try {
        token = await sessionRefresh(v, ctx.profile, ctx.debug);
        viaRefresh = true;
      } catch (e) {
        throw new CliError(e.exitCode || EXIT.AUTH,
          'Could not refresh the session with that refresh-token. ' + e.message,
          { reason: 'invalid_refresh_token', suggested_commands: ['wetaca auth login --token T'] });
      }
    }
    try {
      const c = await gql(Q.CUSTOMER, {}, { token, debug: ctx.debug });
      customer = c.customer;
    } catch (e) {
      throw new CliError(EXIT.AUTH, 'The API rejected the token. Original error: ' + e.message,
        { reason: 'invalid_token' });
    }
  }

  // The session token and (if imported) the refresh-token are saved. NEVER the password.
  saveProfile(ctx.profile, {
    token,
    email: customer?.email || null,
  });
  return {
    ok: true, profile: ctx.profile, email: customer?.email || null,
    via: viaRefresh ? 'refresh-token (auto-renewable ~120 days)' : 'session token (expires; renew it with --refresh-token)',
    token: token.slice(0, 8) + '…',
  };
}

export async function authStatus(args, flags, ctx) {
  const token = getToken(ctx.profile);
  if (!token) return { authenticated: false, profile: ctx.profile };
  let authenticated = false, customer = null, err = null, tokenValid = null;
  try {
    const c = await gql(Q.CUSTOMER, {}, { profile: ctx.profile, debug: ctx.debug });
    customer = c.customer;
    authenticated = true;
  } catch (e) {
    err = e.message;
    try {
      const v = await gql(Q.TOKEN_IS_VALID, { token }, { profile: ctx.profile, debug: ctx.debug });
      tokenValid = v.tokenIsValid;
    } catch { /* el error de customer manda */ }
  }
  return { authenticated, profile: ctx.profile, customer, tokenValid, error: err };
}

export async function authLogout(args, flags, ctx) {
  const token = getToken(ctx.profile);
  if (token) { try { await gql(Q.LOGOUT, {}, { profile: ctx.profile, debug: ctx.debug }); } catch { /* best effort */ } }
  const cfg = loadConfig();
  if (cfg.profiles?.[ctx.profile]) { cfg.profiles[ctx.profile].token = null; saveConfig(cfg); }
  const creds = loadCreds();
  if (creds.profiles?.[ctx.profile]) { creds.profiles[ctx.profile].token = null; saveCreds(creds); }
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
    throw usageError('--weeks must be an integer ≥ 1.');
  }
  const d0 = await gql(Q.SUBSCRIBER_STATUS, {}, { profile: ctx.profile, debug: ctx.debug });
  const acc = d0.subscriptionAccountByCustomer;
  if (!acc?.isActive) throw new CliError(EXIT.API, 'The subscription is not active; nothing to pause.', { reason: 'not_active' });
  const summary = `Pause subscription ${acc.id}${weeks ? ` for ${weeks} week(s)` : ' (indefinite pause)'}.`;
  await confirm(flags, summary);
  const d = await gql(Q.CANCEL_SUBSCRIPTION, {
    subscriptionAccountId: acc.id, path: '/pausar', pausedWeeks: weeks, feedback: flags.feedback || null,
  }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, paused: d.subscriptionAccount };
}

export async function subResume(args, flags, ctx) {
  const d0 = await gql(Q.SUBSCRIBER_STATUS, {}, { profile: ctx.profile, debug: ctx.debug });
  const acc = d0.subscriptionAccountByCustomer;
  if (!acc) throw new CliError(EXIT.NOT_FOUND, 'No subscription account in this profile.', { reason: 'no_account' });
  if (acc.isActive) return { ok: true, alreadyActive: true, subscriptionAccount: acc };
  await confirm(flags, `Resume subscription ${acc.id}.`);
  const d = await gql(Q.ACTIVATE_SUBSCRIPTION, { subscriptionAccountId: acc.id }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, subscriptionAccount: d.subscriptionAccount };
}

// ---------- suggestion (menu semanal) ----------

export async function sugShow(args, flags, ctx) {
  const d = await gql(Q.NEXT_SUGGESTION, {}, { profile: ctx.profile, debug: ctx.debug });
  const s = d.nextSuggestion;
  if (!s) throw new CliError(EXIT.NOT_FOUND, 'No active suggestion for next week.', { reason: 'no_suggestion' });
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
  await confirm(flags, `Skip (pause) next week's delivery (suggestion ${sid}).`);
  const d = await gql(Q.PAUSE_SUGGESTION, { suggestionId: sid, path: '/menu', feedback: flags.feedback || null }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, paused: d.paused };
}

export async function sugResume(args, flags, ctx) {
  const sid = flags.suggestion || await nextSuggestionId(ctx.profile, ctx.debug);
  await confirm(flags, `Resume next week's delivery (suggestion ${sid}).`);
  const d = await gql(Q.RESUME_SUGGESTION, { suggestionId: sid }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, resumed: d.resumed };
}

// `suggestion edit --profile-suggestion ID --set "productId:qty,productId:qty"`
export async function sugEdit(args, flags, ctx) {
  const psid = requireId(flags['profile-suggestion'] || flags.profileSuggestion, '--profile-suggestion');
  if (!flags.set) throw usageError('Missing --set "productId:qty,...". Example: --set "abc123:2,def456:1".');
  const productsInput = flags.set.split(',').map((pair) => {
    const [id, qty] = pair.split(':').map((x) => x.trim());
    if (!id || !qty) throw usageError(`Invalid pair in --set: '${pair}' (id:qty format).`);
    const n = parseInt(qty, 10);
    if (!Number.isInteger(n) || n < 0) throw usageError(`Invalid quantity in '${pair}'.`);
    const pid = parseInt(id, 10); // the API declares productsInput[].id as Int (ModelId)
    if (!Number.isInteger(pid) || pid <= 0) throw usageError(`Invalid product id in '${pair}' (must be numeric, from \`wetaca suggestion show\`).`);
    return { id: pid, quantity: n };
  });
  const payload = { profileSuggestionId: psid, productsInput, resumeAccountSuggestion: flags.resume === undefined ? undefined : flags.resume === 'true' || flags.resume === true };
  if (ctx.dryRun) return { dryRun: true, wouldSend: { query: 'editProfileSuggestionMenu', variables: payload } };
  await confirm(flags, `Change the menu of profile-suggestion ${psid} to: ${flags.set}.`);
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
  if (!Number.isInteger(id)) throw usageError('The order id must be numeric.');
  const d = await gql(Q.ORDER_DETAILS, { id }, { profile: ctx.profile, debug: ctx.debug });
  return { ...d.order, priceEur: cents(d.order.price) };
}

export async function ordersCancel(args, flags, ctx) {
  const id = parseInt(requireId(args[0], '<order-id>'), 10);
  if (!Number.isInteger(id)) throw usageError('The order id must be numeric.');
  if (ctx.dryRun) return { dryRun: true, wouldSend: { query: 'cancelConfirmedOrder', variables: { orderId: id } } };
  await confirm(flags, `Cancel order ${id} (takes effect on Wetaca).`);
  const d = await gql(Q.CANCEL_ORDER, { orderId: id }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, cancelled: d.cancelConfirmedOrder, refundEur: cents(d.cancelConfirmedOrder?.amount) };
}

// ---------- addresses / vouchers ----------

export async function addrList(args, flags, ctx) {
  const d = await gql(Q.ADDRESSES, {}, { profile: ctx.profile, debug: ctx.debug });
  return d.addresses;
}

// Changes the delivery address: creates the new address (saveAddress) and assigns it
// to the subscription (editDeliveryAccountInfo) and to next week's suggestion
// (editSuggestionDelivery), keeping the current delivery option. Flow identical to the web's.
export async function addrSave(args, flags, ctx) {
  const f = (k) => (flags[k] != null ? String(flags[k]).trim() : undefined);
  const street = f('street'), number = f('number'), zipcode = f('zipcode'), city = f('city');
  if (!street || !number || !zipcode || !city) {
    throw usageError('Missing fields: --street, --number, --zipcode and --city are required ' +
      '(optional: --floor, --notes, --firstname, --lastname, --phone; by default they are inherited from your current address).');
  }
  const cur = await gql(Q.DELIVERY_CONFIG, {}, { profile: ctx.profile, debug: ctx.debug });
  const sub = cur.subscriptionAccountByCustomer;
  const curAddr = sub?.delivery?.address || {};
  const deliveryOptionId = sub?.delivery?.option?.id;
  const suggestion = cur.nextSuggestion;
  if (!deliveryOptionId) throw new CliError(EXIT.DRIFT, 'Could not read the current delivery option of your subscription.', { reason: 'no_delivery_option' });

  const address = {
    firstname: f('firstname') ?? curAddr.firstname,
    lastname: f('lastname') ?? curAddr.lastname,
    street,
    number,
    floor: f('floor') ?? curAddr.floor ?? null,
    zipcode: parseInt(zipcode, 10),
    city,
    phone: f('phone') ?? curAddr.phone,
    notes: f('notes') ?? curAddr.notes ?? null,
  };
  if (address.zipcode == null || Number.isNaN(address.zipcode)) throw usageError('--zipcode must be numeric.');
  // NOTE: deliveryConfiguration does NOT carry "type" — the API returns 500 if you send it
  // (tested live; the valid shape is {optionConfiguration: {addressId, deliveryOptionId}}).
  const deliveryConfiguration = { optionConfiguration: { addressId: null, deliveryOptionId } };
  const plan = {
    saveAddress: address,
    subscription: sub ? { mutation: 'editDeliveryAccountInfo', deliveryConfiguration } : null,
    suggestion: suggestion ? { mutation: 'editSuggestionDelivery', suggestionId: suggestion.id, deliveryConfiguration } : null,
  };
  if (ctx.dryRun) return { dryRun: true, wouldSend: plan };
  await confirm(flags, `Change your delivery address to ${street} ${number}${address.floor ? ', ' + address.floor : ''} (${address.zipcode} ${city}).`);
  const saved = await gql(Q.SAVE_ADDRESS, { address }, { profile: ctx.profile, debug: ctx.debug });
  const addressId = saved.saveAddress.id;
  const deliveryConfiguration2 = { optionConfiguration: { addressId, deliveryOptionId } };
  const subRes = sub ? await gql(Q.EDIT_SUBSCRIPTION_DELIVERY,
    { subscriptionDeliveryInput: { deliveryConfiguration: deliveryConfiguration2 } },
    { profile: ctx.profile, debug: ctx.debug }) : null;
  const sugRes = suggestion ? await gql(Q.EDIT_SUGGESTION_DELIVERY,
    { suggestionId: suggestion.id, suggestionDeliveryInput: { deliveryConfiguration: deliveryConfiguration2 } },
    { profile: ctx.profile, debug: ctx.debug }) : null;
  return {
    ok: true,
    address: saved.saveAddress,
    phoneCarriedFromPrevious: !flags.phone && !!curAddr.phone,
    subscriptionUpdated: subRes?.editDeliveryAccountInfo?.id === sub.id,
    suggestionUpdated: sugRes?.editSuggestionDelivery?.id === suggestion.id,
  };
}

// ---------- catalog ----------

// Weekly menu available for your zipcode (ids are the ones used by suggestion edit --set)
export async function menuList(args, flags, ctx) {
  const zipcode = flags.zipcode != null ? parseInt(flags.zipcode, 10) : undefined;
  const d = await gql(Q.SEGMENT_MENU, { zipcode, isSubscriptionIntent: true }, { profile: ctx.profile, debug: ctx.debug });
  const m = d.segmentMenu;
  if (!m) throw new CliError(EXIT.NOT_FOUND, 'No menu available for that postal code.', { reason: 'no_menu' });
  return { week: m.week, year: m.year, dateFrom: m.dateFrom, dateTo: m.dateTo, dishes: m.dishes };
}

export async function dishShow(args, flags, ctx) {
  const slug = args[0];
  if (!slug) throw usageError('Usage: wetaca dish show <slug>  (slugs come from `wetaca menu list`)');
  const d = await gql(Q.DISH, { slug }, { profile: ctx.profile, debug: ctx.debug });
  if (!d.dish) throw new CliError(EXIT.NOT_FOUND, `Dish '${slug}' does not exist.`, { reason: 'not_found' });
  return d.dish;
}

// ---------- franja de entrega ----------

export async function delivOptions(args, flags, ctx) {
  const cur = await gql(Q.DELIVERY_CONFIG, {}, { profile: ctx.profile, debug: ctx.debug });
  const zipcode = flags.zipcode != null ? parseInt(flags.zipcode, 10) : cur.subscriptionAccountByCustomer?.delivery?.address?.zipcode;
  if (!zipcode) throw usageError('Could not read your postal code; pass it with --zipcode.');
  const d = await gql(Q.DELIVERY_OPTIONS, { zipcode }, { profile: ctx.profile, debug: ctx.debug });
  const currentId = cur.subscriptionAccountByCustomer?.delivery?.option?.id;
  return d.deliveryOptions.map((o) => ({ ...o, isCurrent: o.id === currentId, priceEur: cents(o.price) }));
}

// Changes the delivery slot (option) for the subscription and next week.
export async function delivSetOption(args, flags, ctx) {
  const optionId = parseInt(requireId(args[0], '<option-id>'), 10);
  if (!Number.isInteger(optionId)) throw usageError('The delivery window id must be numeric (they come from `wetaca deliveries options`).');
  const cur = await gql(Q.DELIVERY_CONFIG, {}, { profile: ctx.profile, debug: ctx.debug });
  const sub = cur.subscriptionAccountByCustomer;
  const suggestion = cur.nextSuggestion;
  const curOption = sub?.delivery?.option;
  if (!curOption) throw new CliError(EXIT.DRIFT, 'Could not read the current delivery window.', { reason: 'no_delivery_option' });
  const opts = await gql(Q.DELIVERY_OPTIONS, { zipcode: sub?.delivery?.address?.zipcode }, { profile: ctx.profile, debug: ctx.debug });
  const opt = (opts.deliveryOptions || []).find((o) => o.id === optionId);
  if (!opt) throw new CliError(EXIT.NOT_FOUND,
    `Delivery window ${optionId} is not available for your postal code. Available: ${(opts.deliveryOptions || []).map((o) => o.id).join(', ')}`,
    { reason: 'option_not_available' });
  const deliveryConfiguration = { optionConfiguration: { deliveryOptionId: optionId, addressId: sub?.delivery?.address?.id } };
  const plan = {
    option: opt,
    subscription: { mutation: 'editDeliveryAccountInfo', deliveryConfiguration },
    suggestion: suggestion ? { mutation: 'editSuggestionDelivery', suggestionId: suggestion.id, deliveryConfiguration } : null,
  };
  if (ctx.dryRun) return { dryRun: true, wouldSend: plan };
  await confirm(flags, `Change your delivery window to ${fmtWindow(opt)} (was ${fmtWindow(curOption)}).`);
  const subRes = await gql(Q.EDIT_SUBSCRIPTION_DELIVERY,
    { subscriptionDeliveryInput: { deliveryConfiguration } }, { profile: ctx.profile, debug: ctx.debug });
  const sugRes = suggestion ? await gql(Q.EDIT_SUGGESTION_DELIVERY,
    { suggestionId: suggestion.id, suggestionDeliveryInput: { deliveryConfiguration } },
    { profile: ctx.profile, debug: ctx.debug }) : null;
  return {
    ok: true,
    option: opt,
    subscriptionUpdated: subRes?.editDeliveryAccountInfo?.id === sub.id,
    suggestionUpdated: sugRes?.editSuggestionDelivery?.id === suggestion.id,
  };
}

// ---------- perfiles ----------

export async function profilesList(args, flags, ctx) {
  const d = await gql(Q.PROFILES, {}, { profile: ctx.profile, debug: ctx.debug });
  const s = d.subscriptionAccountByCustomer;
  return { subscriptionId: s.id, isActive: s.isActive, pausedUntil: s.pausedUntil, profiles: s.profiles };
}

async function resolveProfileId(args) {
  const key = requireId(args[0], '<profile-id|name>');
  const d = await gql(Q.PROFILES, {}, {});
  const profiles = d.subscriptionAccountByCustomer?.profiles || [];
  const p = profiles.find((x) => x.id === key || x._id === key
    || x.name?.toLowerCase() === key.toLowerCase());
  if (!p) throw new CliError(EXIT.NOT_FOUND,
    `Profile '${key}' does not exist. Profiles: ${profiles.map((x) => `${x.name} (${x.id})`).join(', ')}`,
    { reason: 'not_found' });
  return p;
}

export async function profilesPause(args, flags, ctx) {
  const p = await resolveProfileId(args);
  if (ctx.dryRun) return { dryRun: true, wouldSend: { mutation: 'pauseProfile', profileId: p.id } };
  await confirm(flags, `Pause profile '${p.name}' (stops receiving tuppers for that profile).`);
  const d = await gql(Q.PAUSE_PROFILE, { profileId: p.id }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, profile: d.pauseProfile };
}

export async function profilesResume(args, flags, ctx) {
  const p = await resolveProfileId(args);
  if (ctx.dryRun) return { dryRun: true, wouldSend: { mutation: 'resumeProfile', profileId: p.id } };
  await confirm(flags, `Resume profile '${p.name}'.`);
  const d = await gql(Q.RESUME_PROFILE, { profileId: p.id }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, profile: d.resumeProfile };
}

// Deletes a saved address. Protection: if it is in use by the subscription or
// next week, it requires assigning another one first (addresses save).
export async function addrRemove(args, flags, ctx) {
  const id = parseInt(requireId(args[0], '<address-id>'), 10);
  if (!Number.isInteger(id)) throw usageError('The address id must be numeric (they come from `wetaca addresses list`).');
  const d0 = await gql(Q.ADDRESSES, {}, { profile: ctx.profile, debug: ctx.debug });
  const a = (d0.addresses || []).find((x) => x.id === id);
  if (!a) throw new CliError(EXIT.NOT_FOUND, `Address ${id} does not exist.`, { reason: 'not_found' });
  if (a.isSubscriptionAddress || a.isSuggestionAddress) {
    throw usageError(`Address ${id} (${a.street} ${a.number}) is in use; first assign another with \`wetaca addresses save\`.`);
  }
  if (ctx.dryRun) return { dryRun: true, wouldSend: { mutation: 'removeAddress', addressId: id } };
  await confirm(flags, `Delete address ${id} (${a.street} ${a.number}, ${a.zipcode} ${a.city}).`);
  const d = await gql(Q.REMOVE_ADDRESS, { addressId: id }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, removed: d.removeAddress?.id === id, addressId: id };
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

// ---------- vouchers apply / gift cards ----------

// `vouchers apply CODE` / `vouchers skip` — applies (or explicitly skips) a voucher
// on next week's suggestion. NOTE: the API implements `skip` as skipVoucher=true,
// which ALSO sets suggestion.skip=true (pauses next week's delivery). Verified live
// 2026-10-29 — `vouchers skip` == `suggestion pause` + explicit no-voucher.
// Revert with `suggestion resume`.
export async function vouchersApply(args, flags, ctx) {
  const skip = args[0] === 'skip' || flags.skip === true;
  const code = skip ? undefined : args[0];
  if (!skip && !code) throw usageError("Usage: vouchers apply <CODE>  |  vouchers skip (explicitly don't use a voucher).");
  const sid = flags.suggestion || await nextSuggestionId(ctx.profile, ctx.debug);
  const payload = { voucherCode: skip ? undefined : code, skipVoucher: skip, suggestionId: sid };
  if (ctx.dryRun) return { dryRun: true, wouldSend: { mutation: 'assignNextSuggestionVoucher', variables: payload } };
  await confirm(flags, skip
    ? `Skip voucher on next week's delivery (suggestion ${sid}). WARNING: the API also pauses next week's delivery (skipVoucher=true sets suggestion.skip). Revert with: wetaca suggestion resume.`
    : `Apply voucher ${code} to next week's delivery (suggestion ${sid}).`);
  const d = await gql(Q.ASSIGN_NEXT_SUGGESTION_VOUCHER, payload, { profile: ctx.profile, debug: ctx.debug });
  const r = d.assignNextSuggestionVoucher || {};
  return {
    ok: true,
    applied: r.appliedVoucher ? { code: r.appliedVoucher.code, discount: r.appliedVoucher.appliedDiscount } : null,
    skipped: r.skipVoucher === true,
    suggestionId: sid,
  };
}

// `vouchers current` — what voucher (if any) is applied to next week's suggestion.
export async function vouchersCurrent(args, flags, ctx) {
  const d = await gql(Q.NEXT_SUGGESTION_APPLIED_VOUCHER, {}, { profile: ctx.profile, debug: ctx.debug });
  const v = d.nextSuggestion?.appliedVoucher;
  if (!v) return { applied: false, suggestionId: d.nextSuggestion?.id ?? null };
  return { applied: true, suggestionId: d.nextSuggestion.id, code: v.code, discount: v.appliedDiscount };
}

// `giftcards show` — allowed min/max amounts.
export async function giftShow(args, flags, ctx) {
  const d = await gql(Q.GIFT_CARDS_CONFIG, {}, { profile: ctx.profile, debug: ctx.debug });
  const c = d.giftCardsConfiguration || {};
  return { minAmount: c.minAmount, maxAmount: c.maxAmount };
}

// `giftcards redeem CODE` — adds the gift card balance to your wallet.
export async function giftRedeem(args, flags, ctx) {
  const code = args[0];
  if (!code) throw usageError('Usage: giftcards redeem <CODE>.');
  const payload = { code: String(code).trim() };
  if (ctx.dryRun) return { dryRun: true, wouldSend: { mutation: 'redeemGiftCard', variables: payload } };
  await confirm(flags, `Redeem gift card ${payload.code} into your wallet.`);
  const d = await gql(Q.REDEEM_GIFT_CARD, payload, { profile: ctx.profile, debug: ctx.debug });
  const r = d.redeemGiftCard || {};
  return { ok: true, code: r.code, amount: r.amount, amountEur: cents(r.amount) };
}

// ---------- config ----------

export async function configCmd(verb, args, flags, ctx) {
  if (verb === 'path') return { config: configPath(), credentials: credentialsPath() };
  const cfg = loadConfig();
  if (verb === 'list') return { defaultProfile: cfg.defaultProfile, config: { ...cfg.profiles, _meta: { redacted: true } }, note: 'tokens are not shown' };
  if (verb === 'get') {
    const key = args[0];
    if (!key) throw usageError('Missing key: config get <dotted.path>');
    const val = key.split('.').reduce((acc, k) => acc?.[k], cfg);
    return { key, value: val === undefined ? null : (String(key).endsWith('token') ? '***' : val) };
  }
  if (verb === 'set') {
    const [key, ...rest] = args;
    if (!key || rest.length === 0) throw usageError('Usage: config set <key> <value>');
    if (key.endsWith('token')) throw usageError('The token is managed with `wetaca auth login --token`.');
    const value = rest.join(' ') === 'true' ? true : rest.join(' ') === 'false' ? false : rest.join(' ');
    const parts = key.split('.');
    let obj = cfg;
    for (let i = 0; i < parts.length - 1; i++) obj = (obj[parts[i]] ??= {});
    obj[parts[parts.length - 1]] = value;
    saveConfig(cfg);
    return { ok: true, key, value };
  }
  throw usageError(`Config verbs: path | list | get | set`);
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
  } catch (e) { apiDetail = `no connection: ${e.cause?.code || e.message}`; }
  push('api.wetaca.com reachable', apiOk, apiDetail);

  const token = getToken(ctx.profile);
  push('session present', !!token, token ? 'token configured' : 'no token — wetaca auth login');
  if (token) {
    try {
      const d = await gql(Q.TOKEN_IS_VALID, { token }, { profile: ctx.profile, debug: ctx.debug });
      push('token valid', d.tokenIsValid === true, `tokenIsValid=${d.tokenIsValid}`);
    } catch (e) {
      push('token valid', false, e.message);
    }
  }
  push('config directory', true, configDir());
  return { ok: checks.every((c) => c.ok), checks };
}
