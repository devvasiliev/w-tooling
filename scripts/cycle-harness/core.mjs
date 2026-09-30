import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Стабильные типы, schema-проверки и чистые преобразования cycle harness.
 * Модуль не выполняет I/O: одинаковый вход всегда даёт одинаковый результат.
 */
export const SCHEMA_VERSION = 1;
export const REGULAR_MODE = 0o644;
export const DOSSIER_ROOT = join(".project", "task-runs");
export const WORKTREE_EXCLUDES = [":(exclude).project/task-runs/**"];
export const TASK_CLASSES = new Set([
  "feature",
  "bugfix",
  "refactor",
  "tooling",
  "template",
  "migration",
  "research",
  "incident",
  "other",
]);
export const USER_EVENT_TYPES = new Set([
  "phase-start",
  "phase-finish",
  "milestone",
  "failure",
  "decision",
  "human-correction",
  "scope-change",
  "verification",
  "handoff",
  "blocker",
  "blocker-resolved",
  "cleanup",
  "resume",
]);
export const EVENT_TYPES = new Set([
  ...USER_EVENT_TYPES,
  "checkpoint",
  "review",
  "initialization",
  "contract-amendment",
  "migration",
]);
export const PROVENANCE_VALUES = new Set(["observed", "reconstructed"]);
export const HANDOFF_RESULTS = new Set(["accepted", "rejected", "incomplete"]);
export const EXPERIMENT_SCENARIOS = new Set(["replay", "regression", "negative", "fresh-task"]);
export const EXPERIMENT_RESULTS = new Set(["pass", "fail", "inconclusive"]);
export const DECISIONS = new Set(["approved", "rejected"]);
export const HARNESS_LAYERS = new Set(["task", "rules", "skills", "agents", "tooling"]);
export const OVERLAY_OPERATIONS = new Set(["add", "replace", "delete"]);
export const TASK_STATUSES = new Set(["active", "reviewed", "review-required"]);
const STATE_TRANSITIONS = Object.freeze({
  active: Object.freeze({ event: "active", "review:accepted": "reviewed", "review:partial": "review-required", "review:rejected": "review-required" }),
  reviewed: Object.freeze({ event: "active", "review:accepted": "reviewed", "review:partial": "review-required", "review:rejected": "review-required" }),
  "review-required": Object.freeze({ event: "active", "review:accepted": "reviewed", "review:partial": "review-required", "review:rejected": "review-required" }),
});

/** Ошибка cycle harness со стабильной классификацией и следующим действием. */
export class CycleHarnessError extends Error {
  constructor({ code, stage, path = "", message, expected = "", actual = "", next = "", details = {} }) {
    super(message);
    this.name = "CycleHarnessError";
    this.code = code;
    this.stage = stage;
    this.path = path;
    this.expected = expected;
    this.actual = actual;
    this.next = next;
    this.details = Object.freeze({ ...details });
  }
}

export function escapesRoot(root, target) {
  const path = relative(root, target);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

export function assertString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new CycleHarnessError({
      code: "INVALID_INPUT",
      stage: "input_validation",
      path: field,
      message: `Поле ${field} должно быть непустой строкой.`,
      expected: "непустая строка",
      actual: value === undefined ? "не передано" : typeof value,
      next: `Передай корректное значение ${field}.`,
    });
  }
  return value.trim();
}

export function assertEnum(value, field, allowed) {
  if (!allowed.has(value)) {
    throw new CycleHarnessError({
      code: "INVALID_INPUT",
      stage: "input_validation",
      path: field,
      message: `Поле ${field} содержит неподдерживаемое значение: ${value ?? "не передано"}.`,
      expected: [...allowed].join(" | "),
      actual: value ?? "не передано",
      next: `Выбери одно из значений: ${[...allowed].join(", ")}.`,
    });
  }
  return value;
}

export function assertTaskId(value) {
  const taskId = assertString(value, "taskId");
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(taskId)) {
    throw new CycleHarnessError({
      code: "INVALID_TASK_ID",
      stage: "input_validation",
      path: "taskId",
      message: `Некорректный код задачи: ${taskId}.`,
      expected: "CODE-N",
      actual: taskId,
      next: "Передай действующий код задачи в формате CODE-N.",
    });
  }
  return taskId;
}

