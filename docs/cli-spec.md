# wetaca-cli spec

Status: v0.1, 2026-10-29. Vocabulary in section 2. The endpoint facts come from the
bundle of the wetaca.com website (SPA v49.6.0) and from live testing on that day. Unofficial API, may drift.

## 1. Name

Binary `wetaca`. npm package `wetaca-cli`, JavaScript (Node >= 18), zero dependencies.

## 2. Vocabulary

**Subscription (SubscriptionAccount)**: your recurring customer account, id `ModelId`. It has profiles, a delivery address, delivery slot and price.

**Profile (SubscriptionProfile)**: a person within the subscription, with their own menu, allergens and preferences.

**Suggestion (Suggestion)**: the proposed order for a week, identified by `id` (ModelId). It is what gets charged if nothing is touched. `skip=true` means a skipped week.

**Profile-suggestion (profileSuggestion)**: the menu of a profile within a Suggestion. The one edited with `suggestion edit`.

**Delivery (Delivery/Order)**: a concrete order, numeric id (`Int`), with `reference`, status and `invoiceUrl`.

**Slot (option)**: delivery time window (`start`, `end`, `price`).

**Next suggestion**: `nextSuggestion`, the upcoming not-yet-charged week. It is the one managed by `suggestion *`.

## 3. Command tree

```
auth        login [--refresh-token COOKIE | --cookies FILE | --cookies-stdin | --token T [--clipboard]] | status | logout
me          show
subscription  show | pause [--weeks N] [--feedback S] | resume
suggestion  show | pause [--feedback S] | resume | edit --profile-suggestion ID --set "id:qty,..."
deliveries  next | options [--zipcode ZIP] | set-option <id>
menu        list [--zipcode ZIP]            weekly menu (dish ids for suggestion edit)
dish        show <slug>                     dish details
profiles    list | pause <id|name> | resume <id|name>
orders      list [--limit N] [--offset N] | show <id> | cancel <id>
addresses   list | save --street S --number N [--floor F] --zipcode ZIP --city CITY | remove <id>
            save creates the address and assigns it to the subscription and to the next week
            (website flow: saveAddress -> editDeliveryAccountInfo -> editSuggestionDelivery);
            optional --notes --firstname --lastname --phone; confirmation unless --yes
            remove only deletes addresses not in use
vouchers    list
wallet      show
config      path | list | get <k> | set <k> <v>
doctor
skills      list | get wetaca-usage
completion  bash | zsh | fish
```

## 4. Global flags

`--format json|jsonl|pretty` (env `WETACA_FORMAT`), `--error-format text|json` (env `WETACA_ERROR_FORMAT`),
`--profile NAME` (env `WETACA_PROFILE`), `--yes`, `--no-input` (env `WETACA_NO_INPUT=1`),
`--dry-run`, `--debug`, `--no-color`, `--help`, `--version`.

## 5. Contract for agents

- stdout: JSON (one object per command; `orders list` and `addresses list` return an array; `--format jsonl` emits one line per item of those lists).
- stderr: warnings and errors. `--error-format json` -> `{ error: { code, category, reason, retryable, message, suggested_commands, details? } }`.
- Exit codes: `0` ok / `1` unexpected / `2` usage/validation/confirmation denied / `3` auth (login or expired token) / `4` network / `5` not found / `6` the API rejected the operation (graphql_error/http_*) / `7` contract drift (`contract_drift`, `null_field`).
- Confirmation: every mutation with real effects shows a summary and asks `y/N`; without a TTY (or with `--no-input`) it requires `--yes`. `--dry-run` (on `suggestion edit` and `orders cancel`) prints the payload with no effects.
- Embedded guide: `wetaca skills get wetaca-usage`.

## 6. Session

