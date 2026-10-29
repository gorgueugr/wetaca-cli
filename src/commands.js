// wetaca-cli command implementations.
import readline from 'node:readline/promises';
import child_process from 'node:child_process';
import fs from 'node:fs';
import {
  CliError, usageError, EXIT, gql, cents, fmtDate, emit,
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
  // (las cookies httpOnly llevan el prefijo "#HttpOnly_" en la línea)
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
  // Valor pelado (una única línea sin tabulaciones ni ';'); un "=" puede ser padding base64
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
    // leer token del portapapeles (p. ej. extraído de la consola DevTools de wetaca.com)
    const { execSync } = child_process;
    try {
      const out = process.platform === 'win32'
        ? execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8' })
        : process.platform === 'darwin' ? execSync('pbpaste', { encoding: 'utf8' })
        : execSync('xclip -selection clipboard -o', { encoding: 'utf8' });
      const m = String(out).match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      token = m ? m[0] : String(out).trim();
    } catch (e) {
      throw usageError('No se pudo leer el portapapeles: ' + e.message);
    }
    if (!token) throw usageError('El portapapeles está vacío.');
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
      throw usageError('No se pudo leer el fichero de cookies: ' + e.message);
    }
  }
  if (cookieFileInput != null || flags['refresh-token'] || process.env.WETACA_REFRESH_TOKEN) {
    // Importar el refresh-token de la web (cookie de 120 días)
    // y dejar que /session/refresh fabrique los tokens de sesión. Nunca se pide contraseña.
    let rt;
    if (cookieFileInput != null) {
      rt = extractRefreshToken(cookieFileInput);
    } else {
      rt = String(flags['refresh-token'] || process.env.WETACA_REFRESH_TOKEN).trim();
    }
    if (!rt) {
      throw new CliError(EXIT.AUTH,
        'En el export de cookies no hay ninguna cookie "refresh-token" de wetaca.com. ' +
        'Asegúrate de exportar las cookies estando logueado en wetaca.com (la cookie se crea al iniciar sesión).',
        { reason: 'refresh_token_missing', suggested_commands: ['wetaca auth login --refresh-token VALOR'] });
    }
    saveProfile(ctx.profile, { refreshToken: rt });
    try {
      token = await sessionRefresh(rt, ctx.profile, ctx.debug);
      viaRefresh = true;
    } catch (e) {
      throw new CliError(e.exitCode || EXIT.AUTH,
        'No se pudo renovar la sesión con ese refresh-token. ' + e.message,
        { reason: 'invalid_refresh_token', suggested_commands: ['wetaca auth login --token T'] });
    }
    const c = await gql(Q.CUSTOMER, {}, { token, debug: ctx.debug });
    customer = c.customer;
  } else if (token) {
    // token supplied directly (advanced). Limpiar y validar llamando a la API de verdad
    // (la prueba que importa es que `customer` responda; tokenIsValid es solo diagnóstico).
    token = token.trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '');
    if (!token) throw usageError('El token llegó vacío.');
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
        `La API rechazó el token${isValid === false ? ' (tokenIsValid=false)' : ''}. ` +
        'Comprueba que copiaste SOLO lo que va después de "Bearer " en la cabecera authorization ' +
        '(sin la palabra Bearer, sin comillas). Error original: ' + e.message,
        { reason: 'invalid_token' });
    }
  } else {
    // Sin --refresh-token ni --token: pedirlo por terminal (oculto). Acepta la cookie
    // refresh-token (preferida, dura 120 días) o un JWT de sesión directo.
    if (ctx.noInput || !process.stdin.isTTY) {
      throw usageError('Sin terminal hace falta --refresh-token VALOR (cookie de wetaca.com, F12 → Application → Cookies), o --token VALOR / --token --clipboard.');
    }
    const pasted = await ask('Pega el refresh-token (o el token de sesión) y pulsa Enter: ', { hidden: true });
    const v = (pasted || '').trim().replace(/^["']|["']$/g, '');
    if (!v) throw usageError('No se pegó ningún token.');
    if (v.startsWith('eyJ')) {
      token = v; // JWT de sesión directo
    } else {
      saveProfile(ctx.profile, { refreshToken: v });
      try {
        token = await sessionRefresh(v, ctx.profile, ctx.debug);
        viaRefresh = true;
      } catch (e) {
        throw new CliError(e.exitCode || EXIT.AUTH,
          'No se pudo renovar la sesión con ese refresh-token. ' + e.message,
          { reason: 'invalid_refresh_token', suggested_commands: ['wetaca auth login --token T'] });
      }
    }
    try {
      const c = await gql(Q.CUSTOMER, {}, { token, debug: ctx.debug });
      customer = c.customer;
    } catch (e) {
      throw new CliError(EXIT.AUTH, 'La API rechazó el token. Error original: ' + e.message,
        { reason: 'invalid_token' });
    }
  }

  // Se guardan el token de sesión y (si se importó) el refresh-token. NUNCA la contraseña.
  saveProfile(ctx.profile, {
    token,
    email: customer?.email || null,
  });
  return {
    ok: true, profile: ctx.profile, email: customer?.email || null,
    via: viaRefresh ? 'refresh-token (auto-renovable ~120 días)' : 'token de sesión (caduca; renovalo con --refresh-token)',
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

// Cambia la dirección de entrega: crea la dirección nueva (saveAddress) y la asigna
// a la suscripción (editDeliveryAccountInfo) y a la sugerencia de la semana próxima
// (editSuggestionDelivery), manteniendo la opción de envío actual. Flujo idéntico al de la web.
export async function addrSave(args, flags, ctx) {
  const f = (k) => (flags[k] != null ? String(flags[k]).trim() : undefined);
  const street = f('street'), number = f('number'), zipcode = f('zipcode'), city = f('city');
  if (!street || !number || !zipcode || !city) {
    throw usageError('Faltan campos: --street, --number, --zipcode y --city son obligatorios ' +
      '(opcionales: --floor, --notes, --firstname, --lastname, --phone; por defecto se heredan de tu dirección actual).');
  }
  const cur = await gql(Q.DELIVERY_CONFIG, {}, { profile: ctx.profile, debug: ctx.debug });
  const sub = cur.subscriptionAccountByCustomer;
  const curAddr = sub?.delivery?.address || {};
  const deliveryOptionId = sub?.delivery?.option?.id;
  const suggestion = cur.nextSuggestion;
  if (!deliveryOptionId) throw new CliError(EXIT.DRIFT, 'No pude leer la opción de envío actual de tu suscripción.', { reason: 'no_delivery_option' });

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
  if (address.zipcode == null || Number.isNaN(address.zipcode)) throw usageError('--zipcode debe ser numérico.');
  // OJO: deliveryConfiguration NO lleva "type" — la API devuelve 500 si se lo mandas
  // (probado en vivo; el shape válido es {optionConfiguration: {addressId, deliveryOptionId}}).
  const deliveryConfiguration = { optionConfiguration: { addressId: null, deliveryOptionId } };
  const plan = {
    saveAddress: address,
    subscription: sub ? { mutation: 'editDeliveryAccountInfo', deliveryConfiguration } : null,
    suggestion: suggestion ? { mutation: 'editSuggestionDelivery', suggestionId: suggestion.id, deliveryConfiguration } : null,
  };
  if (ctx.dryRun) return { dryRun: true, wouldSend: plan };
  await confirm(flags, `Cambiar tu dirección de entrega a ${street} ${number}${address.floor ? ', ' + address.floor : ''} (${address.zipcode} ${city}).`);
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

// ---------- catálogo ----------

// Menú semanal disponible para tu CP (los ids son los que usa suggestion edit --set)
export async function menuList(args, flags, ctx) {
  const zipcode = flags.zipcode != null ? parseInt(flags.zipcode, 10) : undefined;
  const d = await gql(Q.SEGMENT_MENU, { zipcode, isSubscriptionIntent: true }, { profile: ctx.profile, debug: ctx.debug });
  const m = d.segmentMenu;
  if (!m) throw new CliError(EXIT.NOT_FOUND, 'No hay menú disponible para ese código postal.', { reason: 'no_menu' });
  return { week: m.week, year: m.year, dateFrom: m.dateFrom, dateTo: m.dateTo, dishes: m.dishes };
}

export async function dishShow(args, flags, ctx) {
  const slug = args[0];
  if (!slug) throw usageError('Uso: wetaca dish show <slug>  (los slugs salen de `wetaca menu list`)');
  const d = await gql(Q.DISH, { slug }, { profile: ctx.profile, debug: ctx.debug });
  if (!d.dish) throw new CliError(EXIT.NOT_FOUND, `No existe el plato '${slug}'.`, { reason: 'not_found' });
  return d.dish;
}

// ---------- franja de entrega ----------

export async function delivOptions(args, flags, ctx) {
  const cur = await gql(Q.DELIVERY_CONFIG, {}, { profile: ctx.profile, debug: ctx.debug });
  const zipcode = flags.zipcode != null ? parseInt(flags.zipcode, 10) : cur.subscriptionAccountByCustomer?.delivery?.address?.zipcode;
  if (!zipcode) throw usageError('No pude leer tu CP; pásalo con --zipcode.');
  const d = await gql(Q.DELIVERY_OPTIONS, { zipcode }, { profile: ctx.profile, debug: ctx.debug });
  const currentId = cur.subscriptionAccountByCustomer?.delivery?.option?.id;
  return d.deliveryOptions.map((o) => ({ ...o, isCurrent: o.id === currentId, priceEur: cents(o.price) }));
}

// Cambia la franja de entrega (option) para la suscripción y la semana próxima.
export async function delivSetOption(args, flags, ctx) {
  const optionId = parseInt(requireId(args[0], '<option-id>'), 10);
  if (!Number.isInteger(optionId)) throw usageError('El id de franja debe ser numérico (salen de `wetaca deliveries options`).');
  const cur = await gql(Q.DELIVERY_CONFIG, {}, { profile: ctx.profile, debug: ctx.debug });
  const sub = cur.subscriptionAccountByCustomer;
  const suggestion = cur.nextSuggestion;
  const curOption = sub?.delivery?.option;
  if (!curOption) throw new CliError(EXIT.DRIFT, 'No pude leer la franja actual.', { reason: 'no_delivery_option' });
  const opts = await gql(Q.DELIVERY_OPTIONS, { zipcode: sub?.delivery?.address?.zipcode }, { profile: ctx.profile, debug: ctx.debug });
  const opt = (opts.deliveryOptions || []).find((o) => o.id === optionId);
  if (!opt) throw new CliError(EXIT.NOT_FOUND,
    `La franja ${optionId} no está disponible para tu CP. Disponibles: ${(opts.deliveryOptions || []).map((o) => o.id).join(', ')}`,
    { reason: 'option_not_available' });
  const deliveryConfiguration = { optionConfiguration: { deliveryOptionId: optionId, addressId: sub?.delivery?.address?.id } };
  const plan = {
    option: opt,
    subscription: { mutation: 'editDeliveryAccountInfo', deliveryConfiguration },
    suggestion: suggestion ? { mutation: 'editSuggestionDelivery', suggestionId: suggestion.id, deliveryConfiguration } : null,
  };
  if (ctx.dryRun) return { dryRun: true, wouldSend: plan };
  await confirm(flags, `Cambiar tu franja de entrega a ${fmtWindow(opt)} (era ${fmtWindow(curOption)}).`);
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
  const key = requireId(args[0], '<perfil-id|nombre>');
  const d = await gql(Q.PROFILES, {}, {});
  const profiles = d.subscriptionAccountByCustomer?.profiles || [];
  const p = profiles.find((x) => x.id === key || x._id === key
    || x.name?.toLowerCase() === key.toLowerCase());
  if (!p) throw new CliError(EXIT.NOT_FOUND,
    `No existe el perfil '${key}'. Perfiles: ${profiles.map((x) => `${x.name} (${x.id})`).join(', ')}`,
    { reason: 'not_found' });
  return p;
}

export async function profilesPause(args, flags, ctx) {
  const p = await resolveProfileId(args);
  if (ctx.dryRun) return { dryRun: true, wouldSend: { mutation: 'pauseProfile', profileId: p.id } };
  await confirm(flags, `Pausar el perfil '${p.name}' (deja de recibir tuppers de ese perfil).`);
  const d = await gql(Q.PAUSE_PROFILE, { profileId: p.id }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, profile: d.pauseProfile };
}

export async function profilesResume(args, flags, ctx) {
  const p = await resolveProfileId(args);
  if (ctx.dryRun) return { dryRun: true, wouldSend: { mutation: 'resumeProfile', profileId: p.id } };
  await confirm(flags, `Reactivar el perfil '${p.name}'.`);
  const d = await gql(Q.RESUME_PROFILE, { profileId: p.id }, { profile: ctx.profile, debug: ctx.debug });
  return { ok: true, profile: d.resumeProfile };
}

// Borra una dirección guardada. Protección: si está en uso por la suscripción o la
// semana próxima, exige asignar antes otra (addresses save).
export async function addrRemove(args, flags, ctx) {
  const id = parseInt(requireId(args[0], '<address-id>'), 10);
  if (!Number.isInteger(id)) throw usageError('El id de dirección debe ser numérico (salen de `wetaca addresses list`).');
  const d0 = await gql(Q.ADDRESSES, {}, { profile: ctx.profile, debug: ctx.debug });
  const a = (d0.addresses || []).find((x) => x.id === id);
  if (!a) throw new CliError(EXIT.NOT_FOUND, `No existe la dirección ${id}.`, { reason: 'not_found' });
  if (a.isSubscriptionAddress || a.isSuggestionAddress) {
    throw usageError(`La dirección ${id} (${a.street} ${a.number}) está en uso; primero asigna otra con \`wetaca addresses save\`.`);
  }
  if (ctx.dryRun) return { dryRun: true, wouldSend: { mutation: 'removeAddress', addressId: id } };
  await confirm(flags, `Borrar la dirección ${id} (${a.street} ${a.number}, ${a.zipcode} ${a.city}).`);
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

// ---------- config ----------

export async function configCmd(verb, args, flags, ctx) {
  if (verb === 'path') return { config: configPath(), credentials: credentialsPath() };
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
