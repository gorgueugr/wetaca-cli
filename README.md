# wetaca-cli

Manage your **Wetaca** from the terminal: subscription, weekly menu, deliveries and orders. Designed for people **and for AI agents**.

```
wetaca suggestion show --format pretty
```

```
id: 68f21a...
skip: false
validUntil: Thu 30 Oct 23:59
week: { week: 45, year: 2026 }
pricingEur: { toPay: €42.30, shipping: €0.00 }
profiles: 2 (Profile 1, Profile 2)
```

- **Everything you do on the web**: view next week's menu per profile, swap tuppers, skip a week, pause the subscription, view past deliveries, cancel an order, vouchers and wallet.
- **Built for scripts and AI agents**: JSON by default, stable exit codes, JSON error wrapper, `--dry-run`, and an embedded usage guide (`wetaca skills get wetaca-usage`).
- A single dependency-free Node package. Requires Node ≥ 18.

## Install

```
npm install -g wetaca-cli    # from npm
wetaca doctor
```

Or from the repo: `npm install -g .`

## Get started

```
wetaca auth login --refresh-token <COOKIE>   # refresh-token cookie from wetaca.com (lasts ~120 days)
wetaca auth login               # prompts for the refresh-token (hidden); also accepts a session JWT
wetaca me --format pretty
```

The refresh-token is stored in `%USERPROFILE%\.config\wetaca-cli\credentials.json` (or `$XDG_CONFIG_HOME/wetaca-cli`), with restrictive permissions (your user only); the remaining settings live in `config.json`. In CI: `WETACA_TOKEN` or `WETACA_REFRESH_TOKEN`.

## Quickstart

```
# what's on this week?
wetaca suggestion show --format pretty

# skip next week (asks for confirmation)
wetaca suggestion pause

# swap the menu's tuppers (dry-run first, then --yes)
wetaca suggestion edit --profile-suggestion ID --set "productId:2,productIdB:1" --dry-run
wetaca suggestion edit --profile-suggestion ID --set "productId:2,productIdB:1" --yes

# pause for holidays
wetaca subscription pause --weeks 2 --yes
wetaca subscription resume

# orders
wetaca deliveries next
wetaca orders cancel 12345 --dry-run
wetaca orders cancel 12345 --yes

# for AI agents
wetaca skills get wetaca-usage
```

## Documentation

| doc | |
|---|---|
| [Specification](docs/cli-spec.md) | every command, flag, exit code and GraphQL operation |
| [Extracted operations](docs/api-operations/) | the ~190 GraphQL documents from Wetaca's website |
| [Agent guide](docs/agent-guide.md) | `wetaca skills get wetaca-usage` |

## Good to know

- **Not affiliated with Wetaca.** Independent project, not related to Wetaca. It uses the `api.wetaca.com` GraphQL API (the same one as the website and the app). Wetaca may change it; if it does, the CLI exits with code 7 (`contract_drift`).
- **Your session stays local.** The refresh-token is stored only on your disk (separate file, restrictive permissions) and only travels to Wetaca.
- **Nothing without confirmation.** Operations with real effects (`suggestion pause/edit`, `subscription pause`, `orders cancel`) show a summary and ask for confirmation; without a terminal they require `--yes`.
- **Does not touch payments.** Cards and pending payments are managed on wetaca.com.
- Be kind: this CLI makes few requests, one per command.

## Credits & inspiration

This project is based on the design and experience of other CLIs of the same kind:

- [booksy-cli](https://github.com/GodGMN/booksy-cli) — Booksy management from the terminal; the origin of the contract wetaca-cli follows (JSON by default, stable exit codes, `--dry-run`, an AI-agent guide, cookie-based session with a separate credentials file).
- [wallapop-cli](https://github.com/Microck/wallapop-cli) — Wallapop management from the terminal; the reference for long-lived cookie login and importing browser cookie exports (`--cookies`).

Built with [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research).

## License

MIT.
