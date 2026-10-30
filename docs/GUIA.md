# wetaca-cli Guide

Verified against a real account (Nov 2026). Reads = no risk. Actions = ask for confirmation.
The ids and addresses in the examples are fictional.

## 1. Query (read-only, no risk)

```bash
wetaca me                          # your account: subscription, wallet
wetaca suggestion show             # THE STAR: next week's menu by profile,
                                   # delivery window, address and total price
wetaca suggestion show --format pretty
wetaca deliveries next             # suggestion + pending orders + pending payments
wetaca orders list --limit 10      # order history (id, reference, date, amount, invoice)
wetaca orders show 1234567         # order detail: dishes, address, time slot
wetaca orders list --limit 3 --format jsonl   # one JSON line per order (ideal for jq/scripts)
wetaca addresses list
wetaca vouchers list
wetaca wallet
```

With `jq`:
```bash
wetaca suggestion show | jq '.deliveryWindow'                       # when your turn is
wetaca suggestion show | jq '.profiles[0].products[].name'          # which dishes are due
wetaca orders list | jq 'map(select(.state=="PAYMENT_CONFIRMED"))'  # paid only
```

## 2. Actions (real effects; they ask for confirmation or --yes)

### Skip next week
```bash
wetaca suggestion pause            # asks y/N in the terminal
wetaca suggestion pause --yes      # no prompt (scripts/agents)
wetaca suggestion resume           # undo
```
The `validUntil` of `suggestion show` is the deadline: after that date and time it can no longer be edited.

### Change the tuppers in the week's menu
```bash
# 1. look up the ids: productId (the dishes) and profileSuggestionId (your week's menu)
wetaca suggestion show | jq '.profiles[0] | {profileSuggestionId, products: [.products[] | {id, name, quantity}]}'

# 2. simulate the change (--set "productId:quantity,productId:quantity"; quantity 0 = remove)
wetaca suggestion edit --profile-suggestion <PROFILE_SUGGESTION_ID> --set "124:2" --dry-run

# 3. execute
wetaca suggestion edit --profile-suggestion <PROFILE_SUGGESTION_ID> --set "124:2" --yes
```

### Vacation pause
```bash
wetaca subscription pause --weeks 2 --yes   # pauses for 2 weeks
wetaca subscription resume                  # reactivates
wetaca subscription show                    # current status
```

### View the week's menu and choose dishes
```bash
wetaca menu list                                  # 43 dishes with id, category and price
wetaca menu list | jq '.dishes[] | select(.category.slug=="entrantes") | {id, name}'
wetaca dish show lasana-de-pavo-y-pesto           # ingredients, allergens, description
```

### Change the delivery time slot
```bash
wetaca deliveries options                         # available slots (the current one shows isCurrent)
wetaca deliveries set-option 117 --dry-run        # simulate
wetaca deliveries set-option 117 --yes            # applies to subscription + next week
```

### Profiles
```bash
wetaca profiles list
wetaca profiles pause <id|name> --dry-run       # pauses only that profile
```

### Change the delivery address
```bash
# simulation of the exact plan (nothing is touched)
wetaca addresses save --street "Calle Ejemplo" --number 1 --floor 2A --zipcode 18006 --city Granada --dry-run

# execute (asks for confirmation; --yes for scripts): creates the address and assigns it to the
# subscription and to next week, keeping the current delivery slot
wetaca addresses save --street "Calle Ejemplo" --number 1 --floor 2A --zipcode 18006 --city Granada --yes
```
First name, last name, phone and notes are inherited from your current address unless you pass
--firstname/--lastname/--phone/--notes. Verify afterwards with `wetaca addresses list`.

### Cancel a confirmed order
```bash
wetaca orders cancel 1234567 --dry-run      # see what it would do
wetaca orders cancel 1234567 --yes          # cancel (refunds the amount)
```

## 3. Automate with AI agents

Agents (Hermes, Claude, a cron job...) must start with:
```
wetaca skills get wetaca-usage
```
That embedded guide always matches the installed version and describes the contract:
JSON on stdout, JSON errors with `--error-format json`, stable exit codes
(0 ok · 2 usage/confirmation · 3 auth · 4 network · 5 not found · 6 API · 7 drift),
`--no-input` + `--yes` for non-interactive, `--dry-run` to simulate.

Golden rule for agents: read a lot, write little, and show a summary before `--yes`.

Automation ideas (cron):
- Every Thursday: `suggestion show` → summary via Telegram → you reply with changes → agent applies them with `--yes`.
- Every Wednesday: if `suggestion show | jq -r .validUntil` is close and `skip=false`, send a reminder to decide on pausing.
- Invoice alert: `orders list` → if a new order appears compared to the last check, notify.

## 4. Session

- Status: `wetaca auth status` · Login: `wetaca auth login --token <TOKEN>` (or `--token --clipboard`): copy the `authorization: Bearer ***` header of any request to api.wetaca.com in DevTools (F12 -> Network). The CLI validates it and mints the session cookies via POST /session/start (auth-token + refresh-token pair), so the session auto-renews itself for ~120 days. VERIFIED end-to-end. Note: the server validates the cookie PAIR — a bare refresh-token always 401s.
- The token lives in `~/.config/wetaca-cli/credentials.json` (0600) and the rest of the settings in `config.json`; `WETACA_TOKEN` overrides it (CI).
- If the API rejects it (exit 3), redo the extraction with DevTools (docs/cli-spec.md §6).
