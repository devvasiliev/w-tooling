#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CycleHarness, CycleHarnessError } from "./cycle-harness-lib.mjs";

const currentFile = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = undefined;
const REPEATABLE_OPTIONS = new Set([
  "facet",
  "quality",
  "scope",
  "non-goal",
  "check",
  "remove-facet",
  "remove-quality",
  "remove-scope",
  "remove-non-goal",
  "remove-check",
  "evidence",
  "worked",
  "failed",
  "hypothesis",
  "next-action",
]);
const KNOWN_OPTIONS = new Set([
  ...REPEATABLE_OPTIONS,
  "json",
  "repo",
  "title",
  "class",
  "provenance",
  "type",
  "summary",
  "phase",
  "duration-minutes",
  "expected",
  "actual",
  "impact",
  "result",
  "next",
  "blocker",
  "rollback",
  "cleanup",
  "stage",
  "outcome",
  "candidate",
  "baseline",
  "candidate-ref",
  "scenario",
  "scenario-id",
  "run-key",
  "decision-id",
  "decision",
]);

function usage() {
  return `Cycle optimizer CLI

Task dossier:
  npm run task:cycle -- task init CODE-N --repo <name> --title <text> --class <class> --facet <slug> --quality <criterion>
  npm run task:cycle -- task amend CODE-N --repo <name> --summary <text> [--quality|--remove-quality|--scope|--remove-scope|--facet|--remove-facet ...]
  npm run task:cycle -- task migrate-blockers CODE-N --repo <name>
  npm run task:cycle -- task event CODE-N --repo <name> --type <type> --summary <text> [options]
  npm run task:cycle -- task checkpoint CODE-N --repo <name> --stage <text> --expected <text> --actual <text> --next <text>
  npm run task:cycle -- task resume CODE-N --repo <name>
  npm run task:cycle -- task review CODE-N --repo <name> --outcome <accepted|partial|rejected> --summary <text>

Harness experiments:
  npm run task:cycle -- experiment create CODE-N --repo <name> --candidate <manifest.json> [--baseline <sha>]
  npm run task:cycle -- experiment record CODE-N --repo <name> --candidate-ref <ref> --scenario <kind> --scenario-id <id> --run-key <key> --result <pass|fail|inconclusive> --summary <text>
  npm run task:cycle -- experiment decision CODE-N --repo <name> --candidate-ref <ref> --decision-id <id> --decision <approved|rejected> --summary <text>
  npm run task:cycle -- experiment status <candidate-ref>
  npm run task:cycle -- experiment list [--class <class>] [--facet <slug>]

Общий машинный режим: --json
`;
}

function parseOptions(args) {
  const options = new Map();
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!KNOWN_OPTIONS.has(name)) {
      throw new CycleHarnessError({
        code: "UNKNOWN_OPTION",
        stage: "cli_parse",
        path: token,
        message: `Неизвестный параметр: ${token}.`,
        expected: "документированный CLI parameter",
        actual: token,
        next: "Проверь написание по npm run task:cycle -- --help.",
      });
    }
    if (name === "json") {
      options.set(name, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CycleHarnessError({
        code: "MISSING_OPTION_VALUE",
        stage: "cli_parse",
        path: token,
        message: `Параметр ${token} требует значение.`,
        expected: `${token} <value>`,
        actual: value ?? "конец команды",
        next: "Передай значение параметра и повтори команду.",
      });
    }
    index += 1;
    if (REPEATABLE_OPTIONS.has(name)) {
      options.set(name, [...(options.get(name) ?? []), value]);
    } else if (options.has(name)) {
      throw new CycleHarnessError({
        code: "DUPLICATE_OPTION",
        stage: "cli_parse",
        path: token,
        message: `Параметр ${token} передан больше одного раза.`,
        expected: "одно значение",
        actual: "несколько значений",
        next: "Оставь одно значение или используй документированный повторяемый параметр.",
      });
    } else {
      options.set(name, value);
    }
  }
  return { options, positionals };
}