export function assertSchema(record, path) {
  if (record?.schema_version !== SCHEMA_VERSION) {
    throw new CycleHarnessError({
      code: "UNSUPPORTED_SCHEMA",
      stage: "schema_validation",
      path,
      message: `Неподдерживаемая версия schema в ${path}.`,
      expected: String(SCHEMA_VERSION),
      actual: String(record?.schema_version ?? "missing"),
      next: "Используй документированную миграцию schema до продолжения записи.",
    });
  }
  return record;
}

export function schemaFailure(path, field, expected, actual) {
  throw new CycleHarnessError({
    code: "INVALID_SCHEMA",
    stage: "schema_validation",
    path: field ? `${path}#${field}` : path,
    message: `Record не соответствует schema: ${field || path}.`,
    expected,
    actual,
    next: "Восстанови record из доверенного checkpoint или выполни документированную миграцию.",
  });
}

export function schemaObject(record, path) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    schemaFailure(path, "", "object", Array.isArray(record) ? "array" : typeof record);
  }
  assertSchema(record, path);
  return record;
}

export function schemaNestedObject(record, field, path) {
  const value = record?.[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    schemaFailure(path, field, "object", Array.isArray(value) ? "array" : String(value === null ? "null" : typeof value));
  }
  return value;
}

export function schemaString(record, field, path, { empty = false } = {}) {
  const value = record?.[field];
  if (typeof value !== "string" || (!empty && value.length === 0)) {
    schemaFailure(path, field, empty ? "string" : "непустая строка", value === undefined ? "missing" : typeof value);
  }
  return value;
}

export function schemaStringArray(record, field, path) {
  const value = record?.[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    schemaFailure(path, field, "массив непустых строк", Array.isArray(value) ? "invalid array" : typeof value);
  }
  return value;
}

function schemaDigest(record, field, path) {
  const value = schemaString(record, field, path);
  if (!/^[a-f0-9]{64}$/u.test(value)) schemaFailure(path, field, "sha256 hex", value);
  return value;
}

function schemaGitObject(record, field, path) {
  const value = schemaString(record, field, path);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    schemaFailure(path, field, "Git object id (SHA-1 или SHA-256)", value);
  }
  return value;
}

function schemaIsoTimestamp(record, field, path) {
  const value = schemaString(record, field, path);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    schemaFailure(path, field, "UTC ISO-8601 timestamp", value);
  }
  return value;
}

function schemaPortablePath(value, path, field) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || value.startsWith("/")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    schemaFailure(path, field, "безопасный repository-relative POSIX path", String(value));
  }
  return value;
}

function assertSortedUnique(values, path, field) {
  if (new Set(values).size !== values.length) schemaFailure(path, field, "уникальные значения", "duplicates");
  const sorted = [...values].sort();
  if (canonicalJson(values) !== canonicalJson(sorted)) schemaFailure(path, field, "лексикографически отсортированный массив", "unsorted");
}

function validateWorkingPathState(working, path) {
  if (!working || typeof working !== "object" || Array.isArray(working)) {
    schemaFailure(path, "working", "object", working === null ? "null" : typeof working);
  }
  if (!new Set(["file", "directory", "missing", "symlink"]).has(working.type)) {
    schemaFailure(path, "working.type", "file|directory|missing|symlink", String(working.type));
  }
  if (working.type === "file") {
    if (!new Set(["100644", "100755"]).has(working.mode)) {
      schemaFailure(path, "working.mode", "100644|100755", String(working.mode));
    }
    schemaDigest(working, "sha256", path);
  }
  if (working.type === "symlink") schemaString(working, "target", path, { empty: true });
  return working;
}

