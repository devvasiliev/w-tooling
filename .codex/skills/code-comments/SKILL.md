---
name: code-comments
description: Audit, add, or improve Russian code comments and docstrings in project repositories. Use when a task asks to cover code with comments, review their usefulness, standardize code documentation, or before moving a task with new functionality covered by project comment rules to Testing. For Python, use the bundled AST audit. Do not use for README, API reference, runbook, or product copy work.
---

# Code comments

Produce comments that let a junior developer understand the responsibility,
constraint, and non-obvious behavior without reconstructing them from the whole
call graph.

Use this skill after the work has been routed to one task. The skill does
not supply a task code, expand authorization, or replace repository checks.

## Required pre-Testing gate

Use this skill before moving a task to Testing whenever its implementation
adds or changes functionality covered by the project comment rules. This gate
applies even when the operator did not explicitly ask for comments.

Complete the whole workflow against every affected package or component. A
mechanical documentation check alone is insufficient: manually review the
changed functions and every reported candidate, correct weak documentation, and
run the affected repository checks. Move the task to Testing only after the
handoff records the inspected scope and verification result.

## Reader and quality bar

- Write comments and docstrings in Russian, in the present tense.
- Assume the reader knows Python but does not know the service's internal
  vocabulary. Keep a technical term only when it is part of the code or
  protocol, and explain the concrete effect or protected rule around it.
- Document public functions and methods. Also document large or non-obvious
  private functions whose responsibility cannot be recovered from the name.
- Put local comments next to the step whose reason matters: ordering,
  atomicity, concurrency, compatibility, security, fail-closed behavior,
  cleanup, or a significant side effect.
- Remove comments that only repeat a name, signature, assignment, or obvious
  control flow. Module documentation does not substitute for method
  documentation.

Reject formulations such as `Проверяет обязательное значение для supported
family.`. They name an implementation term but do not explain the rule. A useful
replacement is `Отклоняет событие, если сервис не умеет обрабатывать его версию
протокола.`

## Workflow

1. Read the relevant contracts, code, and tests before changing prose. A
   correct comment describes actual behavior and cannot invent a guarantee.
2. When Python code is in scope, run the bundled audit from the repository root:

   ```sh
   python3 <skill-directory>/scripts/audit_python_comments.py src/<package>
   ```

3. Read every existing docstring and ordinary comment in scope. Treat script
   findings as a navigation aid; usefulness and unexplained terminology require
   human review.
4. Rewrite weak documentation and add local comments only where the nuance is
   not already clear from names and structure.
5. Use the repository's existing structural documentation check when available.
   For Python, extend an existing AST architecture test when the repository has
   one. Check properties such as missing documentation, infinitive starts, and
   known empty templates. Do not freeze exact sentences in tests.
6. Regenerate OpenAPI or another derived contract when framework descriptions
   are built from docstrings.
7. Run the repository's full test entrypoint, conformance checks, and
   `git diff --check`.

## Handoff

Report the inspected scope, rewritten categories, comments added inside complex
functions, generated artifacts, and exact verification result. Distinguish
successful tests from environment-dependent skipped checks.