function option(options, name, { required = false, fallback } = {}) {
  const value = options.get(name) ?? fallback;
  if (required && (value === undefined || value === "")) {
    throw new CycleHarnessError({
      code: "MISSING_OPTION",
      stage: "cli_parse",
      path: `--${name}`,
      message: `Обязательный параметр --${name} не передан.`,
      expected: `--${name} <value>`,
      actual: "missing",
      next: "Добавь обязательный параметр и повтори команду.",
    });
  }
  return value;
}

function assertOnlyOptions(options, allowed) {
  const accepted = new Set(["json", ...allowed]);
  const unused = [...options.keys()].find((name) => !accepted.has(name));
  if (unused) {
    throw new CycleHarnessError({
      code: "UNUSED_OPTION",
      stage: "cli_parse",
      path: `--${unused}`,
      message: `Команда не использует параметр --${unused}.`,
      expected: [...accepted].map((name) => `--${name}`).join(", "),
      actual: `--${unused}`,
      next: "Удали параметр или выбери команду, которой он принадлежит.",
    });
  }
}

function onePositional(positionals, label) {
  if (positionals.length !== 1) {
    throw new CycleHarnessError({
      code: "INVALID_POSITIONAL_ARGUMENTS",
      stage: "cli_parse",
      path: label,
      message: `Команда ожидает ровно один аргумент ${label}.`,
      expected: `1 аргумент ${label}`,
      actual: `${positionals.length} аргументов`,
      next: "Исправь команду по выводу --help.",
    });
  }
  return positionals[0];
}

function noPositionals(positionals) {
  if (positionals.length !== 0) {
    throw new CycleHarnessError({
      code: "INVALID_POSITIONAL_ARGUMENTS",
      stage: "cli_parse",
      path: positionals.join(" "),
      message: "Команда не принимает positional arguments.",
      expected: "0 аргументов",
      actual: `${positionals.length} аргументов`,
      next: "Удали лишние аргументы и повтори команду.",
    });
  }
}

function eventInput(options) {
  return {
    repository: option(options, "repo", { required: true }),
    type: option(options, "type", { required: true }),
    summary: option(options, "summary", { required: true }),
    phase: option(options, "phase"),
    provenance: option(options, "provenance", { fallback: "observed" }),
    durationMinutes: option(options, "duration-minutes"),
    expected: option(options, "expected"),
    actual: option(options, "actual"),
    impact: option(options, "impact"),
    result: option(options, "result"),
    next: option(options, "next"),
    blocker: option(options, "blocker"),
    rollback: option(options, "rollback"),
    cleanup: option(options, "cleanup"),
    evidence: option(options, "evidence", { fallback: [] }),
  };
}

function renderResume(result) {
  const divergence = result.divergence;
  const drift = result.drift === null
    ? result.current_checkpoint
      ? "старый checkpoint не содержит совместимого per-path snapshot"
      : "нет checkpoint для сравнения"
    : result.drift ? "обнаружен" : "не обнаружен";
  return `${result.current_markdown.trimEnd()}

## Проверка продолжения

- Целостность досье: \`${result.integrity.digest}\`
- Текущий HEAD: \`${result.worktree.head_sha}\`
- Текущее состояние HEAD: ${result.worktree.head_state === "detached" ? "detached" : `ветка \`${result.worktree.branch}\``}
- Текущий отпечаток: \`${result.worktree.fingerprint}\`
- Drift после checkpoint: ${drift}
- HEAD изменён после checkpoint: ${divergence.head_changed ? "да" : "нет"}
- Ветка/detached state изменены: ${divergence.branch_changed ? "да" : "нет"}
- Добавлено после checkpoint: ${divergence.added.length ? divergence.added.join(", ") : "нет"}
- Удалено после checkpoint: ${divergence.removed.length ? divergence.removed.join(", ") : "нет"}
- Изменено после checkpoint: ${divergence.changed.length ? divergence.changed.join(", ") : "нет"}
- Per-path локализация: ${divergence.localization_available ? "доступна" : "недоступна для старого checkpoint"}
`;
}

