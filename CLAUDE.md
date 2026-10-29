# Wetaca CLI — codebase guidance

See AGENTS.md (same directory) for the full guidance. Key points:

- Zero-dependency Node ESM (>= 18). Never add npm dependencies.
- Commands: `bin/wetaca.js` (dispatch) → `src/commands.js` (implementations) → `src/lib.js` (config, GraphQL client, errors) → `src/queries.js` (GraphQL operations).
- Every command: JSON stdout by default, stable exit codes, `--dry-run` → `confirm()` → mutation.
- After editing `src/guide.js`, regenerate `docs/agent-guide.md`:
  `node bin/wetaca.js skills get wetaca-usage > docs/agent-guide.md`
- Check syntax of every touched file before committing (`node --check`).
- Releases: `npm version patch && git push --follow-tags` (CI + staged publish; a maintainer approves the stage).
