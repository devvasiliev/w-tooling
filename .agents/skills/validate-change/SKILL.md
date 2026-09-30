---
name: validate-change
description: Validate broad refactorings and architecture or ownership changes with an independent read-only agent before implementation and after every correction. Use when a task changes capability boundaries, shared DTO/test/persistence infrastructure, production ownership, several repositories, or when the operator explicitly asks for validator review. Do not use for a small local edit without architecture risk or an isolated documentation correction that does not change or clarify ownership, capability, architecture, release, or validation contracts.
---

# Change validation

Find architecture and integration defects while they are still cheap to fix.
Keep the main agent responsible for scope, implementation, checks, and the final
decision; the validator supplies independent evidence and never edits files.

Use this skill only after `$route-task` established the governing task code.
It does not expand the task, authorize writes, replace repository checks, or
turn historical OpenSpec text into the current ownership model.

## Build the acceptance matrix

Before implementation, record the following in concrete, testable terms:

- current requirement and capability owner, including current production state;
- changed repositories and the canonical source of every generated copy;
- intended locality boundary and the narrow shared coordination surface;
- public, persistence, migration, typing, test-double, release, and rollback
  contracts that must remain unchanged;
- relevant commands, stateful scenarios, and external checks that cannot run.

Read [the risk checklist](references/risk-checklist.md) and select every section
whose trigger matches the change. Omit an irrelevant probe explicitly; do not
silently replace a required real or stateful scenario with a mock.

## Run an independent plan review

When subagents are available, assign one read-only validator before the first
implementation write. Pass exactly one task code, the operator's requested
scope, the acceptance matrix, relevant repositories, and the base revision of
each repository.
Require the validator to inspect requirements, code, tests, and current
documentation independently. Do not disclose a preferred verdict or propose
specific fixes in the assignment.

Ask for findings classified as P0, P1, P2, or P3. Every finding must contain a
tight file/line location, reproduced or statically demonstrated evidence, the
violated contract, and the smallest safe correction. `APPROVED` means that no
P0-P3 finding remains; successful tests alone are not approval.

Do not begin implementation while a plan finding remains. Reproduce the
finding, correct the plan and acceptance matrix, and return them to the same
read-only validator. Repeat the plan review until it returns `APPROVED`, then
keep that validator for the final diff rounds.

If subagents are unavailable, perform the same matrix as a separate review pass
after clearing implementation assumptions from the working notes, but treat it
only as preliminary diagnostics. Do not issue `APPROVED` or complete the
required gate: report `independence unavailable` as a blocker until an
independent validator runs or the operator explicitly waives this gate.

## Validate the completed change

After implementation and normal repository checks:

1. Give the same validator the updated acceptance matrix, exact check results,
   and a complete working-tree view for every repository: `git status`, tracked
   diff against that repository's base, full contents of all untracked paths in
   scope, and base versions of deleted or renamed sources. Preserve read-only
   scope.
2. Reproduce each finding. Fix the cause in the canonical owner and rerun the
   smallest affected checks followed by the required full gates.
3. Send the corrected diff back to the same validator. Repeat until it returns
   `APPROVED` with no P0-P3 findings.
4. Inspect staged paths and their complete contents before commit so generated
   copies, unrelated files, and another task code cannot enter the change.

Do not weaken an acceptance criterion to obtain approval. A disputed finding
is resolved against the requirement, current runtime state, and executable
contract, with the disagreement recorded if evidence remains inconclusive.

## Handoff

Report the task code, reviewed repositories and base, selected risk sections,
validator rounds and findings, fixes made, exact successful checks, skipped
external/stateful checks, and the final verdict. Separate current ownership
from historical cutover material.