function renderCandidateStatus(result) {
  const gateLines = Object.entries(result.gates)
    .map(([name, passed]) => `- ${name}: ${passed ? "пройден" : "не пройден"}`)
    .join("\n");
  const candidate = result.candidate;
  const evidenceLines = result.evidence.length
    ? result.evidence.map((item) => {
        const references = item.references.length ? item.references.join(", ") : "нет";
        const worktrees = item.target_worktree
          ? ` · target diff ${item.target_worktree.tracked_diff_sha256}: ${item.target_worktree.changed_paths.join(", ") || "clean"}`
            + ` · task diff ${item.task_worktree.tracked_diff_sha256}: ${item.task_worktree.changed_paths.join(", ") || "clean"}`
            + ` · checkout diff ${item.verification_worktree.tracked_diff_sha256}: ${item.verification_worktree.changed_paths.join(", ") || "clean"}`
          : "";
        return `- ${item.kind}/${item.scenario ?? "decision"}: ${item.result} · ${item.owner.repository}/${item.owner.taskId} · ${item.summary} · ${item.identity}${worktrees} · refs: ${references}`;
      }).join("\n")
    : "- evidence ещё не записан";
  return `Кандидат: ${candidate.candidate_ref}
Название: ${candidate.title}
Гипотеза: ${candidate.identity.hypothesis}
Source: ${candidate.source.repository}/${candidate.source.taskId}
Target: ${candidate.identity.target.repository}@${candidate.identity.target.baseline_sha}
Пул: ${candidate.identity.task_class}; facets=${candidate.identity.facets.join(", ")}
Variant: ${candidate.variant_fingerprint}
Technical evidence digest: ${result.technical_evidence_digest}
Статус: ${result.status}
Evidence records: ${result.evidence_count}
Следующий gate: ${result.status === "failed" || result.status === "rejected" ? "не применим: кандидат terminal" : result.next_unmet_gate ?? "все gates закрыты"}
Следующий шаг: ${result.next_action}

Gates:
${gateLines}

Failures: ${result.failures.length}
Rejections: ${result.rejections.length}
Blockers: ${[...result.failures, ...result.rejections].length ? [...result.failures, ...result.rejections].join(", ") : "нет"}
Promotion: ${result.ready_for_promotion ? "можно рассматривать в отдельной задаче" : "запрещён"}

Evidence:
${evidenceLines}
`;
}

function renderError(error) {
  return `Ошибка [${error.code}]
Этап: ${error.stage}
Путь: ${error.path || "не указан"}
Ожидалось: ${error.expected || "не указано"}
Фактически: ${error.actual || error.message}
Следующий шаг: ${error.next || "устрани причину и повтори команду"}
`;
}

