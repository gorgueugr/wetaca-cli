#!/usr/bin/env node
// wetaca-cli — entry point: arg parsing, dispatch, help, error handling.
import { CliError, EXIT, printError, loadConfig, configPath, VERSION } from '../src/lib.js';
import * as C from '../src/commands.js';
import { GUIDE } from '../src/guide.js';

const HELP = `wetaca-cli ${VERSION} — your Wetaca from the terminal.

USAGE
  wetaca [global flags] <noun> <verb> [args] [flags]

COMMANDS
  auth          login [--token T [--clipboard] | --refresh-token COOKIE | --cookies FILE | --cookies-stdin] | status | logout
  auth login opens https://wetaca.com in your browser: in DevTools (F12 -> Network ->
                any request to api.wetaca.com) copy what comes after "authorization: Bearer "
                (the session token) -> paste it at the prompt or pass --token T. The CLI
                validates it and mints the session cookies via POST /session/start
                (auth-token + refresh-token pair), so the session auto-renews itself
                (~120 days). The password is never asked for.
                Also accepted: --refresh-token COOKIE, a whole "Cookie:" header line, or a
                cookie export (--cookies FILE / --cookies-stdin: Netscape, Cookie-Editor JSON).
                Note: the server validates the auth-token + refresh-token PAIR; a bare
                refresh-token always fails with 401.
  me            show                       account summary
  subscription  show | pause [--weeks N] | resume
  suggestion    show | pause | resume | edit --profile-suggestion ID --set "id:qty,..."
  deliveries    next | options | set-option <id>   pending deliveries and orders / available slots / change slot
  menu          list [--zipcode ZIP]               weekly menu (dish ids for suggestion edit)
  dish          show <slug>                        dish detail
  profiles      list | pause <id|name> | resume <id|name>
  orders        list [--limit N] | show <id> | cancel <id> [--dry-run]
  addresses     list | save --street S --number N [--floor F] --zipcode ZIP --city CITY
                save: changes your delivery address (subscription + next week);
                optional --notes --firstname --lastname --phone (inherit the current ones by default)
                --dry-run shows the exact plan before executing
                remove <id>: deletes an unused address
  vouchers      list | current | apply <CODE> | skip    vouchers and applying them to next week
  giftcards     show | redeem <CODE>            gift cards: limits and redeem into your wallet
  wallet        show
  config        path | list | get <k> | set <k> <v>
  doctor        diagnostics (node, network, session)
  skills        get wetaca-usage           AI-agent guide (embedded)
  completion    bash | zsh | fish          autocompletion script

GLOBAL FLAGS
  --format json|jsonl|pretty   output (default json)
  --error-format text|json     errors on stderr (default text)
  --profile NAME               session profile (env WETACA_PROFILE)
  --yes                        confirm without asking
  --no-input                   never prompt; mutations require --yes
  --dry-run                    show what would be done, no effects
  --debug                      one line per HTTP request on stderr
  --no-color                   disable color (also NO_COLOR)

  Top-level aliases: \`me\`, \`doctor\`. Without a session: \`wetaca auth login\`.
  Docs: docs/cli-spec.md. Not affiliated with Wetaca; uses the wetaca.com web API.
`;

const COMPLETION = {
  bash: `_wetaca() {
  local cur prev nouns="auth me subscription suggestion deliveries orders addresses vouchers wallet config doctor skills completion"
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "$nouns" -- "$cur") ); fi
  return 0
}
complete -F _wetaca wetaca`,
  zsh: `#compdef wetaca
_wetaca() { _alternative 'args:command:(auth me subscription suggestion deliveries orders addresses vouchers wallet config doctor skills completion)' }
_wetaca "$@"`,
  fish: `complete -c wetaca -n '__fish_use_subcommand' -a 'auth me subscription suggestion deliveries orders addresses vouchers wallet config doctor skills completion'`,
};

// ---------- flag parsing ----------
const BOOL_FLAGS = new Set(['yes', 'no-input', 'dry-run', 'debug', 'no-color', 'help', 'version', 'clipboard', 'cookies-stdin']);
const VALUE_FLAGS = new Set(['format', 'error-format', 'profile', 'token', 'refresh-token', 'cookies',
  'weeks', 'feedback', 'set', 'limit', 'offset', 'suggestion', 'profile-suggestion', 'resume', 'code', 'state',
  'street', 'number', 'floor', 'zipcode', 'city', 'notes', 'firstname', 'lastname', 'phone']);

function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let val = eq === -1 ? undefined : a.slice(eq + 1);
      if (val === undefined) {
        if (!BOOL_FLAGS.has(key) && VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          val = argv[++i];
        } else {
          val = true;
        }
      }
      flags[key] = val;
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function normalizeFlags(flags) {
  const out = {};
  for (const [k, v] of Object.entries(flags)) {
    if (BOOL_FLAGS.has(k)) out[k] = v === true || v === 'true';
    else out[k] = v === true ? true : String(v);
  }
  return out;
}

