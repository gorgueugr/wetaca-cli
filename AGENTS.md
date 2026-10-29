# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, Hermes, OpenCode, Jules, ...) working in this repository — and a pointer for agents that help the *user* manage their Wetaca account with the installed CLI.

## Managing a Wetaca account with wetaca-cli

If your goal is to operate the user's Wetaca account (menu, subscription, deliveries, orders, vouchers), **do not read this repo's source first**. Run the embedded agent guide:

```
wetaca skills get wetaca-usage
```

That output is the canonical, version-matched contract: output formats, exit codes, command list, confirmation rules and typical flows. If `wetaca` is not installed: `npm install -g wetaca-cli`.

Non-negotiable rules when acting on a real account:

1. Reads (`suggestion show`, `orders list`, ...) are safe; run them freely.
2. Mutations require an explicit summary → confirmation. In non-interactive runs pass `--yes` ONLY when the user asked for that exact operation.
3. Prefer `--dry-run` before any mutation that supports it.
4. Never touch payments (the CLI cannot either).

## Working on this codebase

- Zero-dependency Node ESM (>=18). Do not add npm dependencies.
- Layout: `bin/wetaca.js` (arg parsing, dispatch, help), `src/lib.js` (config, GraphQL client, errors, output), `src/commands.js` (command implementations), `src/queries.js` (GraphQL operations), `src/guide.js` (embedded agent guide — single source for `docs/agent-guide.md`, regenerate with `node bin/wetaca.js skills get wetaca-usage > docs/agent-guide.md`).
- GraphQL reference operations live in `docs/api-operations/` (extracted from wetaca.com's production bundle; `extract-gql.mjs` re-extracts them).
- Contract: every command returns JSON on stdout (pretty/jsonl optional), errors as JSON on stderr with `--error-format json`, stable exit codes (0 ok, 1 unexpected, 2 usage, 3 auth, 4 network, 5 not found, 6 API, 7 contract drift). See `docs/cli-spec.md`.
- Mutations must follow the existing pattern: build payload → honor `--dry-run` → `confirm(flags, summary)` unless `--yes` → call `gql()`.
- After changing `src/guide.js`, regenerate `docs/agent-guide.md` (they must stay identical).
- Check syntax before committing: `node --check` on every touched file. CI runs the same checks plus smoke tests and cookie-parser tests.
- Releases: `npm version patch && git push --follow-tags`. The GitHub Actions `Publish to npm` workflow stages the package (`npm stage publish`, OIDC trusted publishing, no token); a maintainer approves it with `npm stage approve <id> --otp <code>`.