- **Recommended path - session token + auto-start**: copy the `authorization: Bearer ***` header of any request to api.wetaca.com in DevTools (F12 -> Network) and run `wetaca auth login --token <TOKEN>` (or `--token --clipboard`, or paste it when the CLI prompts for it, hidden). The CLI validates it with the `customer` query and then mints the session cookies exactly like the website does after a login: `POST https://wetaca.com/session/start` body `{token}` (header `x-wetaca-session: 1`, browser UA) -> Set-Cookie with the **pair** `auth-token` (path=/) + `refresh-token` (path=/session/refresh), both httpOnly. The pair is stored in `credentials.json` (0600) as `sessionAuthToken` + `refreshToken`. VERIFIED end-to-end against a real account.
- **Auto-renewal**: when the session token expires (~1h), the CLI transparently calls `POST https://wetaca.com/session/refresh` (header `x-wetaca-session: 1`, browser UA) with the cookie **pair** `Cookie: auth-token=X; refresh-token=Y` and retries the request. The server validates the pair: sending only the refresh-token ALWAYS returns 401 (this is why a bare `--refresh-token VALUE` copied from the browser does not work). Each response issues a new `auth-token`, which the CLI stores; the refresh cookie lasts ~120 days.
- **Import from a cookie export**: `wetaca auth login --cookies cookies.txt` or `--cookies-stdin`. Formats: Netscape cookies.txt (includes `#HttpOnly_` lines), Cookie-Editor/EditThisCookie JSON (array or `{url, cookies}`), `Cookie:` header, or the bare value. Only wetaca.com cookies are read; the import must include BOTH `auth-token` and `refresh-token` or the refresh will 401.
- **The password is never requested or stored** (user's decision). The `sessionTokenByPassword` endpoints exist in the API but the CLI does not use them.
- Validation: the test that matters is that the `customer` query responds with the token (`tokenIsValid` is diagnostic only: it returned false with valid tokens).
- Storage: secrets (token, sessionAuthToken, refreshToken) in `credentials.json` with restrictive permissions (0600 / user-only ACL); everything else in `config.json`. Env: `WETACA_TOKEN` (CI, highest priority), `WETACA_REFRESH_TOKEN` (CI, auto-refresh without disk). Profiles: `--profile` / `WETACA_PROFILE` / `defaultProfile`.
- Header: `authorization: Bearer ***` on every request.

## 7. API

- Endpoint: `POST https://api.wetaca.com/graphql` (Apollo Server, introspection disabled), JSON `{query, variables}`. `WETACA_API_URL` overrides it (tests).
- Types used by the CLI: `ModelId` (string), `Int` (order ids), `OrderProductMapGraph` (`{id, quantity}` in `productsInput`), `EditSuggestionDeliveryGraph` (not yet used by the CLI).
- Drift: top-level `null` field without errors -> exit 7. `UNAUTHENTICATED` error -> exit 3.

## 8. Operations used (v0.1)

| command | operation |
|---|---|
| auth login | `sessionTokenByPassword`, `tokenIsValid` |
| auth status | `tokenIsValid`, `customer` |
| auth logout | `registerLogout` |
| me | `customer`, `subscriptionAccountByCustomer` (status), `walletBalance` |
| subscription show | `subscriptionAccountByCustomer` (full) + `nextSuggestion` |
| subscription pause | `cancelSubscriptionAccount(pausedWeeks)` |
| subscription resume | `activateSubscriptionAccount` |
| suggestion show | `nextSuggestion` (per-profile menus, pricing, delivery) |
| suggestion pause/resume | `pauseSuggestion` / `resumeSuggestion` |
| suggestion edit | `editProfileSuggestionProducts` |
| deliveries next | `nextSuggestions` + `nextDeliveries` + `nextPaymentPendingOrder` |
| orders list | `previousDeliveries(limit, offset)` |
| orders show | `order(id)` |
| orders cancel | `cancelConfirmedOrder(orderId)` |
| addresses list | `addresses` |
| vouchers list | `vouchers(limit, skipExpired, skipFuture)` |
| wallet show | `walletBalance` |

## 9. Not supported yet (present on the website, not in the CLI)

Payments (Redsys/PayPal/GooglePay/ApplePay), changing the payment method, scheduled wallet top-ups,
changing the delivery address/slot (`editSuggestionDelivery`, the `EditSuggestionDeliveryGraph` input
is unvalidated), new account sign-up with SMS, Google OAuth, weekly survey, active referrals.

## 10. Known limitations

- The `productId`/`profileSuggestionId` ids are internal; they are obtained from `suggestion show`/`deliveries next`.
- The price is returned in cents (the `*Eur` field is already formatted in some responses).
- `subscription pause` uses `cancelSubscriptionAccount` with `pausedWeeks`; the API treats it as a temporary pause. Without `--weeks` it is an indefinite pause; reactivate with `subscription resume`.