export function validateWorktreeSchema(worktree, path) {
  if (!worktree || typeof worktree !== "object" || Array.isArray(worktree)) {
    schemaFailure(path, "worktree", "object", worktree === null ? "null" : typeof worktree);
  }
  schemaGitObject(worktree, "head_sha", path);
  schemaDigest(worktree, "fingerprint", path);
  const changedPaths = schemaStringArray(worktree, "changed_paths", path);
  changedPaths.forEach((value, index) => schemaPortablePath(value, path, `changed_paths[${index}]`));
  assertSortedUnique(changedPaths, path, "changed_paths");

  const legacySnapshot = worktree.head_state === undefined
    && worktree.branch === undefined
    && worktree.path_states === undefined
    && worktree.tracked_diff_sha256 === undefined;
  if (legacySnapshot) return worktree;

  if (!new Set(["branch", "detached"]).has(worktree.head_state)) {
    schemaFailure(path, "head_state", "branch|detached", String(worktree.head_state));
  }
  if (worktree.head_state === "branch") schemaString(worktree, "branch", path);
  else if (worktree.branch !== null) schemaFailure(path, "branch", "null при detached HEAD", String(worktree.branch));
  schemaDigest(worktree, "tracked_diff_sha256", path);
  if (!Array.isArray(worktree.path_states)) schemaFailure(path, "path_states", "array", typeof worktree.path_states);
  const pathStatePaths = [];
  for (const [index, item] of worktree.path_states.entries()) {
    const itemPath = `${path}#path_states[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) schemaFailure(itemPath, "", "object", typeof item);
    const itemName = schemaPortablePath(schemaString(item, "path", itemPath), itemPath, "path");
    pathStatePaths.push(itemName);
    if (!new Set(["tracked-change", "untracked"]).has(item.status)) {
      schemaFailure(itemPath, "status", "tracked-change|untracked", String(item.status));
    }
    validateWorkingPathState(item.working, itemPath);
    if (!Array.isArray(item.index)) schemaFailure(itemPath, "index", "array", typeof item.index);
    for (const [entryIndex, entry] of item.index.entries()) {
      const entryPath = `${itemPath}.index[${entryIndex}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) schemaFailure(entryPath, "", "object", typeof entry);
      if (!/^[0-7]{6}$/u.test(entry.mode ?? "")) schemaFailure(entryPath, "mode", "Git mode", String(entry.mode));
      schemaGitObject(entry, "object", entryPath);
      if (!Number.isInteger(entry.stage) || entry.stage < 0 || entry.stage > 3) {
        schemaFailure(entryPath, "stage", "integer 0..3", String(entry.stage));
      }
    }
    if (item.status === "untracked" && item.index.length !== 0) {
      schemaFailure(itemPath, "index", "пустой массив для untracked", String(item.index.length));
    }
  }
  assertSortedUnique(pathStatePaths, path, "path_states.path");
  if (canonicalJson(pathStatePaths) !== canonicalJson(changedPaths)) {
    schemaFailure(path, "path_states", "те же пути, что changed_paths", canonicalJson(pathStatePaths));
  }
  const expectedFingerprint = sha256(canonicalJson({
    head_sha: worktree.head_sha,
    head_state: worktree.head_state,
    branch: worktree.branch,
    tracked_diff_sha256: worktree.tracked_diff_sha256,
    path_states: worktree.path_states,
  }));
  if (worktree.fingerprint !== expectedFingerprint) {
    schemaFailure(path, "fingerprint", expectedFingerprint, worktree.fingerprint);
  }
  return worktree;
}

