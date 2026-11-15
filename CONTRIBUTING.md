# Contributing to JiveDrive

Contributions are welcome. The project's principles are set out in the
constitution in [CLAUDE.md](CLAUDE.md); the essentials are below.

## Before you start

For anything beyond a small fix, open an issue first to agree on the
approach. Security vulnerabilities are reported privately instead: see
[SECURITY.md](SECURITY.md).

## Development

Set up a local environment as described in [README.md](README.md#local-development).
The e2e server runs the app with an in-memory database and a mock S3 store,
so no OVHcloud account is needed.

## Expectations

- **Test first.** Every behaviour change starts with a failing test. A
  change is complete when its tests pass and the full suite is green.
- **Simplicity.** One container, one SQLite database, no ORM. New
  dependencies need a justification in the pull request.
- **Functional TypeScript.** No classes; plain functions over plain data.
  Every exported function has a JSDoc comment describing its contract.
- **Scope containment.** Every storage operation is scoped to the signed-in
  user's bucket and prefix (or a folder shared with them), enforced in the
  route layer and covered by tests.
- **Mobile-first UI.** UI changes must work at mobile, tablet and desktop
  widths.

## Quality gate

Run the full gate before pushing; CI runs the same checks:

```bash
bun run test
bun run typecheck
bun run lint
bun run format:check
bun run test:e2e
```

Run `bun run format` when the format check flags a file.

## License

JiveDrive is licensed under the [Apache License, Version 2.0](LICENSE). By
submitting a contribution, you agree that it is licensed under the same
terms, as set out in section 5 of the license.
