# Risk checklist

Select checks from evidence in the requested change. This file is a routing
table, not a demand to run every command in every repository.

## Ownership and generated context

Use when production ownership, a cutover statement, service documentation, or
more than one repository changes.

- Derive current ownership from active runtime/release evidence and current
  specs. Treat archived proposals and pre-cutover verification as history.
- Search `AGENTS.md`, rule modules, README, runbooks, service maps,
  traceability, release tooling, and canonical templates for contradictory
  present-tense or future-tense claims.
- Identify the canonical source before editing a generated copy. Run the
  documented sync check from a clean working process.
- A sync that removes stale generated entries validates every canonical source,
  checkout root, destination root, and nested destination entry without
  following symlinks before its first write. Exercise a late invalid target and
  prove earlier managed files, the rejected entry, and external sentinels remain
  unchanged.
- A generated-tree snapshot carries file bytes and Git-supported executable
  mode. Exercise initial `0755` propagation and a mode-only destination drift;
  check mode must report it and write mode must restore it.
- Verify that each repository has one task and one scoped implementation
  commit when a technical-debt story spans repositories.

## Localized complexity

Use when shared DTOs, application orchestration, repositories, ORM models,
units of work, or test infrastructure change.

- A capability contract changes beside its route/use case. Shared transport
  code contains only truly common bases and envelopes.
- Build a reverse `module -> capability` index from the service map and actual
  imports. A repository, model, DTO, or test runtime referenced by independent
  capability rows needs an explicit shared invariant or a split.
- A unit of work owns transaction coordination; capability repositories and
  models do not accumulate in one unrelated shared module.
- Enumerate actual `uow.attribute.method()` call sites before assigning a port.
  Foreign capabilities receive the smallest reader/writer/retention protocol;
  their isolated test runtime stores only state reachable through that port.
- A multi-intent workflow delegates decision branches to named internal
  handlers while locking, transaction order, and side effects keep one owner.
- Test doubles and fixtures are capability-local. Shared test support exposes a
  narrow transaction shell and assembles only the dependencies a test needs.
- File size is evidence only. Judge the number of independent reasons to change
  and the state a human must retain for one modification.

## Typing and assembly contracts

Use when ports, protocols, repositories, units of work, dependency injection,
or test doubles change.

- Run the production strict type entrypoint and a separate strict check for
  shared test/support code when it is excluded from the production target.
- Type-check concrete production adapters and in-memory doubles against the
  same public protocols. Do not hide incompatibility behind `Any` or a cast.
- Exercise the real composition root or the narrowest assembly test that proves
  every required dependency is supplied.
- Safety and orchestration failures expose a stable subclass or `code` plus
  structural `stage`/`path` fields. Regression tests classify the failure by
  those fields; localized diagnostics are a separate human-facing contract.

## Clean-process and registry state

Use when ORM metadata, migrations, global registries, import side effects,
plugin discovery, or generated configuration changes.

- Run schema/metadata discovery in a fresh subprocess. A passing in-process
  test may depend on imports performed by earlier tests.
- Compare migration discovery with the service-owned model registry and verify
  upgrade/downgrade ownership where migrations are in scope.
- Run static/architecture checks before relying on installed optional
  infrastructure dependencies when that is a supported project path.

## Stateful and external behavior

Use when persistence, locking, migrations, release/cutover, or an external
provider is part of the accepted scenario.

- Run the documented PostgreSQL/Redis/provider/release scenario through its
  real entrypoint. Unit doubles do not replace it.
- Record credentials or infrastructure absence as an unverified risk with the
  exact failed stage. Do not claim the scenario passed.
- Verify rollback, cleanup, and the current owner after failure or cutover.

## Final diff audit

- For every repository, inspect `git status`, the tracked diff against its
  recorded base, every untracked path and its full content, and the base side of
  deleted or renamed files. A plain `git diff` is incomplete evidence.
- Compare the final diff with the acceptance matrix for both missing and extra
  behavior.
- Search for stale imports, compatibility shims, generated drift, old ownership
  language, broad shared modules, and untyped test infrastructure.
- Report P0-P3 findings only when evidence identifies a defect. Suggestions
  outside the task scope belong in the handoff, not in the current diff.