// ---------- dispatch ----------
function makeCtx(flags) {
  const cfg = loadConfig();
  return {
    profile: flags.profile || process.env.WETACA_PROFILE || cfg.defaultProfile || 'default',
    format: flags.format || (process.env.WETACA_FORMAT === 'pretty' ? 'pretty' : 'json'),
    jsonl: flags.format === 'jsonl',
    errorFormat: flags['error-format'] || (process.env.WETACA_ERROR_FORMAT === 'json' ? 'json' : 'text'),
    yes: flags.yes === true,
    noInput: flags['no-input'] === true || process.env.WETACA_NO_INPUT === '1',
    dryRun: flags['dry-run'] === true,
    debug: flags.debug === true,
  };
}

async function main() {
  const { flags: rawFlags, positional } = parseArgs(process.argv.slice(2));
  const flags = normalizeFlags(rawFlags);
  const ctx = makeCtx(flags);

  if (flags.version) { console.log(VERSION); return 0; }
  if (flags.help || positional.length === 0 || positional[0] === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const [noun, verb, ...args] = positional;
  let result;

  switch (noun) {
    case 'auth':
      if (verb === 'login') result = await C.authLogin(args, flags, ctx);
      else if (verb === 'status') result = await C.authStatus(args, flags, ctx);
      else if (verb === 'logout') result = await C.authLogout(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'me':
      if (verb === 'show' || verb === undefined) result = await C.meShow(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'subscription':
      if (verb === 'show') result = await C.subShow(args, flags, ctx);
      else if (verb === 'pause') result = await C.subPause(args, flags, ctx);
      else if (verb === 'resume') result = await C.subResume(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'suggestion':
      if (verb === 'show') result = await C.sugShow(args, flags, ctx);
      else if (verb === 'pause') result = await C.sugPause(args, flags, ctx);
      else if (verb === 'resume') result = await C.sugResume(args, flags, ctx);
      else if (verb === 'edit') result = await C.sugEdit(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'deliveries':
      if (verb === 'next' || verb === undefined) result = await C.deliveriesNext(args, flags, ctx);
      else if (verb === 'options') result = await C.delivOptions(args, flags, ctx);
      else if (verb === 'set-option') result = await C.delivSetOption(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'menu':
      if (verb === 'list' || verb === undefined) result = await C.menuList(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'dish':
      if (verb === 'show' || verb === undefined) result = await C.dishShow(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'profiles':
      if (verb === 'list' || verb === undefined) result = await C.profilesList(args, flags, ctx);
      else if (verb === 'pause') result = await C.profilesPause(args, flags, ctx);
      else if (verb === 'resume') result = await C.profilesResume(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'orders':
      if (verb === 'list') result = await C.ordersList(args, flags, ctx);
      else if (verb === 'show') result = await C.ordersShow(args, flags, ctx);
      else if (verb === 'cancel') result = await C.ordersCancel(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'addresses':
      if (verb === 'list') result = await C.addrList(args, flags, ctx);
      else if (verb === 'save') result = await C.addrSave(args, flags, ctx);
      else if (verb === 'remove') result = await C.addrRemove(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'vouchers':
      if (verb === 'list' || verb === undefined) result = await C.vouchersList(args, flags, ctx);
      else if (verb === 'apply') result = await C.vouchersApply(args, flags, ctx);
      else if (verb === 'skip') result = await C.vouchersApply(['skip'], flags, ctx);
      else if (verb === 'current') result = await C.vouchersCurrent(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'giftcards':
      if (verb === 'show' || verb === undefined) result = await C.giftShow(args, flags, ctx);
      else if (verb === 'redeem') result = await C.giftRedeem(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'wallet':
      if (verb === 'show' || verb === undefined) result = await C.walletShow(args, flags, ctx);
      else throw usageUnknown(noun, verb);
      break;
    case 'config':
      result = await C.configCmd(verb, args, flags, ctx);
      break;
    case 'doctor':
      result = await C.doctor(args, flags, ctx);
      break;
    case 'skills':
      if (verb === 'get' && args[0] === 'wetaca-usage') { process.stdout.write(GUIDE); return 0; }
      if (verb === 'list') { result = { skills: [{ id: 'wetaca-usage', description: 'AI-agent usage guide' }] }; break; }
      throw new CliError(EXIT.USAGE, "skills get expects 'wetaca-usage'.");
    case 'completion': {
      const s = COMPLETION[verb];
      if (!s) throw new CliError(EXIT.USAGE, 'completion expects: bash | zsh | fish');
      process.stdout.write(s + '\n');
      return 0;
    }
    default:
      throw new CliError(EXIT.USAGE, `Sustantivo desconocido '${noun}'.`, { suggested_commands: ['wetaca --help'] });
  }

  if (result !== undefined && result !== null) {
    const { emit } = await import('../src/lib.js');
    emit(result, ctx);
  }
  return 0;
}

function usageUnknown(noun, verb) {
  return new CliError(EXIT.USAGE, `Verbo desconocido: ${noun} ${verb}.`, { suggested_commands: [`wetaca ${noun} --help`, 'wetaca --help'] });
}

main()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => {
    const { flags } = parseArgs(process.argv.slice(2));
    const errorFormat = flags['error-format'] === 'json' ? 'json' : 'text';
    const debug = flags.debug === true;
    if (err instanceof CliError) {
      printError(err, errorFormat, debug);
      process.exitCode = err.exitCode;
    } else {
      printError(new CliError(EXIT.UNEXPECTED, err.message, { reason: 'unexpected', details: { stack: err.stack } }), errorFormat, debug);
      process.exitCode = EXIT.UNEXPECTED;
    }
  });
