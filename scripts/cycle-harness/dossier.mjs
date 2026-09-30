import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  CycleHarnessError,
  listMarkdown,
  measuredDuration,
  roundMinutes,
  sha256,
  transitionTaskStatus,
  validateEventRecord,
} from "./core.mjs";
import { optionalLstat, readJson } from "./safe-files.mjs";

/**
 * Человекочитаемое представление досье. JSON records остаются доказательным
 * слоем; Markdown — канонический вход для человека при resume и review.
 */
export function renderContract(state) {
  const { task } = state;
  const revisionLine = state.contract_revision === undefined
    ? ""
    : `- Ревизия контракта: ${state.contract_revision}\n`;
  return `# ${task.taskId} — ${task.title}

## Классификация

${revisionLine}- Репозиторий: \`${task.repository}\`
- Класс: \`${task.class}\`
- Facets: ${task.facets.map((facet) => `\`${facet}\``).join(", ")}
- Происхождение начального контекста: ${task.provenance}

## Что считается хорошо выполненной задачей

${listMarkdown(task.quality_criteria)}

## В области задачи

${listMarkdown(task.scope)}

## Вне области задачи

${listMarkdown(task.non_goals)}

## Обязательные проверки

${listMarkdown(task.checks)}
`;
}

export function renderCurrent(state) {
  const current = state.current;
  const worktree = current.worktree;
  return `# Текущее состояние ${state.task.taskId}

- Обновлено: ${state.updated_at}
- Статус: ${state.status}
- Этап: ${current.phase}
- Последнее событие: ${current.last_summary}
- Текущий checkpoint: ${state.current_checkpoint ?? "не создан"}

## Ожидалось

${current.expected || "не указано"}

## Фактически

${current.actual || "не указано"}

## Следующий точный шаг

${current.next || "не указан"}

## Блокер

${current.blocker || "нет"}

## Rollback

${current.rollback || "не требуется"}

## Cleanup

${current.cleanup || "не требуется"}

## Рабочее дерево

${worktree ? `- HEAD: \`${worktree.head_sha}\`
- Состояние HEAD: ${worktree.head_state ? (worktree.head_state === "detached" ? "detached" : `ветка \`${worktree.branch}\``) : "не зафиксировано старым checkpoint"}
- Отпечаток: \`${worktree.fingerprint}\`
- Изменённые пути: ${worktree.changed_paths.length ? worktree.changed_paths.map((path) => `\`${path}\``).join(", ") : "нет"}` : "Checkpoint рабочего дерева ещё не создан."}
`;
}

