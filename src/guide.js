// AI-agent usage guide, embedded in the CLI (wetaca skills get wetaca-usage).
export const GUIDE = `# wetaca-cli — guide for AI agents

Manage the user's Wetaca account (weekly meal subscription) from the terminal.
Every command returns JSON on stdout by default; errors go to stderr.

## Before you start

1. Run \`wetaca doctor\` to check node, connectivity and session.
2. \`wetaca auth status\` tells you whether there is a valid session. If there isn't:
   - \`wetaca auth login --cookies cookies.txt\` (export with the Cookie-Editor extension on wetaca.com while logged in) or \`--refresh-token COOKIE\` (a wetaca.com cookie, lasts ~120 days; the CLI renews the token on its own). No password involved.
   - \`wetaca auth login --token T\` or \`--token --clipboard\`: token copied from the
     \`authorization: Bearer *** header of any request to api.wetaca.com in the
     user's DevTools (F12 → Network). This is the way to go if their account logs in with Google.
   Never ask the user for their Google password and never automate their browser for the login.

## Output contract

- stdout: JSON (\`--format pretty\` for humans, \`jsonl\` for lists, one line each).
- \`--error-format json\`: error wrapper { error: { code, category, reason, retryable, message, suggested_commands } }.
- Stable exit codes: 0 ok · 1 unexpected · 2 usage/validation/confirmation denied · 3 auth ·
  4 network · 5 not found · 6 the API rejected the operation · 7 contract drift (schema changed).
- \`reason: "auth_required"\` → nothing to retry; the user must log in.
- \`reason: "contract_drift"\` → don't reinvent the query; open an issue on the repo.

## Rules for operations with real effects

1. Nothing changes the account without confirmation: without a terminal, \`--yes\` is required. Pass \`--yes\` ONLY when
   the user asked for exactly that operation and saw the summary.
2. Use \`--dry-run\` on \`suggestion edit\` and \`orders cancel\` to show what would be sent, before asking for confirmation.
3. \`suggestion pause\` skips next week's delivery (the already-billed week is NOT touched).
   \`subscription pause --weeks N\` pauses the subscription for N weeks (temporary cancellation);
   \`subscription resume\` reactivates it.
4. \`orders cancel <id>\` cancels a confirmed order and refunds the amount. Ids: \`deliveries next\`
   (pending orders) and \`orders list\` (history).
5. Never manage payments: wetaca-cli does not touch cards or pending Redsys/PayPal payments.
   If \`nextPaymentPendingOrder\` is not null, tell the user and have them pay on wetaca.com.

## Commands

  wetaca auth login [--refresh-token COOKIE | --token T] | status | logout
  wetaca me                          summary: customer + subscription + wallet
  wetaca subscription show | pause [--weeks N] [--feedback S] | resume
  wetaca suggestion show             next week's menu per profile, prices, delivery window
  wetaca suggestion pause | resume   skip / reactivate next week
  wetaca suggestion edit --profile-suggestion ID --set "productId:qty,..." [--dry-run]
  wetaca deliveries next             suggestions and pending orders (ids for orders/cancel)
  wetaca orders list [--limit N] | show <id> | cancel <id> [--dry-run]
  wetaca menu list                    dishes of the week (ids for suggestion edit)
  wetaca dish show <slug>             details/ingredients of a dish
  wetaca deliveries options           delivery slots available for your zip code
  wetaca deliveries set-option <id> --dry-run   changes the slot (review and repeat with --yes)
  wetaca profiles list                your profiles and their menu
  wetaca profiles pause <id|name>     pauses a profile (dry-run first)
  wetaca addresses list
  wetaca addresses save --street C --number N [--floor F] --zipcode ZIP --city CITY --dry-run
     (review the plan; repeat with --yes; optional --notes --firstname --lastname --phone)
  wetaca addresses remove <id>        deletes an address not in use
  wetaca vouchers list
  wetaca vouchers current            voucher applied to next week (if any)
  wetaca vouchers apply <CODE>       apply a voucher to next week (--dry-run first, then --yes)
  wetaca vouchers skip               explicitly use no voucher next week
  wetaca giftcards show | redeem <CODE>   gift card limits / redeem into wallet
  wetaca wallet
  wetaca config path | list | get <k> | set <k> <v>
  wetaca doctor
  wetaca skills get wetaca-usage     this guide

## Typical flows

- "What's on this week?": \`wetaca suggestion show --format pretty\`
- "I don't want rice this week": \`suggestion show\` → locate the dish and its \`productSuggestionId\`
  (\`profileSuggestionId\`) and \`productId\` → \`suggestion edit --profile-suggestion ID --set "..." --dry-run\`
  → show the plan → confirm → run with \`--yes\`.
- "Vacation for two weeks": \`subscription pause --weeks 2\` (summary → --yes) and then \`subscription resume\`.
- "Cancel tomorrow's order": \`deliveries next\` → \`orders cancel <id>\`.
`;