export async function runCycleCli(
  argv,
  {
    workspaceRoot = defaultWorkspaceRoot,
    repositories,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const [group, action, ...rest] = argv;
  if (!group || group === "--help" || group === "-h") {
    stdout.write(usage());
    return 0;
  }
  const { options, positionals } = parseOptions(rest);
  const json = options.get("json") === true;
  const harness = new CycleHarness({
    workspaceRoot,
    ...(repositories === undefined ? {} : { repositories }),
  });
  let result;

  if (group === "task" && action === "init") {
    assertOnlyOptions(options, ["repo", "title", "class", "facet", "quality", "scope", "non-goal", "check", "provenance"]);
    result = await harness.initTask({
      repository: option(options, "repo", { required: true }),
      taskId: onePositional(positionals, "CODE-N"),
      title: option(options, "title", { required: true }),
      taskClass: option(options, "class", { required: true }),
      facets: option(options, "facet", { fallback: [] }),
      qualityCriteria: option(options, "quality", { fallback: [] }),
      scope: option(options, "scope", { fallback: [] }),
      nonGoals: option(options, "non-goal", { fallback: [] }),
      checks: option(options, "check", { fallback: [] }),
      provenance: option(options, "provenance", { fallback: "observed" }),
    });
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : `Досье создано: ${result.taskRoot}\n`);
    return 0;
  }
  if (group === "task" && action === "event") {
    assertOnlyOptions(options, ["repo", "type", "summary", "phase", "provenance", "duration-minutes", "expected", "actual", "impact", "result", "next", "blocker", "rollback", "cleanup", "evidence"]);
    result = await harness.addTaskEvent({ ...eventInput(options), taskId: onePositional(positionals, "CODE-N") });
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : `Событие ${result.event.sequence} записано: ${result.event.summary}\n`);
    return 0;
  }
  if (group === "task" && action === "amend") {
    assertOnlyOptions(options, ["repo", "summary", "facet", "quality", "scope", "non-goal", "check", "remove-facet", "remove-quality", "remove-scope", "remove-non-goal", "remove-check", "provenance"]);
    result = await harness.amendTaskContract({
      repository: option(options, "repo", { required: true }),
      taskId: onePositional(positionals, "CODE-N"),
      summary: option(options, "summary", { required: true }),
      facets: option(options, "facet", { fallback: [] }),
      qualityCriteria: option(options, "quality", { fallback: [] }),
      scope: option(options, "scope", { fallback: [] }),
      nonGoals: option(options, "non-goal", { fallback: [] }),
      checks: option(options, "check", { fallback: [] }),
      removeFacets: option(options, "remove-facet", { fallback: [] }),
      removeQualityCriteria: option(options, "remove-quality", { fallback: [] }),
      removeScope: option(options, "remove-scope", { fallback: [] }),
      removeNonGoals: option(options, "remove-non-goal", { fallback: [] }),
      removeChecks: option(options, "remove-check", { fallback: [] }),
      provenance: option(options, "provenance", { fallback: "observed" }),
    });
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : `Контракт обновлён до revision ${result.amendment.revision}.\n`);
    return 0;
  }
  if (group === "task" && action === "migrate-blockers") {
    assertOnlyOptions(options, ["repo"]);
    result = await harness.migrateBlockerLifecycle({
      repository: option(options, "repo", { required: true }),
      taskId: onePositional(positionals, "CODE-N"),
    });
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : `Blocker lifecycle migration записана: strict from ${result.state.migrations.blocker_lifecycle_strict_from}.\n`);
    return 0;
  }
  if (group === "task" && action === "checkpoint") {
    assertOnlyOptions(options, ["repo", "stage", "expected", "actual", "next", "blocker", "rollback", "cleanup", "evidence", "provenance", "duration-minutes"]);
    result = await harness.checkpointTask({
      repository: option(options, "repo", { required: true }),
      taskId: onePositional(positionals, "CODE-N"),
      stage: option(options, "stage", { required: true }),
      expected: option(options, "expected", { required: true }),
      actual: option(options, "actual", { required: true }),
      next: option(options, "next", { required: true }),
      blocker: option(options, "blocker"),
      rollback: option(options, "rollback"),
      cleanup: option(options, "cleanup"),
      evidence: option(options, "evidence", { fallback: [] }),
      provenance: option(options, "provenance", { fallback: "observed" }),
      durationMinutes: option(options, "duration-minutes"),
    });
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : `Checkpoint создан: ${result.checkpointPath}\n`);
    return 0;
  }
  if (group === "task" && action === "resume") {
    assertOnlyOptions(options, ["repo"]);
    result = await harness.resumeTask({
      repository: option(options, "repo", { required: true }),
      taskId: onePositional(positionals, "CODE-N"),
    });
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : renderResume(result));
    return 0;
  }
  if (group === "task" && action === "review") {
    assertOnlyOptions(options, ["repo", "outcome", "summary", "worked", "failed", "hypothesis", "next-action"]);
    result = await harness.reviewTask({
      repository: option(options, "repo", { required: true }),
      taskId: onePositional(positionals, "CODE-N"),
      outcome: option(options, "outcome", { required: true }),
      summary: option(options, "summary", { required: true }),
      worked: option(options, "worked", { fallback: [] }),
      failed: option(options, "failed", { fallback: [] }),
      hypotheses: option(options, "hypothesis", { fallback: [] }),
      nextActions: option(options, "next-action", { fallback: [] }),
    });
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : result.review);
    return 0;
  }
  if (group === "experiment" && action === "create") {
    assertOnlyOptions(options, ["repo", "candidate", "baseline"]);
    result = await harness.createCandidate({
      repository: option(options, "repo", { required: true }),
      taskId: onePositional(positionals, "CODE-N"),
      manifestPath: option(options, "candidate", { required: true }),
      baselineSha: option(options, "baseline"),
    });
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : `Кандидат создан: ${result.candidate.candidate_ref}\n`);
    return 0;
  }
  if (group === "experiment" && action === "record") {
    assertOnlyOptions(options, ["repo", "candidate-ref", "scenario", "scenario-id", "run-key", "result", "summary", "evidence", "duration-minutes", "provenance"]);
    result = await harness.recordEvidence({
      repository: option(options, "repo", { required: true }),
      taskId: onePositional(positionals, "CODE-N"),
      candidateRef: option(options, "candidate-ref", { required: true }),
      scenario: option(options, "scenario", { required: true }),
      scenarioId: option(options, "scenario-id", { required: true }),
      runKey: option(options, "run-key", { required: true }),
      result: option(options, "result", { required: true }),
      summary: option(options, "summary", { required: true }),
      evidence: option(options, "evidence", { fallback: [] }),
      durationMinutes: option(options, "duration-minutes"),
      provenance: option(options, "provenance", { fallback: "observed" }),
    });
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : `Evidence записан локально: ${result.evidence.identity_digest}\n`);
    return 0;
  }
  if (group === "experiment" && action === "decision") {
    assertOnlyOptions(options, ["repo", "candidate-ref", "decision-id", "decision", "summary", "evidence", "provenance"]);
    result = await harness.recordDecision({
      repository: option(options, "repo", { required: true }),
      taskId: onePositional(positionals, "CODE-N"),
      candidateRef: option(options, "candidate-ref", { required: true }),
      decisionId: option(options, "decision-id", { required: true }),
      decision: option(options, "decision", { required: true }),
      summary: option(options, "summary", { required: true }),
      evidence: option(options, "evidence", { fallback: [] }),
      provenance: option(options, "provenance", { fallback: "observed" }),
    });
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : `Решение записано локально: ${result.decision.decision}\n`);
    return 0;
  }
  if (group === "experiment" && action === "status") {
    assertOnlyOptions(options, []);
    result = await harness.candidateStatus(onePositional(positionals, "candidate-ref"));
    stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : renderCandidateStatus(result));
    return 0;
  }
  if (group === "experiment" && action === "list") {
    assertOnlyOptions(options, ["class", "facet"]);
    noPositionals(positionals);
    result = await harness.listCandidates({
      taskClass: option(options, "class"),
      facets: option(options, "facet", { fallback: [] }),
    });
    if (json) stdout.write(JSON.stringify(result, null, 2) + "\n");
    else if (!result.length) stdout.write("Кандидаты не найдены.\n");
    else stdout.write(result.map(renderCandidateStatus).join("\n"));
    return 0;
  }

  throw new CycleHarnessError({
    code: "UNKNOWN_COMMAND",
    stage: "cli_parse",
    path: [group, action].filter(Boolean).join(" "),
    message: `Неизвестная команда: ${[group, action].filter(Boolean).join(" ")}.`,
    expected: "task <action> или experiment <action>",
    actual: [group, action].filter(Boolean).join(" "),
    next: "Запусти npm run task:cycle -- --help.",
  });
}

async function main(argv) {
  const json = argv.includes("--json");
  try {
    return await runCycleCli(argv);
  } catch (error) {
    const normalized = error instanceof CycleHarnessError
      ? error
      : new CycleHarnessError({
          code: "UNEXPECTED_ERROR",
          stage: "runtime",
          message: error.message,
          actual: error.stack ?? error.message,
          next: "Зафиксируй точку отказа и проверь входные данные/файловую систему.",
        });
    if (json) process.stderr.write(`${JSON.stringify(normalized, Object.getOwnPropertyNames(normalized), 2)}\n`);
    else process.stderr.write(renderError(normalized));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