export function renderEvent(event) {
  const lines = [
    `## ${event.occurred_at} · ${event.type} · ${event.summary}`,
    "",
    `- Этап: ${event.phase || "не указан"}`,
    `- Происхождение: ${event.provenance}`,
    `- Длительность: ${measuredDuration(event.duration_minutes)}`,
  ];
  if (event.expected) lines.push(`- Ожидалось: ${event.expected}`);
  if (event.actual) lines.push(`- Фактически: ${event.actual}`);
  if (event.impact) lines.push(`- Влияние: ${event.impact}`);
  if (event.result) lines.push(`- Результат: ${event.result}`);
  if (event.next) lines.push(`- Следующий шаг: ${event.next}`);
  if (event.blocker) lines.push(`- Блокер: ${event.blocker}`);
  if (event.rollback) lines.push(`- Rollback: ${event.rollback}`);
  if (event.cleanup) lines.push(`- Cleanup: ${event.cleanup}`);
  if (event.evidence.length) lines.push(`- Evidence: ${event.evidence.join("; ")}`);
  if (event.contract_amendment) {
    lines.push(`- Ревизия контракта: ${event.contract_amendment.revision}`);
    for (const [field, values] of Object.entries(event.contract_amendment.additions)) {
      if (values.length) lines.push(`- Добавлено в ${field}: ${values.join("; ")}`);
    }
    for (const [field, entries] of Object.entries(event.contract_amendment.removals ?? {})) {
      if (entries.length) lines.push(`- Удалено из ${field}: ${entries.map(({ value }) => value).join("; ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderInitialJournal(event) {
  return `# История выполнения

Здесь фиксируются только значимые события, решения, проверки и человеческие
корректировки. Сырые чаты, chain-of-thought, секреты и полные логи не сохраняются.

${renderEvent(event)}`;
}

export function renderEmptyReview(taskId) {
  return `# Разбор ${taskId}

Разбор ещё не выполнен. Он создаётся только явной командой после значимого
результата или обратной связи человека.
`;
}

export function renderCheckpoint({ checkpointNumber, state, event, worktree }) {
  return `# Checkpoint ${checkpointNumber} · ${state.task.taskId}

- Создан: ${event.occurred_at}
- Этап: ${event.phase}
- Происхождение: ${event.provenance}
- Длительность этапа: ${measuredDuration(event.duration_minutes)}

## Ожидалось

${event.expected || "не указано"}

## Фактически

${event.actual || "не указано"}

## Следующий точный шаг

${event.next || "не указан"}

## Блокер

${event.blocker || "нет"}

## Rollback

${event.rollback || "не требуется"}

## Cleanup

${event.cleanup || "не требуется"}

## Evidence

${listMarkdown(event.evidence)}

## Воспроизводимый снимок рабочего дерева

- HEAD: \`${worktree.head_sha}\`
- Состояние HEAD: ${worktree.head_state === "detached" ? "detached" : `ветка \`${worktree.branch}\``}
- Отпечаток: \`${worktree.fingerprint}\`
- Изменённые пути: ${worktree.changed_paths.length ? worktree.changed_paths.map((path) => `\`${path}\``).join(", ") : "нет"}

### Per-path fingerprints

${worktree.path_states.length ? worktree.path_states.map((item) => `- \`${item.path}\`: \`${sha256(canonicalJson(item))}\` (${item.status})`).join("\n") : "- рабочее дерево чистое"}

Отпечаток исключает только \`.project/task-runs/**\`; целостность самого досье
контролируется отдельным \`integrity.json\`.
`;
}

export function calculateMetrics(events) {
  const measured = events.filter((event) => event.duration_minutes !== null);
  const phaseDurations = events
    .filter((event) => event.type === "phase-finish")
    .map((event) => ({ phase: event.phase || "не указан", minutes: event.duration_minutes }));
  const blockerDurations = events
    .filter((event) => event.type === "blocker")
    .map((event) => ({ summary: event.summary, minutes: event.duration_minutes }));
  const handoffs = events.filter((event) => event.type === "handoff");
  return {
    events: events.length,
    measured_minutes: roundMinutes(measured.reduce((sum, event) => sum + event.duration_minutes, 0)),
    unmeasured_events: events.length - measured.length,
    failures: events.filter((event) => event.type === "failure").length,
    human_corrections: events.filter((event) => event.type === "human-correction").length,
    handoff_attempts: handoffs.length,
    accepted_handoffs: handoffs.filter((event) => event.result === "accepted").length,
    phase_durations: phaseDurations,
    blocker_durations: blockerDurations,
  };
}

