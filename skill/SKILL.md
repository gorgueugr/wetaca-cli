---
name: wetaca-usage
description: Use when the user asks about Wetaca meals or deliveries.
version: 0.2.4
author: Jorge Soler Padial (https://github.com/gorgueugr)
license: MIT
metadata:
  hermes:
    tags: [wetaca, cli, account-management]
---

# wetaca-cli — agent guide

Run the embedded, version-matched guide (source of truth, kept in sync with the installed binary):

```
wetaca skills get wetaca-usage
```

If `wetaca` is not installed: `npm install -g wetaca-cli` (requires Node >= 18).

## When to Use

- The user asks about their Wetaca account: weekly menu, subscription, deliveries, orders, vouchers, gift cards, wallet or addresses.
- The user wants to change next week's menu, skip a week, pause the subscription, cancel an order or apply a voucher.

## Contract

Every command returns JSON on stdout by default (`--format pretty` for humans); errors go to stderr as JSON with `--error-format json`; stable exit codes (0 ok · 1 unexpected · 2 usage/confirmation · 3 auth · 4 network · 5 not found · 6 API rejected · 7 contract drift).

## Golden rules

1. Reads are safe. Run them freely.
2. Mutations need a summary shown to the user; pass `--yes` only for an explicitly requested operation.
3. Use `--dry-run` on `suggestion edit`, `addresses save`, `deliveries set-option`, `orders cancel` before any real run.
4. Never touch payments — the CLI does not either.
5. `reason: "auth_required"` → the user must run `wetaca auth login` (cookie-based; no password involved).

Project source: https://github.com/gorgueugr/wetaca-cli