export function validateStateRecord(record, path) {
  schemaObject(record, path);
  schemaNestedObject(record, "task", path);
  for (const field of ["repository", "taskId", "title", "class", "provenance"]) {
    schemaString(record.task, field, `${path}#task`);
  }
  if (!TASK_CLASSES.has(record.task.class)) schemaFailure(path, "task.class", [...TASK_CLASSES].join("|"), record.task.class);
  if (!PROVENANCE_VALUES.has(record.task.provenance)) schemaFailure(path, "task.provenance", [...PROVENANCE_VALUES].join("|"), record.task.provenance);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.task.repository)) schemaFailure(path, "task.repository", "lower-kebab-case", record.task.repository);
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(record.task.taskId)) schemaFailure(path, "task.taskId", "CODE-N", record.task.taskId);
  for (const field of ["facets", "quality_criteria", "scope", "non_goals", "checks"]) {
    schemaStringArray(record.task, field, `${path}#task`);
  }
  if (record.task.facets.length === 0) schemaFailure(path, "task.facets", "непустой массив", "empty");
  if (record.task.quality_criteria.length === 0) schemaFailure(path, "task.quality_criteria", "непустой массив", "empty");
  record.task.facets.forEach((facet, index) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(facet)) schemaFailure(path, `task.facets[${index}]`, "lower-kebab-case", facet);
  });
  assertSortedUnique(record.task.facets, path, "task.facets");
  if (!TASK_STATUSES.has(record.status)) schemaFailure(path, "status", [...TASK_STATUSES].join("|"), String(record.status));
  for (const field of ["created_at", "updated_at"]) schemaIsoTimestamp(record, field, path);
  schemaPortablePath(schemaString(record, "last_event", path), path, "last_event");
  for (const field of ["sequence", "checkpoint_sequence"]) {
    if (!Number.isInteger(record[field]) || record[field] < 0) schemaFailure(path, field, "integer >= 0", String(record[field]));
  }
  if (
    record.contract_revision !== undefined
    && (!Number.isInteger(record.contract_revision) || record.contract_revision < 1)
  ) {
    schemaFailure(path, "contract_revision", "integer >= 1", String(record.contract_revision));
  }
  if (record.migrations !== undefined) {
    if (!record.migrations || typeof record.migrations !== "object" || Array.isArray(record.migrations)) {
      schemaFailure(path, "migrations", "object", String(record.migrations === null ? "null" : typeof record.migrations));
    }
    if (
      !Number.isInteger(record.migrations.blocker_lifecycle_strict_from)
      || record.migrations.blocker_lifecycle_strict_from < 1
      || record.migrations.blocker_lifecycle_strict_from > record.sequence + 1
    ) {
      schemaFailure(
        path,
        "migrations.blocker_lifecycle_strict_from",
        `integer 1..${record.sequence + 1}`,
        String(record.migrations.blocker_lifecycle_strict_from),
      );
    }
  }
  if (record.sequence < 1) schemaFailure(path, "sequence", "integer >= 1", String(record.sequence));
  if (record.checkpoint_sequence > record.sequence) schemaFailure(path, "checkpoint_sequence", "<= sequence", String(record.checkpoint_sequence));
  const eventPrefix = `events/${String(record.sequence).padStart(4, "0")}-`;
  if (!record.last_event.startsWith(eventPrefix) || !record.last_event.endsWith(".json")) {
    schemaFailure(path, "last_event", `path последнего event с prefix ${eventPrefix}`, record.last_event);
  }
  if (record.current_checkpoint !== null && typeof record.current_checkpoint !== "string") {
    schemaFailure(path, "current_checkpoint", "string|null", typeof record.current_checkpoint);
  }
  if (record.checkpoint_sequence === 0 && record.current_checkpoint !== null) {
    schemaFailure(path, "current_checkpoint", "null до первого checkpoint", String(record.current_checkpoint));
  }
  if (record.checkpoint_sequence > 0) {
    schemaPortablePath(record.current_checkpoint, path, "current_checkpoint");
    const checkpointPrefix = `checkpoints/${String(record.checkpoint_sequence).padStart(4, "0")}-`;
    if (!record.current_checkpoint.startsWith(checkpointPrefix) || !record.current_checkpoint.endsWith(".md")) {
      schemaFailure(path, "current_checkpoint", `path checkpoint с prefix ${checkpointPrefix}`, record.current_checkpoint);
    }
  }
  schemaNestedObject(record, "current", path);
  for (const field of ["phase", "last_summary", "expected", "actual", "next", "blocker", "rollback", "cleanup"]) {
    schemaString(record.current, field, `${path}#current`, { empty: true });
  }
  if (record.current.worktree !== null && record.current.worktree !== undefined) {
    validateWorktreeSchema(record.current.worktree, `${path}#current.worktree`);
  }
  return record;
}

export function validateIntegrityRecord(record, path) {
  schemaObject(record, path);
  if (record.algorithm !== "sha256") schemaFailure(path, "algorithm", "sha256", String(record.algorithm));
  schemaDigest(record, "digest", path);
  if (!Array.isArray(record.files)) schemaFailure(path, "files", "array", typeof record.files);
  for (const [index, file] of record.files.entries()) {
    if (!file || typeof file !== "object" || Array.isArray(file)) schemaFailure(path, `files[${index}]`, "object", typeof file);
    schemaPortablePath(schemaString(file, "path", `${path}#files[${index}]`), path, `files[${index}].path`);
    schemaDigest(file, "sha256", `${path}#files[${index}]`);
    if (typeof file.executable !== "boolean") schemaFailure(path, `files[${index}].executable`, "boolean", typeof file.executable);
  }
  const paths = record.files.map((file) => file.path);
  assertSortedUnique(paths, path, "files.path");
  const expectedDigest = sha256(canonicalJson(record.files));
  if (record.digest !== expectedDigest) schemaFailure(path, "digest", expectedDigest, record.digest);
  return record;
}