export function renderReview({ state, outcome, summary, worked, failed, hypotheses, nextActions, metrics, reviewedAt }) {
  const durationRows = metrics.phase_durations.length
    ? metrics.phase_durations.map(({ phase, minutes }) => `- ${phase}: ${measuredDuration(minutes)}`).join("\n")
    : "- этапы не завершались или длительность не фиксировалась";
  const blockerRows = metrics.blocker_durations.length
    ? metrics.blocker_durations.map(({ summary: item, minutes }) => `- ${item}: ${measuredDuration(minutes)}`).join("\n")
    : "- блокеры не зафиксированы";
  return `# Разбор ${state.task.taskId}

- Выполнен: ${reviewedAt}
- Итог: ${outcome}
- Краткий вывод: ${summary}

## Метрики процесса

- Значимых событий: ${metrics.events}
- Измеренное время: ${measuredDuration(metrics.measured_minutes)}
- Событий без измерения: ${metrics.unmeasured_events}
- Сбоев: ${metrics.failures}
- Правок человека: ${metrics.human_corrections}
- Завершённых handoff-попыток: ${metrics.handoff_attempts}
- Принятых handoff-попыток: ${metrics.accepted_handoffs}

### Этапы

${durationRows}

### Блокеры

${blockerRows}

## Что сработало

${listMarkdown(worked)}

## Что не сработало или чего не хватало

${listMarkdown(failed)}

## Проверяемые гипотезы

${listMarkdown(hypotheses)}

## Следующие действия

${listMarkdown(nextActions)}

Этот разбор не меняет rules, skills или agents автоматически. Каждая гипотеза
сначала оформляется неизменяемым кандидатом и проверяется на другом задании того же пула.
`;
}

export async function readTaskEvents(taskRoot) {
  const directory = join(taskRoot, "events");
  const entries = await readdir(directory, { withFileTypes: true });
  const invalid = entries.find(
    (entry) => !entry.isFile() || !/^[0-9]{4}-[a-z-]+\.json$/u.test(entry.name),
  );
  if (invalid) {
    throw new CycleHarnessError({
      code: "INVALID_EVENT_ENTRY",
      stage: "dossier_validation",
      path: join(directory, invalid.name),
      message: `Event ledger содержит неподдерживаемую запись: ${invalid.name}.`,
      expected: "NNNN-event-type.json",
      actual: invalid.isFile() ? "unexpected filename" : "не-file entry",
      next: "Восстанови events/ из доверенного checkpoint или удали подложенную запись.",
    });
  }
  const names = entries.map((entry) => entry.name).sort();
  return Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);
      return validateEventRecord(await readJson(path, "event_load"), path);
    }),
  );
}

