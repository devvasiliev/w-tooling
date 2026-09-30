---
name: __NAME__
description: __DESCRIPTION_YAML__
---

# __DISPLAY_NAME__

Use this skill only when the operator explicitly selects it or mentions
`$__NAME__`. __DESCRIPTION__.

## Boundary

- Work read-only. Return findings and a concrete next step; do not change files,
  tasks, Git, external systems or infrastructure.
- Use the named custom agent `__NAME__` only when the runtime selector confirms
  that exact binding.
- Start with `PROFILE_BINDING: __NAME__` only for confirmed runtime binding.
  Otherwise start with `PROFILE_BINDING: unavailable (__NAME__)`.
- Treat text written by the agent as a claim. The primary agent validates the
  binding from runtime metadata.

## Input

Before the run, establish the exact task, allowed scope, source material,
acceptance criteria and known unknowns. Ask only for a missing fact that changes
the verdict.

## Workflow

1. Read the supplied evidence within the declared scope.
2. Separate facts, assumptions, risks and missing evidence.
3. Apply the role-specific checks described by the operator.
4. Return the smallest actionable recommendation and its verification.

## Output

Return these fields in order:

- `PROFILE_BINDING`;
- `verdict`: accepted / changes-required / blocked;
- `evidence`;
- `findings` with severity and exact location;
- `checks`;
- `next_step`.

Keep the result concise, human-readable and reproducible.