export function validateEventRecord(record, path) {
  schemaObject(record, path);
  if (!Number.isInteger(record.sequence) || record.sequence < 1) schemaFailure(path, "sequence", "integer >= 1", String(record.sequence));
  schemaIsoTimestamp(record, "occurred_at", path);
  for (const field of ["type", "summary", "phase", "provenance", "expected", "actual", "impact", "result", "next", "blocker", "rollback", "cleanup"]) {
    schemaString(record, field, path, { empty: !new Set(["occurred_at", "type", "summary", "phase", "provenance"]).has(field) });
  }
  if (!EVENT_TYPES.has(record.type)) schemaFailure(path, "type", [...EVENT_TYPES].join("|"), record.type);
  if (!PROVENANCE_VALUES.has(record.provenance)) schemaFailure(path, "provenance", [...PROVENANCE_VALUES].join("|"), record.provenance);
  if (record.duration_minutes !== null && (!Number.isFinite(record.duration_minutes) || record.duration_minutes < 0)) {
    schemaFailure(path, "duration_minutes", "number >= 0|null", String(record.duration_minutes));
  }
  schemaStringArray(record, "evidence", path);
  const eventMatch = /(?:^|[/\\])events[/\\](?<sequence>[0-9]{4})-(?<type>[a-z-]+)\.json$/u.exec(path);
  if (eventMatch && (Number(eventMatch.groups.sequence) !== record.sequence || eventMatch.groups.type !== record.type)) {
    schemaFailure(path, "filename", `${String(record.sequence).padStart(4, "0")}-${record.type}.json`, path);
  }
  if (record.type === "handoff" && !HANDOFF_RESULTS.has(record.result)) {
    schemaFailure(path, "result", [...HANDOFF_RESULTS].join("|"), record.result);
  }
  if (record.type === "review" && !new Set(["accepted", "partial", "rejected"]).has(record.result)) {
    schemaFailure(path, "result", "accepted|partial|rejected", record.result);
  }
  if (record.type === "migration" && record.result !== "blocker-lifecycle-v1") {
    schemaFailure(path, "result", "blocker-lifecycle-v1", record.result);
  }
  if (record.type === "contract-amendment") {
    const amendment = record.contract_amendment;
    if (!amendment || typeof amendment !== "object" || Array.isArray(amendment)) {
      schemaFailure(path, "contract_amendment", "object", String(amendment === null ? "null" : typeof amendment));
    }
    if (!Number.isInteger(amendment.revision) || amendment.revision < 2) {
      schemaFailure(path, "contract_amendment.revision", "integer >= 2", String(amendment.revision));
    }
    for (const field of ["before_digest", "after_digest"]) schemaDigest(amendment, field, `${path}#contract_amendment`);
    const additions = amendment.additions;
    if (!additions || typeof additions !== "object" || Array.isArray(additions)) {
      schemaFailure(path, "contract_amendment.additions", "object", String(additions === null ? "null" : typeof additions));
    }
    const contractFields = ["facets", "quality_criteria", "scope", "non_goals", "checks"];
    let additionCount = 0;
    for (const field of contractFields) {
      const values = schemaStringArray(additions, field, `${path}#contract_amendment.additions`);
      additionCount += values.length;
      if (field === "facets") {
        values.forEach((facet, index) => {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(facet)) {
            schemaFailure(path, `contract_amendment.additions.facets[${index}]`, "lower-kebab-case", facet);
          }
        });
        assertSortedUnique(values, path, "contract_amendment.additions.facets");
      }
    }
    const removals = amendment.removals;
    let removalCount = 0;
    if (removals !== undefined) {
      if (!removals || typeof removals !== "object" || Array.isArray(removals)) {
        schemaFailure(path, "contract_amendment.removals", "object", String(removals === null ? "null" : typeof removals));
      }
      for (const field of contractFields) {
        const entries = removals[field];
        if (!Array.isArray(entries)) {
          schemaFailure(path, `contract_amendment.removals.${field}`, "array", typeof entries);
        }
        const values = [];
        const indexes = [];
        entries.forEach((entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            schemaFailure(path, `contract_amendment.removals.${field}[${index}]`, "object", entry === null ? "null" : typeof entry);
          }
          if (typeof entry.value !== "string" || entry.value.length === 0) {
            schemaFailure(path, `contract_amendment.removals.${field}[${index}].value`, "непустая строка", typeof entry.value);
          }
          if (!Number.isInteger(entry.index) || entry.index < 0) {
            schemaFailure(path, `contract_amendment.removals.${field}[${index}].index`, "integer >= 0", String(entry.index));
          }
          if (field === "facets" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.value)) {
            schemaFailure(path, `contract_amendment.removals.facets[${index}].value`, "lower-kebab-case", entry.value);
          }
          values.push(entry.value);
          indexes.push(entry.index);
        });
        if (new Set(values).size !== values.length) {
          schemaFailure(path, `contract_amendment.removals.${field}`, "уникальные значения", "duplicates");
        }
        if (new Set(indexes).size !== indexes.length) {
          schemaFailure(path, `contract_amendment.removals.${field}`, "уникальные indexes", "duplicates");
        }
        if (canonicalJson(indexes) !== canonicalJson([...indexes].sort((left, right) => left - right))) {
          schemaFailure(path, `contract_amendment.removals.${field}`, "entries по возрастанию index", "unsorted");
        }
        const conflicts = values.filter((value) => additions[field].includes(value));
        if (conflicts.length) {
          schemaFailure(path, `contract_amendment.removals.${field}`, "непересекающиеся additions/removals", conflicts.join("; "));
        }
        removalCount += entries.length;
      }
    }
    if (additionCount + removalCount === 0) {
      schemaFailure(path, "contract_amendment", "хотя бы одно добавление или удаление", "empty");
    }
  } else if (record.contract_amendment !== undefined && record.contract_amendment !== null) {
    schemaFailure(path, "contract_amendment", "поле только для contract-amendment", record.type);
  }
  return record;
}