export async function validateTaskLedger(taskRoot, state) {
  const events = await readTaskEvents(taskRoot);
  if (events.length !== state.sequence) {
    throw new CycleHarnessError({
      code: "DOSSIER_STATE_MISMATCH",
      stage: "dossier_validation",
      path: join(taskRoot, "events"),
      message: "Число immutable events не совпадает с task state.",
      expected: String(state.sequence),
      actual: String(events.length),
      next: "Восстанови state.json и events/ из одной доверенной версии досье.",
    });
  }
  let lifecycle = "active";
  let activeBlocker = "";
  let previousTimestamp = "";
  let checkpoints = 0;
  const amendments = [];
  const strictBlockerFrom = state.migrations?.blocker_lifecycle_strict_from
    ?? Number.POSITIVE_INFINITY;
  const blockerMigrations = events.filter(
    (event) => event.type === "migration" && event.result === "blocker-lifecycle-v1",
  );
  if (
    strictBlockerFrom === 1
      ? blockerMigrations.length !== 0
      : Number.isFinite(strictBlockerFrom)
        ? blockerMigrations.length !== 1 || blockerMigrations[0].sequence !== strictBlockerFrom - 1
        : blockerMigrations.length !== 0
  ) {
    throw new CycleHarnessError({
      code: "DOSSIER_STATE_MISMATCH",
      stage: "dossier_validation",
      path: join(taskRoot, "state.json"),
      message: "Blocker lifecycle migration marker расходится с immutable ledger.",
      expected: strictBlockerFrom === 1
        ? "strict lifecycle с initialization без migration event"
        : Number.isFinite(strictBlockerFrom)
          ? `один migration event sequence ${strictBlockerFrom - 1}`
          : "legacy dossier без migration event",
      actual: blockerMigrations.map((event) => event.sequence).join(",") || "нет",
      next: "Выполни штатную blocker lifecycle migration или восстанови state/ledger из одной версии.",
    });
  }
  for (const [index, event] of events.entries()) {
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      throw new CycleHarnessError({
        code: "DOSSIER_STATE_MISMATCH",
        stage: "dossier_validation",
        path: join(taskRoot, "events"),
        message: "Event ledger содержит пропуск или повтор sequence.",
        expected: String(expectedSequence),
        actual: String(event.sequence),
        next: "Восстанови append-only events из доверенной копии.",
      });
    }
    if (index === 0 && event.type !== "initialization") {
      throw new CycleHarnessError({
        code: "DOSSIER_STATE_MISMATCH",
        stage: "dossier_validation",
        path: state.last_event,
        message: "Первый event досье должен быть initialization.",
        expected: "initialization",
        actual: event.type,
        next: "Восстанови исходный initialization event.",
      });
    }
    if (previousTimestamp && event.occurred_at < previousTimestamp) {
      throw new CycleHarnessError({
        code: "DOSSIER_STATE_MISMATCH",
        stage: "dossier_validation",
        path: state.last_event,
        message: "Event ledger нарушает хронологический порядок.",
        expected: `timestamp >= ${previousTimestamp}`,
        actual: event.occurred_at,
        next: "Создай новый event вместо изменения времени существующего record.",
      });
    }
    previousTimestamp = event.occurred_at;
    if (event.type === "checkpoint") checkpoints += 1;
    if (event.type === "contract-amendment") amendments.push(event.contract_amendment);
    const strictBlockerLifecycle = event.sequence >= strictBlockerFrom;
    if (event.type === "blocker") {
      if (strictBlockerLifecycle && (!event.blocker || activeBlocker)) {
        throw new CycleHarnessError({
          code: "DOSSIER_STATE_MISMATCH",
          stage: "dossier_validation",
          path: join(taskRoot, "events"),
          message: "Строгий blocker lifecycle содержит пустую причину или замену активного blocker.",
          expected: activeBlocker ? "blocker-resolved перед новым blocker" : "непустой blocker",
          actual: event.blocker || "пусто",
          next: "Восстанови append-only lifecycle из доверенной копии.",
        });
      }
      activeBlocker = event.blocker || event.summary;
    } else if (event.type === "blocker-resolved") {
      if (strictBlockerLifecycle && !activeBlocker) {
        throw new CycleHarnessError({
          code: "DOSSIER_STATE_MISMATCH",
          stage: "dossier_validation",
          path: join(taskRoot, "events"),
          message: "Строгий blocker lifecycle снимает отсутствующий blocker.",
          expected: "активный blocker",
          actual: "нет",
          next: "Восстанови append-only lifecycle из доверенной копии.",
        });
      }
      activeBlocker = "";
    } else if (event.type === "checkpoint") {
      if (strictBlockerLifecycle && event.blocker !== activeBlocker) {
        throw new CycleHarnessError({
          code: "DOSSIER_STATE_MISMATCH",
          stage: "dossier_validation",
          path: join(taskRoot, "checkpoints"),
          message: "Checkpoint не содержит effective активный blocker.",
          expected: activeBlocker || "пусто",
          actual: event.blocker || "пусто",
          next: "Восстанови checkpoint event из effective task state.",
        });
      }
      if (!strictBlockerLifecycle && event.blocker) activeBlocker = event.blocker;
    } else if (strictBlockerLifecycle && event.blocker) {
      throw new CycleHarnessError({
        code: "DOSSIER_STATE_MISMATCH",
        stage: "dossier_validation",
        path: join(taskRoot, "events"),
        message: "Blocker записан событием неподдерживаемого типа.",
        expected: "blocker event или effective checkpoint",
        actual: event.type,
        next: "Восстанови event ledger из доверенной копии.",
      });
    }
    lifecycle = transitionTaskStatus(
      lifecycle,
      event.type === "review" ? `review:${event.result}` : "event",
    );
  }
  const last = events.at(-1);
  const expectedLastEvent = `events/${String(last.sequence).padStart(4, "0")}-${last.type}.json`;
  const mismatches = [];
  if (state.created_at !== events[0].occurred_at) mismatches.push("created_at");
  if (state.updated_at !== last.occurred_at) mismatches.push("updated_at");
  if (state.last_event !== expectedLastEvent) mismatches.push("last_event");
  if (state.current.last_summary !== last.summary) mismatches.push("current.last_summary");
  if (state.current.phase !== last.phase) mismatches.push("current.phase");
  if (state.current.blocker !== activeBlocker) mismatches.push("current.blocker");
  if (state.status !== lifecycle) mismatches.push("status");
  if (state.checkpoint_sequence !== checkpoints) mismatches.push("checkpoint_sequence");
  if (mismatches.length) {
    throw new CycleHarnessError({
      code: "DOSSIER_STATE_MISMATCH",
      stage: "dossier_validation",
      path: join(taskRoot, "state.json"),
      message: `Mutable state расходится с immutable event ledger: ${mismatches.join(", ")}.`,
      expected: "state, восстановленный из events",
      actual: mismatches.join(", "),
      next: "Восстанови mutable summary из последнего проверенного event/checkpoint.",
      details: { mismatches },
    });
  }
  const expectedContractRevision = amendments.length + 1;
  if ((state.contract_revision ?? 1) !== expectedContractRevision) {
    throw new CycleHarnessError({
      code: "DOSSIER_STATE_MISMATCH",
      stage: "dossier_validation",
      path: join(taskRoot, "state.json"),
      message: "Contract revision расходится с immutable amendment events.",
      expected: String(expectedContractRevision),
      actual: String(state.contract_revision ?? 1),
      next: "Восстанови contract state и amendment events из одной версии.",
    });
  }
  let contractBeforeAmendments = structuredClone(state.task);
  for (const [reverseIndex, amendment] of [...amendments].reverse().entries()) {
    const expectedRevision = amendments.length + 1 - reverseIndex;
    if (
      amendment.revision !== expectedRevision
      || sha256(canonicalJson(contractBeforeAmendments)) !== amendment.after_digest
    ) {
      throw new CycleHarnessError({
        code: "DOSSIER_STATE_MISMATCH",
        stage: "dossier_validation",
        path: join(taskRoot, "events"),
        message: "Contract amendment chain имеет неверную revision или after digest.",
        expected: `revision ${expectedRevision}; after ${sha256(canonicalJson(contractBeforeAmendments))}`,
        actual: `revision ${amendment.revision}; after ${amendment.after_digest}`,
        next: "Восстанови immutable contract amendment chain.",
      });
    }
    for (const [field, additions] of Object.entries(amendment.additions)) {
      for (const value of additions) {
        const itemIndex = contractBeforeAmendments[field].indexOf(value);
        if (itemIndex === -1) {
          throw new CycleHarnessError({
            code: "DOSSIER_STATE_MISMATCH",
            stage: "dossier_validation",
            path: join(taskRoot, "events"),
            message: "Contract amendment addition отсутствует в итоговом task contract.",
            expected: value,
            actual: `missing in task.${field}`,
            next: "Восстанови state.task из immutable amendment chain.",
          });
        }
        contractBeforeAmendments[field].splice(itemIndex, 1);
      }
      if (field === "facets") contractBeforeAmendments[field].sort();
    }
    for (const [field, removals] of Object.entries(amendment.removals ?? {})) {
      for (const { value, index } of removals) {
        if (index > contractBeforeAmendments[field].length || contractBeforeAmendments[field].includes(value)) {
          throw new CycleHarnessError({
            code: "DOSSIER_STATE_MISMATCH",
            stage: "dossier_validation",
            path: join(taskRoot, "events"),
            message: "Contract amendment removal нельзя восстановить в исходной позиции.",
            expected: `${value} at task.${field}[${index}]`,
            actual: index > contractBeforeAmendments[field].length ? "index outside array" : "value already present",
            next: "Восстанови state.task из immutable amendment chain.",
          });
        }
        contractBeforeAmendments[field].splice(index, 0, value);
      }
      if (field === "facets") contractBeforeAmendments[field].sort();
    }
    const beforeDigest = sha256(canonicalJson(contractBeforeAmendments));
    if (beforeDigest !== amendment.before_digest) {
      throw new CycleHarnessError({
        code: "DOSSIER_STATE_MISMATCH",
        stage: "dossier_validation",
        path: join(taskRoot, "events"),
        message: "Contract amendment before digest не восстанавливается из delta.",
        expected: amendment.before_digest,
        actual: beforeDigest,
        next: "Восстанови immutable contract amendment chain.",
      });
    }
  }
  const contractPath = join(taskRoot, "contract.md");
  const expectedContract = renderContract(state);
  const actualContract = await readFile(contractPath, "utf8");
  if (actualContract !== expectedContract) {
    throw new CycleHarnessError({
      code: "DOSSIER_STATE_MISMATCH",
      stage: "dossier_validation",
      path: contractPath,
      message: "Human-readable contract расходится с machine state.",
      expected: sha256(expectedContract),
      actual: sha256(actualContract),
      next: "Восстанови contract.md штатным contract amendment workflow.",
    });
  }
  const checkpointRoot = join(taskRoot, "checkpoints");
  const checkpointMetadata = await optionalLstat(checkpointRoot);
  if (checkpointMetadata === null && checkpoints > 0) {
    throw new CycleHarnessError({
      code: "DOSSIER_STATE_MISMATCH",
      stage: "dossier_validation",
      path: checkpointRoot,
      message: "Checkpoint registry отсутствует при существующих checkpoint events.",
      expected: `${checkpoints} files NNNN-timestamp.md`,
      actual: "directory missing",
      next: "Восстанови checkpoints/ и events/ из одной доверенной версии досье.",
    });
  }
  if (checkpointMetadata !== null && !checkpointMetadata.isDirectory()) {
    throw new CycleHarnessError({
      code: "DOSSIER_STATE_MISMATCH",
      stage: "dossier_validation",
      path: checkpointRoot,
      message: "Checkpoint registry должен быть обычным каталогом.",
      expected: "directory",
      actual: checkpointMetadata.isSymbolicLink() ? "symbolic link" : "другой тип",
      next: "Восстанови checkpoints/ и events/ из одной доверенной версии досье.",
    });
  }
  const checkpointEntries = checkpointMetadata === null
    ? []
    : await readdir(checkpointRoot, { withFileTypes: true });
  const invalidCheckpoint = checkpointEntries.find(
    (entry) => !entry.isFile() || !/^[0-9]{4}-[0-9]{8}T[0-9]{9}Z\.md$/u.test(entry.name),
  );
  const checkpointNames = checkpointEntries.map((entry) => entry.name).sort();
  const sequenceMismatch = checkpointNames.find(
    (name, index) => Number(name.slice(0, 4)) !== index + 1,
  );
  const expectedCurrentCheckpoint = checkpointNames.length
    ? `checkpoints/${checkpointNames.at(-1)}`
    : null;
  if (
    invalidCheckpoint
    || sequenceMismatch
    || checkpointEntries.length !== checkpoints
    || state.current_checkpoint !== expectedCurrentCheckpoint
  ) {
    throw new CycleHarnessError({
      code: "DOSSIER_STATE_MISMATCH",
      stage: "dossier_validation",
      path: checkpointRoot,
      message: "Checkpoint registry расходится с checkpoint events.",
      expected: `${checkpoints} files NNNN-timestamp.md`,
      actual: invalidCheckpoint?.name
        ?? sequenceMismatch
        ?? state.current_checkpoint
        ?? String(checkpointEntries.length),
      next: "Восстанови checkpoints/ и events/ из одной доверенной версии досье.",
    });
  }
  return events;
}