export function transitionTaskStatus(currentStatus, trigger) {
  const nextStatus = STATE_TRANSITIONS[currentStatus]?.[trigger];
  if (!nextStatus) {
    throw new CycleHarnessError({
      code: "INVALID_STATE_TRANSITION",
      stage: "task_transition",
      path: currentStatus ?? "missing",
      message: `Недопустимый переход task lifecycle: ${currentStatus ?? "missing"} -> ${trigger}.`,
      expected: Object.keys(STATE_TRANSITIONS[currentStatus] ?? {}).join(" | ") || "known status",
      actual: trigger,
      next: "Восстанови state.json или используй допустимую task-команду.",
    });
  }
  return nextStatus;
}

/**
 * Проверяет следующее событие до любой записи в dossier. Повторная проверка
 * непосредственно перед append защищает внутренние вызовы фасада от обхода
 * buildEvent.
 */
export function preflightEventMutation(state, event, path = "pending-event") {
  validateEventRecord(event, path);
  const expectedSequence = state.sequence + 1;
  if (event.sequence !== expectedSequence) {
    throw new CycleHarnessError({
      code: "EVENT_SEQUENCE_CONFLICT",
      stage: "event_preflight",
      path,
      message: "Следующее событие не продолжает текущий sequence dossier.",
      expected: String(expectedSequence),
      actual: String(event.sequence),
      next: "Повтори mutation после актуального task resume.",
    });
  }
  if (event.occurred_at < state.updated_at) {
    throw new CycleHarnessError({
      code: "EVENT_TIME_REGRESSION",
      stage: "event_preflight",
      path,
      message: "Время нового события предшествует последнему событию dossier.",
      expected: `timestamp >= ${state.updated_at}`,
      actual: event.occurred_at,
      next: "Исправь системные часы или передай монотонный clock и повтори mutation.",
    });
  }
  if (event.type === "blocker" && !event.blocker) {
    throw new CycleHarnessError({
      code: "BLOCKER_REASON_REQUIRED",
      stage: "event_preflight",
      path,
      message: "Событие blocker требует явную причину блокировки.",
      expected: "непустое поле blocker",
      actual: "пустое поле blocker",
      next: "Передай --blocker с точной причиной и следующим внешним условием.",
    });
  }
  if (event.type === "blocker" && state.current.blocker) {
    throw new CycleHarnessError({
      code: "ACTIVE_BLOCKER_EXISTS",
      stage: "event_preflight",
      path,
      message: "Нельзя заменить незакрытый blocker новым blocker-событием.",
      expected: "сначала blocker-resolved для активной причины",
      actual: state.current.blocker,
      next: "Сними текущий blocker отдельным событием и только затем фиксируй новую причину.",
    });
  }
  if (event.type === "blocker-resolved" && !state.current.blocker) {
    throw new CycleHarnessError({
      code: "NO_ACTIVE_BLOCKER",
      stage: "event_preflight",
      path,
      message: "Нельзя снять отсутствующий blocker.",
      expected: "активный current.blocker",
      actual: "blocker отсутствует",
      next: "Запиши обычное событие либо сначала зафиксируй blocker.",
    });
  }
  if (event.type === "checkpoint" && event.blocker !== state.current.blocker) {
    throw new CycleHarnessError({
      code: state.current.blocker ? "CHECKPOINT_BLOCKER_MISMATCH" : "EXPLICIT_BLOCKER_EVENT_REQUIRED",
      stage: "event_preflight",
      path,
      message: state.current.blocker
        ? "Checkpoint должен наследовать активный blocker без замены."
        : "Checkpoint не может создавать новый blocker.",
      expected: state.current.blocker || "пустой blocker; сначала отдельное blocker-событие",
      actual: event.blocker || "пусто",
      next: state.current.blocker
        ? "Не передавай другой --blocker; используй blocker-resolved и новое blocker-событие."
        : "Сначала создай отдельное событие --type blocker --blocker <причина>.",
    });
  }
  if (event.blocker && event.type !== "blocker" && event.type !== "checkpoint") {
    throw new CycleHarnessError({
      code: "EXPLICIT_BLOCKER_EVENT_REQUIRED",
      stage: "event_preflight",
      path,
      message: "Новый blocker фиксируется отдельным blocker-событием.",
      expected: "type=blocker либо checkpoint",
      actual: event.type,
      next: "Создай отдельное событие --type blocker --blocker <причина>.",
    });
  }
  const trigger = event.type === "review" ? `review:${event.result}` : "event";
  return transitionTaskStatus(state.status, trigger);
}

export function normalizedStrings(values, field, { required = false } = {}) {
  const source = values ?? [];
  if (!Array.isArray(source)) {
    throw new CycleHarnessError({
      code: "INVALID_INPUT",
      stage: "input_validation",
      path: field,
      message: `Поле ${field} должно быть массивом строк.`,
      expected: "массив строк",
      actual: typeof source,
      next: `Передай ${field} повторяемыми параметрами.`,
    });
  }
  const result = [...new Set(source.map((item) => assertString(item, field)))];
  if (required && result.length === 0) {
    throw new CycleHarnessError({
      code: "INVALID_INPUT",
      stage: "input_validation",
      path: field,
      message: `Поле ${field} не может быть пустым.`,
      expected: "хотя бы одно значение",
      actual: "0 значений",
      next: `Добавь хотя бы одно значение ${field}.`,
    });
  }
  return result;
}

export function normalizedFacets(values) {
  return normalizedStrings(values, "facets", { required: true })
    .map((facet) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(facet)) {
        throw new CycleHarnessError({
          code: "INVALID_INPUT",
          stage: "input_validation",
          path: "facets",
          message: `Facet должен быть slug в нижнем регистре: ${facet}.`,
          expected: "lower-kebab-case",
          actual: facet,
          next: "Исправь facet, например agent-workflow.",
        });
      }
      return facet;
    })
    .sort();
}

export function durationOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new CycleHarnessError({
      code: "INVALID_INPUT",
      stage: "input_validation",
      path: "duration_minutes",
      message: "Длительность должна быть неотрицательным числом минут.",
      expected: "число >= 0",
      actual: String(value),
      next: "Передай измеренную длительность или не указывай параметр.",
    });
  }
  return duration;
}

export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function pathForDisplay(path) {
  return path.split(sep).join("/");
}

export function listMarkdown(values, empty = "не указано") {
  return values.length === 0 ? `- ${empty}` : values.map((value) => `- ${value}`).join("\n");
}

export function measuredDuration(value) {
  return value === null ? "не измерено" : `${roundMinutes(value)} мин.`;
}

export function roundMinutes(value) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Number.isFinite(rounded) ? rounded : value;
}

export function timestampForFile(iso) {
  return iso.replace(/[-:.]/gu, "");
}

export function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CycleHarnessError({
      code: "INVALID_CLOCK",
      stage: "runtime",
      message: "Clock вернул некорректную дату.",
      actual: String(value),
      next: "Исправь источник времени и повтори команду.",
    });
  }
  return date.toISOString();
}
