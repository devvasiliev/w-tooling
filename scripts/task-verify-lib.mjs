import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { constants as fileConstants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const PROFILES = new Set(["affected", "testing", "pr", "release"]);
const REPOSITORY_STATUSES = new Set(["active", "reserved", "historical", "unmanaged"]);
const ENROLLMENTS = new Set(["enrolled", "pending"]);
const ACTION_KINDS = new Set(["automatic", "obligation"]);
const OBLIGATION_TYPES = new Set(["manual", "external", "stateful"]);
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const REPOSITORY_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const FULL_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TRUSTED_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const UNSAFE_PATH_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const CONTENT_TRANSFORM_ATTRIBUTES = new Set([
  "crlf",
  "eol",
  "filter",
  "ident",
  "text",
  "working-tree-encoding",
]);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GIT_CAPTURE_LIMIT_BYTES = 64 * 1024 * 1024;
const CONFIG_FILE_LIMIT_BYTES = 1024 * 1024;
const CANDIDATE_FILE_LIMIT_BYTES = 32 * 1024 * 1024;
const PLAN_READ_LIMIT_BYTES = 256 * 1024 * 1024;
const PLAN_READ_TIMEOUT_MS = 120_000;
const TRUSTED_TARGET_REF = "refs/heads/master";
const SAFE_CANDIDATE_READ_FLAGS = fileConstants.O_RDONLY
  | fileConstants.O_NOFOLLOW
  | (fileConstants.O_NONBLOCK ?? 0);
const GLOB_CACHE_LIMIT = 4096;
const PATH_STATE_CONCURRENCY = 16;
const DOWNSTREAM_LOAD_CONCURRENCY = 4;
const SNAPSHOT_EXCLUDED_PATHS = Object.freeze([".project/task-runs/**"]);
const SNAPSHOT_EXCLUDE_PATHSPEC = ":(top,exclude).project/task-runs/**";
const globCache = new Map();
const canonicalArraySignatures = new WeakMap();
const snapshotStabilityContexts = new WeakMap();
const planningReadBudgetStorage = new AsyncLocalStorage();

/** Ошибка имеет стабильный код и структурные поля для автоматической обработки. */
export class VerificationError extends Error {
  constructor({
    code,
    stage,
    message,
    path = "",
    expected = "",
    actual = "",
    next = "",
    details = {},
    cause,
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VerificationError";
    this.code = code;
    this.stage = stage;
    this.path = path;
    this.expected = expected;
    this.actual = actual;
    this.next = next;
    this.details = Object.freeze({ ...details });
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      stage: this.stage,
      message: this.message,
      path: this.path,
      expected: this.expected,
      actual: this.actual,
      next: this.next,
      details: this.details,
    };
  }
}

function verificationFailure(code, stage, message, fields = {}) {
  throw new VerificationError({ code, stage, message, ...fields });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function pushUniqueCanonical(values, value) {
  let signatures = canonicalArraySignatures.get(values);
  if (signatures === undefined) {
    signatures = new Set(values.map(canonicalJson));
    canonicalArraySignatures.set(values, signatures);
  }
  const signature = canonicalJson(value);
  if (signatures.has(signature)) return false;
  signatures.add(signature);
  values.push(value);
  return true;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createPlanningReadBudget(overrides = {}) {
  const totalBytes = Math.min(
    PLAN_READ_LIMIT_BYTES,
    Number.isSafeInteger(overrides.totalBytes) && overrides.totalBytes >= 0
      ? overrides.totalBytes
      : PLAN_READ_LIMIT_BYTES,
  );
  const timeoutMs = Math.min(
    PLAN_READ_TIMEOUT_MS,
    Number.isSafeInteger(overrides.timeoutMs) && overrides.timeoutMs >= 0
      ? overrides.timeoutMs
      : PLAN_READ_TIMEOUT_MS,
  );
  return {
    limitBytes: totalBytes,
    consumedBytes: 0,
    deadline: Date.now() + timeoutMs,
    timeoutMs,
  };
}

function remainingPlanningTime(path) {
  const budget = planningReadBudgetStorage.getStore();
  if (budget === undefined) return null;
  const remainingMs = budget.deadline - Date.now();
  if (remainingMs <= 0) {
    verificationFailure("CANDIDATE_READ_TIMEOUT", "git_snapshot", "Чтение candidate превысило общий предел времени.", {
      path,
      expected: `не более ${budget.timeoutMs} мс`,
      actual: "deadline exceeded",
      details: { timeoutMs: budget.timeoutMs, consumedBytes: budget.consumedBytes },
    });
  }
  return remainingMs;
}

function consumePlanningRead(bytes, path) {
  const budget = planningReadBudgetStorage.getStore();
  if (budget === undefined) return;
  remainingPlanningTime(path);
  budget.consumedBytes += bytes;
  if (budget.consumedBytes > budget.limitBytes) {
    verificationFailure("CANDIDATE_READ_BUDGET_EXCEEDED", "git_snapshot", "Чтение candidate превысило общий предел байтов.", {
      path,
      expected: `не более ${budget.limitBytes} байт`,
      actual: `${budget.consumedBytes} байт`,
      details: { limitBytes: budget.limitBytes, consumedBytes: budget.consumedBytes },
    });
  }
}

function assertFileWithinLimit(metadata, path, limitBytes, code, stage) {
  if (metadata.size <= limitBytes) return;
  verificationFailure(code, stage, "Файл превышает безопасный предел чтения.", {
    path,
    expected: `не более ${limitBytes} байт`,
    actual: `${metadata.size} байт`,
    details: { limitBytes, size: metadata.size },
  });
}

/**
 * Читает открытый descriptor порциями, не позволяя росту файла после fstat
 * обойти предел одного файла или общий бюджет планирования.
 */
async function readBoundedFileHandle(
  handle,
  {
    path,
    limitBytes,
    limitCode,
    stage,
    digest = null,
    collect = false,
  },
) {
  const chunks = [];
  let totalBytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, limitBytes + 1));
  while (true) {
    remainingPlanningTime(path);
    const capacity = Math.min(buffer.length, (limitBytes - totalBytes) + 1);
    const { bytesRead } = await handle.read(buffer, 0, capacity, null);
    remainingPlanningTime(path);
    if (bytesRead === 0) break;
    const nextBytes = totalBytes + bytesRead;
    if (nextBytes > limitBytes) {
      verificationFailure(limitCode, stage, "Файл превышает безопасный предел чтения.", {
        path,
        expected: `не более ${limitBytes} байт`,
        actual: `более ${limitBytes} байт`,
        details: { limitBytes, bytesRead: nextBytes },
      });
    }
    consumePlanningRead(bytesRead, path);
    const chunk = buffer.subarray(0, bytesRead);
    digest?.update(chunk);
    if (collect) chunks.push(Buffer.from(chunk));
    totalBytes = nextBytes;
  }
  return collect ? Buffer.concat(chunks, totalBytes) : totalBytes;
}

function requireRecord(value, path) {
  if (!isRecord(value)) {
    verificationFailure("INVALID_CONFIG", "config_validation", `Поле ${path} должно быть объектом.`, {
      path,
      expected: "object",
      actual: Array.isArray(value) ? "array" : String(value === null ? "null" : typeof value),
    });
  }
  return value;
}

function requireKnownKeys(record, allowed, path) {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    verificationFailure("INVALID_CONFIG", "config_validation", `Объект ${path} содержит неизвестные поля.`, {
      path,
      expected: [...allowed].sort().join(", "),
      actual: unknown.sort().join(", "),
    });
  }
}

function requireRepositoryName(value, path) {
  requireString(value, path);
  if (!REPOSITORY_NAME_PATTERN.test(value)) {
    verificationFailure("INVALID_CONFIG", "config_validation", `Некорректное имя репозитория ${value}.`, {
      path,
      expected: "task-<lower-case-hyphen-name>",
      actual: value,
    });
  }
  return value;
}

function requireString(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    verificationFailure("INVALID_CONFIG", "config_validation", `Поле ${path} должно быть строкой.`, {
      path,
      expected: allowEmpty ? "string" : "non-empty string",
      actual: value === undefined ? "missing" : typeof value,
    });
  }
  return value;
}

function requireIdentifier(value, path) {
  requireString(value, path);
  if (!IDENTIFIER_PATTERN.test(value)) {
    verificationFailure("INVALID_CONFIG", "config_validation", `Некорректный идентификатор ${value}.`, {
      path,
      expected: "lower-case stable identifier",
      actual: value,
    });
  }
  return value;
}

function requireStringArray(
  value,
  path,
  { nonEmpty = false, unique = true, allowEmptyStrings = false } = {},
) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    verificationFailure("INVALID_CONFIG", "config_validation", `Поле ${path} должно быть массивом строк.`, {
      path,
      expected: nonEmpty ? "non-empty string array" : "string array",
      actual: Array.isArray(value) ? "empty array" : typeof value,
    });
  }
  for (const [index, item] of value.entries()) {
    requireString(item, `${path}[${index}]`, { allowEmpty: allowEmptyStrings });
  }
  if (unique && new Set(value).size !== value.length) {
    verificationFailure("INVALID_CONFIG", "config_validation", `Поле ${path} содержит повторы.`, {
      path,
      expected: "unique values",
      actual: "duplicates",
    });
  }
  return value;
}

function requireEnum(value, path, allowed) {
  if (!allowed.has(value)) {
    verificationFailure("INVALID_CONFIG", "config_validation", `Поле ${path} содержит неподдерживаемое значение.`, {
      path,
      expected: [...allowed].join(" | "),
      actual: String(value ?? "missing"),
    });
  }
  return value;
}

function portablePath(value, path, { allowDot = true, allowParent = false } = {}) {
  requireString(value, path);
  if (value.includes("\\") || UNSAFE_PATH_CONTROL_PATTERN.test(value) || value.startsWith("/") || isAbsolute(value)) {
    verificationFailure("UNSAFE_PATH", "config_validation", `Путь ${value} не является переносимым относительным путём.`, {
      path,
      expected: "relative POSIX path",
      actual: value,
    });
  }
  const parts = value.split("/");
  const invalid = parts.some(
    (part) => part === "" || (!allowDot && part === ".") || (!allowParent && part === ".."),
  );
  if (invalid || (!allowDot && value === ".")) {
    verificationFailure("UNSAFE_PATH", "config_validation", `Путь ${value} содержит небезопасный сегмент.`, {
      path,
      expected: allowParent ? "relative POSIX path" : "repository-relative POSIX path",
      actual: value,
    });
  }
  return value;
}

function escapesRoot(root, target) {
  const path = relative(root, target);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function resolveRepositoryRoot(value, { stage, requiredCode }) {
  if (typeof value !== "string" || value.length === 0) {
    verificationFailure(requiredCode, stage, "Не передан путь репозитория.", {
      expected: "non-empty repository root path",
      actual: value === undefined ? "missing" : typeof value,
    });
  }
  const lexical = resolve(value);
  try {
    return await realpath(lexical);
  } catch (error) {
    throw new VerificationError({
      code: "REPOSITORY_ROOT_MISSING",
      stage,
      path: lexical,
      message: "Корень репозитория отсутствует или недоступен.",
      actual: error?.message ?? String(error),
      cause: error,
    });
  }
}

async function lstatPathWithoutSymlinks(root, portableRelativePath, path) {
  portablePath(portableRelativePath, path, { allowDot: false });
  let current = root;
  let metadata;
  for (const segment of portableRelativePath.split("/")) {
    current = resolve(current, segment);
    metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      verificationFailure("CONFIG_SYMLINK_UNSUPPORTED", "config_loading", "Доверенная конфигурация не может проходить через symbolic link.", {
        path: current,
        next: "Храни конфигурацию и все её каталоги обычными объектами внутри checkout.",
      });
    }
  }
  return metadata;
}

async function lexicalCheckoutRoot(lexicalFilePath, physicalGitRoot) {
  let current = dirname(lexicalFilePath);
  while (true) {
    try {
      const metadata = await lstat(current);
      if (await realpath(current) === physicalGitRoot && !metadata.isSymbolicLink()) return current;
    } catch {
      // Ошибка чтения конкретного пути будет оформлена вызывающей границей.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  verificationFailure("CONFIG_OUTSIDE_REPOSITORY", "config_loading", "Не удалось восстановить логический путь конфигурации внутри Git checkout.", {
    path: lexicalFilePath,
    expected: physicalGitRoot,
  });
}

function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

/** Поддерживается только положительный POSIX glob без brace/extglob/negation. */
function compilePositiveGlob(pattern, path = "glob") {
  requireString(pattern, path);
  const cached = globCache.get(pattern);
  if (cached !== undefined) return cached;
  if (
    pattern.startsWith("!")
    || pattern.startsWith("/")
    || pattern.includes("\\")
    || UNSAFE_PATH_CONTROL_PATTERN.test(pattern)
    || /[{}[\]]/u.test(pattern)
    || /[?*+@!]\(/u.test(pattern)
    || pattern.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    verificationFailure("INVALID_GLOB", "config_validation", `Недопустимый положительный POSIX glob: ${pattern}.`, {
      path,
      expected: "positive repository-relative POSIX glob",
      actual: pattern,
    });
  }

  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          source += "(?:[^/]+/)*";
          index += 1;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegex(character);
  }
  try {
    const compiled = new RegExp(`${source}$`, "u");
    if (globCache.size >= GLOB_CACHE_LIMIT) globCache.clear();
    globCache.set(pattern, compiled);
    return compiled;
  } catch (error) {
    verificationFailure("INVALID_GLOB", "config_validation", `Некорректное регулярное представление glob ${pattern}.`, {
      path,
      actual: error?.message ?? String(error),
    });
  }
}

function globMatches(pattern, candidate) {
  return compilePositiveGlob(pattern).test(candidate);
}

function hasGlobMagic(pattern) {
  return /[*?[\]]/u.test(pattern);
}

/** Доказывает, что вся именованная поверхность принадлежит хотя бы одной области. */
function areaPatternCoversSurface(areaPattern, surfacePattern) {
  if (areaPattern === surfacePattern || areaPattern === "**") return true;
  if (!hasGlobMagic(surfacePattern)) return globMatches(areaPattern, surfacePattern);
  if (!areaPattern.endsWith("/**")) return false;
  const prefix = areaPattern.slice(0, -3);
  return !hasGlobMagic(prefix) && surfacePattern.startsWith(`${prefix}/`);
}

function validateContractSurfaceOwnership(manifest, collectionName, path) {
  for (const [surfaceId, surface] of Object.entries(manifest[collectionName])) {
    for (const [index, surfacePattern] of surface.paths.entries()) {
      const owners = Object.entries(manifest.areas)
        .filter(([, area]) => area.paths.some(
          (areaPattern) => areaPatternCoversSurface(areaPattern, surfacePattern),
        ))
        .map(([areaId]) => areaId);
      if (owners.length === 0) {
        verificationFailure("CONTRACT_SURFACE_UNOWNED", "config_validation", "Именованная поверхность не принадлежит ни одной области репозитория.", {
          path: `${path}.${collectionName}.${surfaceId}.paths[${index}]`,
          actual: surfacePattern,
          details: { collection: collectionName, surface: surfaceId },
          next: "Добавь область, которая целиком покрывает путь поверхности.",
        });
      }
    }
  }
}

function validateAction(action, path) {
  requireRecord(action, path);
  requireEnum(action.kind, `${path}.kind`, ACTION_KINDS);
  if (action.kind === "automatic") {
    requireKnownKeys(action, new Set(["kind", "argv", "cwd"]), path);
    requireStringArray(action.argv, `${path}.argv`, {
      nonEmpty: true,
      unique: false,
      allowEmptyStrings: true,
    });
    if (action.argv[0].trim() === "") {
      verificationFailure("INVALID_CONFIG", "config_validation", `Команда ${path}.argv пуста.`, {
        path: `${path}.argv[0]`,
      });
    }
    portablePath(action.cwd, `${path}.cwd`, { allowDot: true });
  } else {
    requireKnownKeys(action, new Set(["kind", "obligationType", "reason"]), path);
    requireEnum(action.obligationType, `${path}.obligationType`, OBLIGATION_TYPES);
    requireString(action.reason, `${path}.reason`);
  }
  return action;
}

function validatePathMap(value, path) {
  requireRecord(value, path);
  for (const [id, contract] of Object.entries(value)) {
    requireIdentifier(id, `${path}.${id}`);
    requireRecord(contract, `${path}.${id}`);
    requireKnownKeys(contract, new Set(["paths"]), `${path}.${id}`);
    requireStringArray(contract.paths, `${path}.${id}.paths`, { nonEmpty: true });
    contract.paths.forEach((pattern, index) => compilePositiveGlob(pattern, `${path}.${id}.paths[${index}]`));
  }
  return value;
}

function detectAreaCycle(areas, path) {
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "active") {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      verificationFailure("AREA_DEPENDENCY_CYCLE", "config_validation", `Цикл областей: ${cycle.join(" -> ")}.`, {
        path,
        details: { cycle },
      });
    }
    state.set(id, "active");
    stack.push(id);
    for (const dependency of areas[id].dependsOn) visit(dependency);
    stack.pop();
    state.set(id, "done");
  };
  for (const id of Object.keys(areas)) visit(id);
}

/**
 * Проверяет одну историческую версию repository manifest до объединения политик.
 * Раздельная проверка base и candidate не позволяет исправляемому manifest скрыть
 * прежнюю обязательную проверку удалением или ослаблением собственной записи.
 */
export function validateRepositoryManifest(manifest, { path = "task-verification.json", source = "candidate" } = {}) {
  requireRecord(manifest, path);
  requireKnownKeys(
    manifest,
    new Set(["$schema", "schemaVersion", "kind", "repository", "status", "policy", "actions", "areas", "boundaries", "metaGate", "inputs", "exports"]),
    path,
  );
  if (Object.hasOwn(manifest, "$schema")) requireString(manifest.$schema, `${path}.$schema`);
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.kind !== "repository") {
    verificationFailure("INVALID_CONFIG", "config_validation", `Некорректный repository manifest ${path}.`, {
      path,
      expected: `schemaVersion=${SCHEMA_VERSION}, kind=repository`,
      actual: `schemaVersion=${String(manifest.schemaVersion)}, kind=${String(manifest.kind)}`,
      details: { source },
    });
  }
  requireRepositoryName(manifest.repository, `${path}.repository`);
  requireEnum(manifest.status, `${path}.status`, REPOSITORY_STATUSES);
  requireRecord(manifest.policy, `${path}.policy`);
  requireKnownKeys(manifest.policy, new Set(["fallbackBoundary"]), `${path}.policy`);
  requireIdentifier(manifest.policy.fallbackBoundary, `${path}.policy.fallbackBoundary`);
  requireRecord(manifest.actions, `${path}.actions`);
  if (Object.keys(manifest.actions).length === 0) {
    verificationFailure("INVALID_CONFIG", "config_validation", "Manifest должен содержать хотя бы одно действие.", {
      path: `${path}.actions`,
    });
  }
  for (const [id, action] of Object.entries(manifest.actions)) {
    requireIdentifier(id, `${path}.actions.${id}`);
    validateAction(action, `${path}.actions.${id}`);
  }

  requireRecord(manifest.areas, `${path}.areas`);
  if (Object.keys(manifest.areas).length === 0) {
    verificationFailure("INVALID_CONFIG", "config_validation", "Manifest должен содержать хотя бы одну область.", {
      path: `${path}.areas`,
    });
  }
  for (const [id, area] of Object.entries(manifest.areas)) {
    const areaPath = `${path}.areas.${id}`;
    requireIdentifier(id, areaPath);
    requireRecord(area, areaPath);
    requireKnownKeys(area, new Set(["paths", "dependsOn", "coverage"]), areaPath);
    requireStringArray(area.paths, `${areaPath}.paths`, { nonEmpty: true });
    area.paths.forEach((pattern, index) => compilePositiveGlob(pattern, `${areaPath}.paths[${index}]`));
    requireStringArray(area.dependsOn, `${areaPath}.dependsOn`);
    requireRecord(area.coverage, `${areaPath}.coverage`);
    requireKnownKeys(area.coverage, PROFILES, `${areaPath}.coverage`);
    for (const profile of PROFILES) {
      requireStringArray(area.coverage[profile], `${areaPath}.coverage.${profile}`);
      for (const actionId of area.coverage[profile]) {
        if (!Object.hasOwn(manifest.actions, actionId)) {
          verificationFailure("UNKNOWN_ACTION_REF", "config_validation", `Область ${id} ссылается на неизвестное действие ${actionId}.`, {
            path: `${areaPath}.coverage.${profile}`,
            details: { action: actionId, source },
          });
        }
      }
    }
  }
  for (const [id, area] of Object.entries(manifest.areas)) {
    for (const dependency of area.dependsOn) {
      if (!Object.hasOwn(manifest.areas, dependency)) {
        verificationFailure("UNKNOWN_AREA", "config_validation", `Область ${id} зависит от неизвестной области ${dependency}.`, {
          path: `${path}.areas.${id}.dependsOn`,
          details: { dependency, source },
        });
      }
    }
  }
  detectAreaCycle(manifest.areas, `${path}.areas`);

  requireRecord(manifest.boundaries, `${path}.boundaries`);
  if (Object.keys(manifest.boundaries).length === 0) {
    verificationFailure("EMPTY_BOUNDARY", "config_validation", "Manifest должен содержать хотя бы одну границу.", {
      path: `${path}.boundaries`,
    });
  }
  for (const [id, boundary] of Object.entries(manifest.boundaries)) {
    const boundaryPath = `${path}.boundaries.${id}`;
    requireIdentifier(id, boundaryPath);
    requireRecord(boundary, boundaryPath);
    requireKnownKeys(boundary, new Set(["actions"]), boundaryPath);
    if (!Array.isArray(boundary.actions) || boundary.actions.length === 0) {
      verificationFailure("EMPTY_BOUNDARY", "config_validation", `Граница ${id} не содержит действий.`, {
        path: `${boundaryPath}.actions`,
      });
    }
    requireStringArray(boundary.actions, `${boundaryPath}.actions`, { nonEmpty: true });
    for (const actionId of boundary.actions) {
      if (!Object.hasOwn(manifest.actions, actionId)) {
        verificationFailure("UNKNOWN_ACTION_REF", "config_validation", `Граница ${id} ссылается на неизвестное действие ${actionId}.`, {
          path: `${boundaryPath}.actions`,
          details: { action: actionId, source },
        });
      }
    }
  }
  if (!Object.hasOwn(manifest.boundaries, manifest.policy.fallbackBoundary)) {
    verificationFailure("UNKNOWN_BOUNDARY", "config_validation", "Резервная граница не объявлена.", {
      path: `${path}.policy.fallbackBoundary`,
      actual: manifest.policy.fallbackBoundary,
      details: { source },
    });
  }
  const fallbackActions = manifest.boundaries[manifest.policy.fallbackBoundary].actions;
  for (const [areaId, area] of Object.entries(manifest.areas)) {
    for (const profile of ["pr", "release"]) {
      const missing = fallbackActions.filter((actionId) => !area.coverage[profile].includes(actionId));
      if (missing.length > 0) {
        verificationFailure("BOUNDARY_COVERAGE_MISSING", "config_validation", `Профиль ${profile} области ${areaId} не включает полную резервную границу.`, {
          path: `${path}.areas.${areaId}.coverage.${profile}`,
          expected: fallbackActions.join(", "),
          actual: area.coverage[profile].join(", "),
          details: { area: areaId, profile, missing, source },
        });
      }
    }
  }
  const profileOrder = ["affected", "testing", "pr", "release"];
  for (const [areaId, area] of Object.entries(manifest.areas)) {
    for (let index = 1; index < profileOrder.length; index += 1) {
      const previous = profileOrder[index - 1];
      const current = profileOrder[index];
      const missing = area.coverage[previous].filter((actionId) => !area.coverage[current].includes(actionId));
      if (missing.length > 0) {
        verificationFailure("COVERAGE_NOT_MONOTONIC", "config_validation", `Профиль ${current} области ${areaId} ослабляет ${previous}.`, {
          path: `${path}.areas.${areaId}.coverage.${current}`,
          details: { missing, previous, current, source },
        });
      }
    }
  }

  requireRecord(manifest.metaGate, `${path}.metaGate`);
  requireKnownKeys(manifest.metaGate, new Set(["actions", "profiles"]), `${path}.metaGate`);
  requireStringArray(manifest.metaGate.actions, `${path}.metaGate.actions`);
  requireStringArray(manifest.metaGate.profiles, `${path}.metaGate.profiles`);
  for (const profile of manifest.metaGate.profiles) requireEnum(profile, `${path}.metaGate.profiles`, PROFILES);
  for (let index = 1; index < profileOrder.length; index += 1) {
    const previous = profileOrder[index - 1];
    const current = profileOrder[index];
    if (manifest.metaGate.profiles.includes(previous) && !manifest.metaGate.profiles.includes(current)) {
      verificationFailure("META_GATE_NOT_MONOTONIC", "config_validation", `Meta-gate профиля ${current} ослабляет ${previous}.`, {
        path: `${path}.metaGate.profiles`,
        expected: `${current} после ${previous}`,
        actual: manifest.metaGate.profiles.join(", "),
        details: { previous, current, source },
      });
    }
  }
  for (const actionId of manifest.metaGate.actions) {
    if (!Object.hasOwn(manifest.actions, actionId)) {
      verificationFailure("UNKNOWN_ACTION_REF", "config_validation", `Meta-gate ссылается на неизвестное действие ${actionId}.`, {
        path: `${path}.metaGate.actions`,
        details: { action: actionId, source },
      });
    }
  }
  validatePathMap(manifest.exports, `${path}.exports`);
  validatePathMap(manifest.inputs, `${path}.inputs`);
  validateContractSurfaceOwnership(manifest, "exports", path);
  validateContractSurfaceOwnership(manifest, "inputs", path);
  return manifest;
}

function validateRelationEndpoint(endpoint, path, side, repositories) {
  requireRecord(endpoint, path);
  requireRepositoryName(endpoint.repository, `${path}.repository`);
  if (!Object.hasOwn(repositories, endpoint.repository)) {
    verificationFailure("UNKNOWN_REPOSITORY", "config_validation", `Связь ссылается на неизвестный репозиторий ${endpoint.repository}.`, {
      path: `${path}.repository`,
    });
  }
  const namedField = side === "producer" ? "export" : "input";
  const hasNamed = Object.hasOwn(endpoint, namedField);
  const hasPath = Object.hasOwn(endpoint, "path");
  if (side === "consumer" && (!hasNamed || hasPath)) {
    verificationFailure("INVALID_CONFIG", "config_validation", `${path} должен содержать consumer input.`, {
      path,
      expected: "repository + input",
      actual: Object.keys(endpoint).sort().join(","),
    });
  }
  if (hasNamed === hasPath) {
    verificationFailure("INVALID_CONFIG", "config_validation", `${path} должен содержать ровно одно из ${namedField} и path.`, {
      path,
    });
  }
  requireKnownKeys(endpoint, new Set(["repository", hasNamed ? namedField : "path"]), path);
  if (hasNamed) requireIdentifier(endpoint[namedField], `${path}.${namedField}`);
  if (hasPath) compilePositiveGlob(endpoint.path, `${path}.path`);
}

function validateRelationGraph(relations, path) {
  const incomingRepositories = new Set(relations.map((relation) => relation.consumer.repository));
  for (const relation of relations) {
    if (relation.producer.path !== undefined && incomingRepositories.has(relation.producer.repository)) {
      verificationFailure(
        "TRANSITIVE_PATH_PRODUCER_UNSUPPORTED",
        "config_validation",
        `Связь ${relation.id} использует producer.path после входящей связи.`,
        {
          path: `${path}.relations`,
          details: { relation: relation.id, repository: relation.producer.repository },
          next: "Объяви именованный export для транзитивной поверхности.",
        },
      );
    }
  }
  const adjacency = new Map();
  for (const relation of relations) {
    const producer = relation.producer.repository;
    const consumer = relation.consumer.repository;
    if (producer === consumer) continue;
    adjacency.set(producer, [...(adjacency.get(producer) ?? []), { repository: consumer, relation: relation.id }]);
  }
  const state = new Map();
  const stack = [];
  const visit = (repository) => {
    if (state.get(repository) === "done") return;
    if (state.get(repository) === "active") {
      const start = stack.indexOf(repository);
      const cycle = [...stack.slice(start), repository];
      verificationFailure("RELATION_CYCLE", "config_validation", `Цикл связей репозиториев: ${cycle.join(" -> ")}.`, {
        path: `${path}.relations`,
        details: { cycle },
      });
    }
    state.set(repository, "active");
    stack.push(repository);
    for (const edge of adjacency.get(repository) ?? []) visit(edge.repository);
    stack.pop();
    state.set(repository, "done");
  };
  for (const repository of adjacency.keys()) visit(repository);
}

/**
 * Проверяет самодостаточную структуру workspace registry: владельца, checkout,
 * связи и версионированные исключения. Ссылки на exports, inputs и actions
 * проверяются позже против соответствующей исторической версии manifest.
 */
export function validateWorkspaceRegistry(registry, { path = "workspace-verification.json" } = {}) {
  requireRecord(registry, path);
  requireKnownKeys(
    registry,
    new Set(["$schema", "schemaVersion", "kind", "ownerRepository", "repositories", "relations", "exceptions"]),
    path,
  );
  if (Object.hasOwn(registry, "$schema")) requireString(registry.$schema, `${path}.$schema`);
  if (registry.schemaVersion !== SCHEMA_VERSION || registry.kind !== "workspace") {
    verificationFailure("INVALID_CONFIG", "config_validation", `Некорректный workspace config ${path}.`, {
      path,
      expected: `schemaVersion=${SCHEMA_VERSION}, kind=workspace`,
      actual: `schemaVersion=${String(registry.schemaVersion)}, kind=${String(registry.kind)}`,
    });
  }
  requireRecord(registry.repositories, `${path}.repositories`);
  if (Object.keys(registry.repositories).length === 0) {
    verificationFailure("INVALID_CONFIG", "config_validation", "Workspace registry должен содержать хотя бы один репозиторий.", {
      path: `${path}.repositories`,
    });
  }
  requireRepositoryName(registry.ownerRepository, `${path}.ownerRepository`);
  for (const [id, repository] of Object.entries(registry.repositories)) {
    const repositoryPath = `${path}.repositories.${id}`;
    requireRepositoryName(id, repositoryPath);
    requireRecord(repository, repositoryPath);
    requireKnownKeys(repository, new Set(["status", "enrollment", "root", "manifest", "revision"]), repositoryPath);
    requireEnum(repository.status, `${repositoryPath}.status`, REPOSITORY_STATUSES);
    requireEnum(repository.enrollment, `${repositoryPath}.enrollment`, ENROLLMENTS);
    if (repository.status !== "active" && repository.enrollment !== "pending") {
      verificationFailure("REPOSITORY_STATE_INVALID", "config_validation", "Неактивный репозиторий не может считаться подключённым.", {
        path: repositoryPath,
        expected: "active/enrolled, active/pending or non-active/pending",
        actual: `${repository.status}/${repository.enrollment}`,
        details: { repository: id },
      });
    }
    portablePath(repository.root, `${repositoryPath}.root`, { allowDot: true, allowParent: true });
    if (repository.enrollment === "enrolled") {
      portablePath(repository.manifest, `${repositoryPath}.manifest`, { allowDot: false });
      if (snapshotPathExcluded(repository.manifest)) {
        verificationFailure("INVALID_CONFIG", "config_validation", "Manifest не может находиться в исключённом служебном каталоге.", {
          path: `${repositoryPath}.manifest`,
          actual: repository.manifest,
        });
      }
      if (Object.hasOwn(repository, "revision")) {
        requireString(repository.revision, `${repositoryPath}.revision`);
        if (!TRUSTED_REVISION_PATTERN.test(repository.revision)) {
          verificationFailure("INVALID_CONFIG", "config_validation", "Revision должна быть полным строчным SHA-1 коммита.", {
            path: `${repositoryPath}.revision`,
            expected: "40 lower-case hex characters",
            actual: repository.revision,
          });
        }
      }
    } else if (Object.hasOwn(repository, "manifest") || Object.hasOwn(repository, "revision")) {
      const forbidden = ["manifest", "revision"].filter((field) => Object.hasOwn(repository, field));
      verificationFailure("INVALID_CONFIG", "config_validation", "Pending registration не должна объявлять manifest или revision.", {
        path: repositoryPath,
        expected: "property absent",
        actual: forbidden.join(", "),
      });
    }
  }
  if (!Object.hasOwn(registry.repositories, registry.ownerRepository)) {
    verificationFailure("UNKNOWN_REPOSITORY", "config_validation", "Владелец workspace config отсутствует в repositories.", {
      path: `${path}.ownerRepository`,
      actual: registry.ownerRepository,
    });
  }
  for (const [id, repository] of Object.entries(registry.repositories)) {
    if (id === registry.ownerRepository) {
      if (Object.hasOwn(repository, "revision")) {
        verificationFailure("INVALID_CONFIG", "config_validation", "Владелец workspace registry не должен содержать самоссылочную revision.", {
          path: `${path}.repositories.${id}.revision`,
          expected: "property absent; authority comes from registry base",
          actual: repository.revision,
        });
      }
      continue;
    }
    if (repository.enrollment === "enrolled" && !Object.hasOwn(repository, "revision")) {
      verificationFailure("DOWNSTREAM_REVISION_REQUIRED", "config_validation", "Подключённый downstream не содержит доверенную revision.", {
        path: `${path}.repositories.${id}.revision`,
        expected: "40 lower-case hex characters",
        actual: "missing",
        details: { repository: id },
        next: "Закрепи выпущенный commit downstream в доверенной base-версии workspace registry.",
      });
    }
  }
  if (!Array.isArray(registry.relations)) {
    verificationFailure("INVALID_CONFIG", "config_validation", "Поле relations должно быть массивом.", {
      path: `${path}.relations`,
    });
  }
  const relationIds = new Set();
  for (const [index, relation] of registry.relations.entries()) {
    const relationPath = `${path}.relations[${index}]`;
    requireRecord(relation, relationPath);
    requireKnownKeys(relation, new Set(["id", "producer", "consumer", "type", "verifier"]), relationPath);
    requireIdentifier(relation.id, `${relationPath}.id`);
    if (relationIds.has(relation.id)) {
      verificationFailure("DUPLICATE_RELATION_ID", "config_validation", `Связь ${relation.id} объявлена повторно.`, {
        path: `${relationPath}.id`,
      });
    }
    relationIds.add(relation.id);
    validateRelationEndpoint(relation.producer, `${relationPath}.producer`, "producer", registry.repositories);
    validateRelationEndpoint(relation.consumer, `${relationPath}.consumer`, "consumer", registry.repositories);
    requireEnum(relation.type, `${relationPath}.type`, new Set(["exact-copy", "generated", "compatibility", "artifact"]));
    requireRecord(relation.verifier, `${relationPath}.verifier`);
    requireEnum(relation.verifier.kind, `${relationPath}.verifier.kind`, new Set(["action", "obligation"]));
    if (relation.verifier.kind === "action") {
      requireKnownKeys(relation.verifier, new Set(["kind", "repository", "action"]), `${relationPath}.verifier`);
      requireRepositoryName(relation.verifier.repository, `${relationPath}.verifier.repository`);
      requireIdentifier(relation.verifier.action, `${relationPath}.verifier.action`);
      if (!Object.hasOwn(registry.repositories, relation.verifier.repository)) {
        verificationFailure("UNKNOWN_REPOSITORY", "config_validation", `Verifier ссылается на неизвестный репозиторий.`, {
          path: `${relationPath}.verifier.repository`,
        });
      }
    } else {
      requireKnownKeys(relation.verifier, new Set(["kind", "obligationType", "reason"]), `${relationPath}.verifier`);
      requireEnum(relation.verifier.obligationType, `${relationPath}.verifier.obligationType`, OBLIGATION_TYPES);
      requireString(relation.verifier.reason, `${relationPath}.verifier.reason`);
    }
  }
  validateRelationGraph(registry.relations, path);
  if (!Array.isArray(registry.exceptions)) {
    verificationFailure("INVALID_CONFIG", "config_validation", "Поле exceptions должно быть массивом.", {
      path: `${path}.exceptions`,
    });
  }
  const exceptionIds = new Set();
  const today = new Date().toISOString().slice(0, 10);
  for (const [index, exception] of registry.exceptions.entries()) {
    const exceptionPath = `${path}.exceptions[${index}]`;
    requireRecord(exception, exceptionPath);
    requireKnownKeys(exception, new Set(["id", "version", "scope", "owner", "reason", "expiresAt"]), exceptionPath);
    requireIdentifier(exception.id, `${exceptionPath}.id`);
    if (exceptionIds.has(exception.id)) {
      verificationFailure("DUPLICATE_ID", "config_validation", `Исключение ${exception.id} объявлено повторно.`, {
        path: `${exceptionPath}.id`,
      });
    }
    exceptionIds.add(exception.id);
    if (!Number.isInteger(exception.version) || exception.version < 1) {
      verificationFailure("INVALID_CONFIG", "config_validation", "Версия исключения должна быть положительным целым числом.", {
        path: `${exceptionPath}.version`,
      });
    }
    requireRecord(exception.scope, `${exceptionPath}.scope`);
    requireString(exception.owner, `${exceptionPath}.owner`);
    requireString(exception.reason, `${exceptionPath}.reason`);
    requireString(exception.expiresAt, `${exceptionPath}.expiresAt`);
    const parsedExpiry = new Date(`${exception.expiresAt}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(exception.expiresAt)
      || Number.isNaN(parsedExpiry.valueOf())
      || parsedExpiry.toISOString().slice(0, 10) !== exception.expiresAt
    ) {
      verificationFailure("INVALID_CONFIG", "config_validation", "Дата исключения должна иметь формат YYYY-MM-DD.", {
        path: `${exceptionPath}.expiresAt`,
        actual: exception.expiresAt,
      });
    }
    if (exception.expiresAt < today) {
      verificationFailure("EXCEPTION_EXPIRED", "config_validation", `Исключение ${exception.id} истекло.`, {
        path: `${exceptionPath}.expiresAt`,
        expected: `>= ${today}`,
        actual: exception.expiresAt,
      });
    }
    const scopeKeys = Object.keys(exception.scope).sort();
    if (canonicalJson(scopeKeys) === canonicalJson(["path", "repository"])) {
      requireRepositoryName(exception.scope.repository, `${exceptionPath}.scope.repository`);
      if (!Object.hasOwn(registry.repositories, exception.scope.repository)) {
        verificationFailure("UNKNOWN_REPOSITORY", "config_validation", `Исключение ссылается на неизвестный репозиторий.`, {
          path: `${exceptionPath}.scope.repository`,
          actual: exception.scope.repository,
        });
      }
      compilePositiveGlob(exception.scope.path, `${exceptionPath}.scope.path`);
    } else {
      verificationFailure("INVALID_CONFIG", "config_validation", "Scope исключения должен задавать repository+path.", {
        path: `${exceptionPath}.scope`,
        actual: scopeKeys.join(","),
      });
    }
  }
  return registry;
}

function safeGitEnvironment() {
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/nonexistent",
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  };
  for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function terminateGitProcessTree(child) {
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Процесс мог завершиться между событием потока и попыткой остановки.
    }
  }
  child.kill("SIGKILL");
}

/**
 * Выполняет только Git с очищенным окружением, явным пределом вывода и общей
 * группой процесса, чтобы timeout останавливал также дочерний filter.
 */
async function safeGitCommand({
  argv,
  cwd,
  allowFailure = false,
  stdoutMode = "text",
  stdoutLimitBytes = GIT_CAPTURE_LIMIT_BYTES,
  input,
}) {
  const planningTimeMs = remainingPlanningTime(cwd);
  const commandTimeoutMs = Math.min(60_000, planningTimeMs ?? 60_000);
  const planningDeadlineLimitsCommand = planningTimeMs !== null && planningTimeMs < 60_000;
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = null;
    let outputLimitExceeded = null;
    let planningBudgetExceeded = null;
    let stdinError = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    const child = spawn("/usr/bin/git", argv, {
      cwd,
      env: safeGitEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      timedOut = planningDeadlineLimitsCommand ? "planning" : "command";
      terminateGitProcessTree(child);
    }, commandTimeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk) => {
      if (planningBudgetExceeded !== null) return;
      try {
        consumePlanningRead(chunk.length, `${cwd}:git-stdout`);
      } catch (error) {
        planningBudgetExceeded = error;
        terminateGitProcessTree(child);
        return;
      }
      stdoutHash.update(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimitBytes) {
        outputLimitExceeded = { stream: "stdout", bytes: stdoutBytes };
        terminateGitProcessTree(child);
        return;
      }
      if (stdoutMode !== "hash") stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      if (planningBudgetExceeded !== null) return;
      try {
        consumePlanningRead(chunk.length, `${cwd}:git-stderr`);
      } catch (error) {
        planningBudgetExceeded = error;
        terminateGitProcessTree(child);
        return;
      }
      stderrHash.update(chunk);
      stderrBytes += chunk.length;
      if (stderrBytes > GIT_CAPTURE_LIMIT_BYTES) {
        outputLimitExceeded = { stream: "stderr", bytes: stderrBytes };
        terminateGitProcessTree(child);
        return;
      }
      stderrChunks.push(Buffer.from(chunk));
    });
    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new VerificationError({
        code: "GIT_RUNNER_FAILED",
        stage: "git_runner",
        message: "Не удалось запустить безопасный Git runner.",
        actual: error?.message ?? String(error),
        details: { argv, cwd },
        cause: error,
      }));
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (planningBudgetExceeded === null) {
        try {
          remainingPlanningTime(cwd);
        } catch (error) {
          planningBudgetExceeded = error;
        }
      }
      const capturedStdout = stdoutMode === "hash" ? null : Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (planningBudgetExceeded !== null) {
        rejectPromise(planningBudgetExceeded);
        return;
      }
      if (outputLimitExceeded !== null) {
        rejectPromise(new VerificationError({
          code: "GIT_OUTPUT_LIMIT",
          stage: "git_runner",
          message: "Вывод Git превысил безопасный предел захвата.",
          expected: `не более ${outputLimitExceeded.stream === "stdout" ? stdoutLimitBytes : GIT_CAPTURE_LIMIT_BYTES} байт на поток`,
          actual: `${outputLimitExceeded.stream}: ${outputLimitExceeded.bytes} байт`,
          details: {
            argv,
            cwd,
            ...outputLimitExceeded,
            limitBytes: outputLimitExceeded.stream === "stdout" ? stdoutLimitBytes : GIT_CAPTURE_LIMIT_BYTES,
          },
        }));
        return;
      }
      const result = {
        argv: [...argv],
        cwd,
        exitCode,
        signal,
        stdout: stdoutMode === "text" ? capturedStdout.toString("utf8") : "",
        ...(stdoutMode === "buffer" ? { stdoutBuffer: capturedStdout } : {}),
        stderr,
        stdoutBytes,
        stderrBytes,
        stdoutSha256: stdoutHash.digest("hex"),
        stderrSha256: stderrHash.digest("hex"),
      };
      if (timedOut === "planning") {
        const budget = planningReadBudgetStorage.getStore();
        rejectPromise(new VerificationError({
          code: "CANDIDATE_READ_TIMEOUT",
          stage: "git_snapshot",
          path: cwd,
          message: "Чтение candidate превысило общий предел времени.",
          expected: `не более ${budget?.timeoutMs ?? PLAN_READ_TIMEOUT_MS} мс`,
          actual: `git command terminated after ${commandTimeoutMs} ms`,
          details: {
            timeoutMs: budget?.timeoutMs ?? PLAN_READ_TIMEOUT_MS,
            consumedBytes: budget?.consumedBytes ?? 0,
            result,
          },
        }));
      } else if (timedOut === "command") {
        rejectPromise(new VerificationError({
          code: "GIT_COMMAND_TIMEOUT",
          stage: "git_runner",
          message: "Безопасная Git-команда превысила предел времени.",
          expected: "completion within 60 seconds",
          actual: signal === null ? String(exitCode) : `signal ${signal}`,
          details: result,
        }));
      } else if (stdinError !== null) {
        rejectPromise(new VerificationError({
          code: "GIT_STDIN_FAILED",
          stage: "git_runner",
          message: "Не удалось передать безопасной Git-команде входные данные.",
          actual: stdinError?.message ?? String(stdinError),
          details: result,
          cause: stdinError,
        }));
      } else if (signal !== null) {
        rejectPromise(new VerificationError({
          code: "GIT_COMMAND_TERMINATED",
          stage: "git_runner",
          message: "Безопасная Git-команда была завершена сигналом.",
          expected: "normal process exit",
          actual: `signal ${signal}`,
          details: result,
        }));
      } else if (exitCode !== 0 && !allowFailure) {
        rejectPromise(new VerificationError({
          code: "GIT_COMMAND_FAILED",
          stage: "git_runner",
          message: "Безопасная Git-команда завершилась с ошибкой.",
          expected: "exit code 0",
          actual: signal === null ? String(exitCode) : `signal ${signal}`,
          details: result,
        }));
      } else {
        resolvePromise(result);
      }
    });
    child.stdin.end(input);
  });
}

async function git(
  repositoryRoot,
  argv,
  {
    allowFailure = false,
    stdoutMode = "text",
    stdoutLimitBytes = GIT_CAPTURE_LIMIT_BYTES,
    input,
  } = {},
) {
  return await safeGitCommand({
    argv: [
      "--no-pager",
      "-c", "core.quotepath=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "core.fileMode=true",
      "-c", "core.ignorecase=false",
      "-c", "core.symlinks=true",
      "-c", "core.autocrlf=false",
      "-c", "core.eol=lf",
      "-c", "core.excludesFile=/dev/null",
      "-c", "diff.external=",
      "-c", "core.attributesFile=/dev/null",
      ...argv,
    ],
    cwd: repositoryRoot,
    allowFailure,
    stdoutMode,
    stdoutLimitBytes,
    input,
  });
}

function splitNull(value) {
  return value.split("\0").filter(Boolean);
}

function normalizeGitPath(path, context = "git") {
  if (!path || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    verificationFailure("UNSAFE_GIT_PATH", "git_snapshot", `Git вернул небезопасный путь ${path}.`, {
      path: context,
      actual: path,
    });
  }
  return path;
}

function parseNameStatus(output) {
  const fields = splitNull(output);
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index];
    index += 1;
    const code = rawStatus[0];
    if (code === "R" || code === "C") {
      if (index + 1 >= fields.length) {
        verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Git вернул неполную запись rename/copy.", {
          actual: rawStatus,
        });
      }
      const oldPath = normalizeGitPath(fields[index], "oldPath");
      const newPath = normalizeGitPath(fields[index + 1], "newPath");
      index += 2;
      changes.push({
        status: code === "R" ? "renamed" : "copied",
        rawStatus,
        oldPath,
        newPath,
      });
      continue;
    }
    if (index >= fields.length) {
      verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Git вернул неполную запись изменения.", {
        actual: rawStatus,
      });
    }
    const path = normalizeGitPath(fields[index], "path");
    index += 1;
    const status = ({ A: "added", M: "modified", D: "deleted", T: "type_changed", U: "unmerged" })[code];
    if (!status) {
      verificationFailure("GIT_STATUS_UNSUPPORTED", "git_snapshot", `Неподдерживаемый Git status ${rawStatus}.`, {
        actual: rawStatus,
      });
    }
    changes.push({ status, rawStatus, path });
  }
  return changes;
}

function snapshotPathExcluded(path) {
  return path === ".project/task-runs" || path.startsWith(".project/task-runs/");
}

function parseHiddenIndexPaths(output) {
  const hidden = [];
  for (const record of splitNull(output)) {
    if (record.length < 3 || record[1] !== " ") {
      verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Git вернул некорректную запись index flags.", {
        actual: record,
      });
    }
    const tag = record[0];
    const path = normalizeGitPath(record.slice(2), "indexFlagPath");
    if (snapshotPathExcluded(path)) continue;
    if (tag === tag.toLowerCase()) hidden.push({ path, flag: "assume-unchanged" });
    else if (tag === "S") hidden.push({ path, flag: "skip-worktree" });
  }
  return hidden;
}

function parseIndexEntries(output) {
  const paths = [];
  const gitlinks = [];
  const unmergedPaths = [];
  for (const record of splitNull(output)) {
    const separator = record.indexOf("\t");
    const metadata = separator === -1 ? [] : record.slice(0, separator).split(" ");
    const path = separator === -1 ? "" : normalizeGitPath(record.slice(separator + 1), "indexPath");
    if (metadata.length !== 3) {
      verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Git вернул некорректную запись index stage.", {
        actual: record,
      });
    }
    const [mode, object, stage] = metadata;
    if (!/^[0-3]$/u.test(stage) || !FULL_SHA_PATTERN.test(object)) {
      verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Git вернул некорректные metadata index stage.", {
        path,
        actual: record,
      });
    }
    paths.push(path);
    if (mode === "160000") gitlinks.push(path);
    if (stage !== "0") unmergedPaths.push(path);
  }
  return {
    paths: [...new Set(paths)].sort(),
    gitlinks: [...new Set(gitlinks)].sort(),
    unmergedPaths: [...new Set(unmergedPaths)].sort(),
  };
}

function parseGitPathList(output, context) {
  return [...new Set(
    splitNull(output)
      .map((path) => normalizeGitPath(path, context))
      .filter((path) => !snapshotPathExcluded(path)),
  )].sort();
}

/**
 * Каноническое разложение и полная регистровая свёртка объединяют имена,
 * которые нечувствительная Unicode-ФС считает одним путём. Латинская `ı` без
 * точки остаётся отдельной буквой по стандартной, не турецкой семантике.
 */
function canonicalCaseFoldPath(path) {
  return [...path.normalize("NFD")]
    .map((character) => (
      character === "\u0131"
        ? character
        : character.toUpperCase().toLowerCase()
    ))
    .join("")
    .normalize("NFD");
}

function assertNoCaseFoldCollisions(indexPaths, untrackedPaths) {
  const byFoldedPath = new Map();
  for (const [source, paths] of [["index", indexPaths], ["untracked", untrackedPaths]]) {
    for (const path of paths) {
      const folded = canonicalCaseFoldPath(path);
      const existing = byFoldedPath.get(folded);
      if (existing !== undefined && existing.path !== path) {
        const collision = [existing, { source, path }]
          .sort((left, right) => left.path.localeCompare(right.path));
        verificationFailure("GIT_CASE_COLLISION_UNSAFE", "git_snapshot", "Пути Git различаются только регистром и не имеют переносимого candidate-состояния.", {
          path: collision[0].path,
          expected: "unique path after case folding",
          actual: collision.map((item) => `${item.source}:${item.path}`).join(", "),
          details: { paths: collision },
          next: "Переименуй конфликтующие пути так, чтобы они различались без учёта регистра.",
        });
      }
      if (existing === undefined) byFoldedPath.set(folded, { source, path });
    }
  }
}

function chunkNullInputs(paths, byteLimit = 1024 * 1024) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path) + 1;
    if (current.length > 0 && currentBytes + pathBytes > byteLimit) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(path);
    currentBytes += pathBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function firstUnsafeContentAttribute(output, source, requestedPaths) {
  const fields = output.split("\0");
  if (fields.at(-1) !== "") {
    verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Git вернул незавершённый поток атрибутов.", {
      actual: source,
    });
  }
  fields.pop();
  if (fields.length % 3 !== 0) {
    verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Git вернул неполную запись атрибута.", {
      actual: source,
    });
  }
  const unsafe = [];
  for (let index = 0; index < fields.length; index += 3) {
    const path = normalizeGitPath(fields[index], `${source}AttributePath`);
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (!requestedPaths.has(path) || attribute === "") {
      verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Git вернул атрибут для неожиданного пути.", {
        path,
        expected: "attribute for a requested path",
        actual: `${attribute}=${value}`,
      });
    }
    if (CONTENT_TRANSFORM_ATTRIBUTES.has(attribute) && value !== "unset") {
      unsafe.push({ source, path, attribute, value });
    }
  }
  unsafe.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return unsafe[0] ?? null;
}

/**
 * Проверяет эффективные атрибуты каждой Git-версии до diff. Это покрывает
 * macros и вложенные .gitattributes, не пытаясь самостоятельно толковать их
 * синтаксис и не запуская объявленные filters.
 */
async function assertContentAttributesSafe(repositoryRoot, sources) {
  const evidence = {};
  for (const source of sources) {
    const chunkEvidence = [];
    for (const paths of chunkNullInputs(source.paths)) {
      const input = Buffer.from(`${paths.join("\0")}\0`);
      const result = await git(
        repositoryRoot,
        ["check-attr", "-z", "--stdin", "--all", ...source.argv],
        { input },
      );
      const unsafe = firstUnsafeContentAttribute(
        result.stdout,
        source.id,
        new Set(paths),
      );
      if (unsafe !== null) {
        verificationFailure("GIT_ATTRIBUTES_UNSAFE", "git_snapshot", "Git-атрибут преобразования может скрыть фактические байты от сравнения.", {
          path: unsafe.path,
          expected: "no effective content-transform attribute",
          actual: `${unsafe.attribute}=${unsafe.value}`,
          details: unsafe,
          next: "Удали или сузь преобразующий атрибут и построй план заново.",
        });
      }
      chunkEvidence.push({
        inputSha256: sha256(input),
        outputSha256: result.stdoutSha256,
      });
    }
    evidence[source.id] = sha256(canonicalJson(chunkEvidence));
  }
  return evidence;
}

/**
 * Initialized submodule способен подключить собственные attributes и filters,
 * когда Git сравнивает superproject. До diff такой checkout отклоняется, чтобы
 * декларативное планирование не выполняло локальный код вложенного репозитория.
 */
async function assertInitializedSubmodulesAbsent(repositoryRoot, gitlinks) {
  for (const path of gitlinks) {
    let current = repositoryRoot;
    let metadata;
    let missing = false;
    for (const segment of path.split("/")) {
      current = resolve(current, segment);
      try {
        metadata = await lstat(current);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          missing = true;
          break;
        }
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        verificationFailure("GIT_SUBMODULE_UNSAFE", "git_snapshot", "Путь submodule проходит через symbolic link.", {
          path,
          actual: relative(repositoryRoot, current).split(sep).join("/"),
        });
      }
    }
    if (missing) continue;
    if (!metadata?.isDirectory()) {
      verificationFailure("GIT_SUBMODULE_UNSAFE", "git_snapshot", "Рабочий путь submodule имеет неподдерживаемый тип.", {
        path,
        expected: "missing or uninitialized directory",
        actual: "non-directory",
      });
    }
    const dotGitPath = resolve(current, ".git");
    try {
      await lstat(dotGitPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      throw error;
    }
    verificationFailure("GIT_SUBMODULE_UNSAFE", "git_snapshot", "Initialized submodule может выполнять локальные Git-фильтры при сравнении.", {
      path,
      actual: dotGitPath,
      next: "Деинициализируй submodule перед построением плана или проверь его отдельным доверенным checkout.",
    });
  }
}

function fileIdentity(metadata) {
  return canonicalJson({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  });
}

/**
 * Проходит путь через lstat без следования по ссылкам и фиксирует тип и
 * идентичность каждого сегмента. Возвращает состояние первого небезопасного
 * сегмента либо конечного объекта, чтобы вызывающий код выбрал типизированный отказ.
 */
async function inspectPathChain(root, path) {
  const absolute = resolve(root, path);
  if (escapesRoot(root, absolute)) {
    return { state: "outside", path, absolute, chain: [] };
  }
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { state: "missing", path, absolute, chain: [], error: error.code };
    }
    throw error;
  }
  const rootType = rootMetadata.isSymbolicLink()
    ? "symlink"
    : rootMetadata.isDirectory()
      ? "directory"
      : "special";
  const chain = [{ path: ".", type: rootType, identity: fileIdentity(rootMetadata) }];
  if (rootType !== "directory") {
    return { state: rootType, path, absolute, chain, metadata: rootMetadata };
  }
  let current = root;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return { state: "missing", path, absolute, chain, error: error.code };
      }
      throw error;
    }
    const terminal = index === segments.length - 1;
    const type = metadata.isSymbolicLink()
      ? "symlink"
      : metadata.isDirectory()
        ? "directory"
        : metadata.isFile()
          ? "file"
          : "special";
    chain.push({
      path: relative(root, current).split(sep).join("/"),
      type,
      identity: fileIdentity(metadata),
    });
    if (type === "symlink") {
      return { state: "symlink", path, absolute, chain, metadata, terminal };
    }
    if (!terminal && type !== "directory") {
      return { state: "unsafe-parent", path, absolute, chain, metadata };
    }
    if (terminal) return { state: type, path, absolute, chain, metadata };
  }
  return { state: "missing", path, absolute, chain };
}

/**
 * Хеширует обычный файл через O_NOFOLLOW в заданном лимите и повторно сверяет
 * открытый inode и всю цепочку пути до и после чтения. Любая подмена или рост
 * файла завершается указанным типизированным кодом, а не частичным digest.
 */
async function hashFile(
  root,
  path,
  {
    stage = "git_snapshot",
    driftCode = "CANDIDATE_DRIFT",
    limitBytes = CANDIDATE_FILE_LIMIT_BYTES,
    limitCode = "CANDIDATE_FILE_TOO_LARGE",
  } = {},
) {
  const initial = await inspectPathChain(root, path);
  if (initial.state !== "file") {
    verificationFailure(driftCode, stage, "Файл изменил тип или путь до чтения.", {
      path,
      expected: "regular file without symbolic-link parents",
      actual: initial.state,
    });
  }
  let handle;
  try {
    handle = await open(initial.absolute, SAFE_CANDIDATE_READ_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP") {
      verificationFailure(driftCode, stage, "Файл изменился на symbolic link во время чтения.", {
        path,
        actual: error.code,
      });
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      verificationFailure(driftCode, stage, "Обычный файл изменил тип во время чтения.", {
        path,
        expected: "regular file",
        actual: "non-file",
      });
    }
    assertFileWithinLimit(before, path, limitBytes, limitCode, stage);
    const opened = await inspectPathChain(root, path);
    if (
      opened.state !== "file"
      || canonicalJson(initial.chain) !== canonicalJson(opened.chain)
      || fileIdentity(before) !== fileIdentity(opened.metadata)
    ) {
      verificationFailure(driftCode, stage, "Путь файла изменился между проверкой и открытием.", {
        path,
        expected: sha256(canonicalJson(initial.chain)),
        actual: sha256(canonicalJson(opened.chain)),
        details: { openedState: opened.state },
      });
    }
    const digest = createHash("sha256");
    await readBoundedFileHandle(handle, {
      path,
      limitBytes,
      limitCode,
      stage,
      digest,
    });
    const after = await handle.stat();
    const final = await inspectPathChain(root, path);
    if (
      fileIdentity(before) !== fileIdentity(after)
      || final.state !== "file"
      || canonicalJson(opened.chain) !== canonicalJson(final.chain)
      || fileIdentity(after) !== fileIdentity(final.metadata)
    ) {
      verificationFailure(driftCode, stage, "Файл изменился во время хеширования.", {
        path,
        expected: fileIdentity(before),
        actual: final.state === "file" ? fileIdentity(final.metadata) : final.state,
      });
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Сериализует candidate-объект в состояние снимка: отсутствие, каталог,
 * специальный объект либо файл с режимом, размером и digest. Символическая
 * ссылка в любой позиции пути отклоняется до чтения содержимого.
 */
async function pathState(repositoryRoot, path) {
  const root = await realpath(repositoryRoot);
  const absolute = resolve(root, path);
  if (escapesRoot(root, absolute)) {
    verificationFailure("UNSAFE_GIT_PATH", "git_snapshot", `Путь ${path} выходит за границы репозитория.`, {
      path,
    });
  }
  let current = root;
  let metadata;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { type: "missing" };
      throw error;
    }
    const terminal = index === segments.length - 1;
    if (metadata.isSymbolicLink()) {
      if (!terminal) {
        verificationFailure("GIT_PATH_SYMLINK_UNSAFE", "git_snapshot", "Путь candidate проходит через промежуточный symbolic link.", {
          path,
          actual: relative(root, current).split(sep).join("/"),
          next: "Замени промежуточную ссылку обычным каталогом внутри checkout.",
        });
      }
      verificationFailure("GIT_SYMLINK_UNSAFE", "git_snapshot", "Candidate symbolic link нельзя безопасно привязать к прочитанному inode.", {
        path,
        expected: "regular file or directory",
        actual: "terminal symbolic link",
        next: "Замени ссылку обычным объектом внутри checkout до построения плана.",
      });
    }
    if (!terminal && !metadata.isDirectory()) {
      verificationFailure("GIT_PATH_PARENT_UNSAFE", "git_snapshot", "Промежуточный объект candidate не является каталогом.", {
        path,
        actual: relative(root, current).split(sep).join("/"),
      });
    }
  }
  if (metadata.isDirectory()) return { type: "directory" };
  if (!metadata.isFile()) return { type: "special" };
  return {
    type: "file",
    mode: metadata.mode & 0o111 ? "100755" : "100644",
    size: metadata.size,
    sha256: await hashFile(root, path),
  };
}

function chunkLiteralPathspecs(paths, byteLimit = 48 * 1024) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const path of paths) {
    const pathspec = `:(literal)${path}`;
    const pathspecBytes = Buffer.byteLength(pathspec) + 1;
    if (current.length > 0 && currentBytes + pathspecBytes > byteLimit) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(pathspec);
    currentBytes += pathspecBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Читает base-состояния пакетом: число Git-процессов зависит от размера argv,
 * а не от числа изменённых файлов. Batch-check доказывает наличие blob без
 * сетевой догрузки и без чтения их содержимого в память планировщика.
 */
async function basePathStates(repositoryRoot, base, paths) {
  const states = new Map(paths.map((path) => [path, { type: "missing" }]));
  const requested = new Set(paths);
  for (const pathspecs of chunkLiteralPathspecs(paths)) {
    const listing = await git(repositoryRoot, ["ls-tree", "-z", base, "--", ...pathspecs]);
    for (const record of splitNull(listing.stdout)) {
      const separator = record.indexOf("\t");
      const metadata = separator === -1 ? [] : record.slice(0, separator).split(" ");
      const path = separator === -1 ? "" : normalizeGitPath(record.slice(separator + 1), "basePath");
      if (metadata.length !== 3 || !requested.has(path)) {
        verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Не удалось разобрать пакетное base state.", {
          path,
          actual: record,
        });
      }
      const [mode, type, object] = metadata;
      if (type === "tree") states.set(path, { type: "directory", mode, object });
      else if (type === "blob" && mode === "120000") states.set(path, { type: "symlink", mode, object });
      else if (type === "blob") states.set(path, { type: "file", mode, object });
      else states.set(path, { type: "unsupported", mode, object });
    }
  }

  const blobObjects = [...new Set(
    [...states.values()]
      .filter((state) => state.type === "file" || state.type === "symlink")
      .map((state) => state.object),
  )].sort();
  if (blobObjects.length > 0) {
    const checked = await git(
      repositoryRoot,
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      { input: `${blobObjects.join("\n")}\n` },
    );
    const lines = checked.stdout.trimEnd().split("\n");
    if (lines.length !== blobObjects.length) {
      verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Git вернул неполный batch-check base objects.", {
        expected: String(blobObjects.length),
        actual: String(lines.length),
      });
    }
    for (const [index, line] of lines.entries()) {
      const [object, type, size, ...extra] = line.split(" ");
      if (object !== blobObjects[index] || type === "missing") {
        verificationFailure("GIT_BASE_OBJECT_MISSING", "git_snapshot", "Base blob недоступен без сетевой догрузки.", {
          expected: `${blobObjects[index]} blob`,
          actual: line,
          next: "Используй полный доверенный clone с доступными base objects.",
        });
      }
      if (type !== "blob" || !/^\d+$/u.test(size ?? "") || extra.length > 0) {
        verificationFailure("GIT_OUTPUT_INVALID", "git_snapshot", "Git вернул некорректный batch-check base object.", {
          expected: `${blobObjects[index]} blob <size>`,
          actual: line,
        });
      }
    }
  }
  return states;
}

async function exactBaseSha(repositoryRoot, base) {
  if (!FULL_SHA_PATTERN.test(String(base ?? ""))) {
    verificationFailure("BASE_SHA_REQUIRED", "git_snapshot", "--base должен быть полным SHA коммита.", {
      expected: "40 or 64 lower-case hex characters",
      actual: String(base ?? "missing"),
      next: "Передай полный SHA исходного коммита.",
    });
  }
  const resolved = await git(repositoryRoot, ["rev-parse", "--verify", `${base}^{commit}`], { allowFailure: true });
  if (resolved.exitCode !== 0 || resolved.stdout.trim() !== base) {
    verificationFailure("BOOTSTRAP_REQUIRED", "git_snapshot", "--base не указывает точно на доступный commit.", {
      expected: base,
      actual: resolved.stdout.trim() || resolved.stderr.trim() || "not found",
    });
  }
  return base;
}

async function captureBaseAuthority(repositoryRoot) {
  const [head, target, mergeBase] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"], { allowFailure: true }),
    git(repositoryRoot, ["rev-parse", "--verify", `${TRUSTED_TARGET_REF}^{commit}`], { allowFailure: true }),
    git(repositoryRoot, ["merge-base", "HEAD", TRUSTED_TARGET_REF], { allowFailure: true }),
  ]);
  if (target.exitCode !== 0 || !FULL_SHA_PATTERN.test(target.stdout.trim())) {
    verificationFailure("TRUSTED_TARGET_REF_MISSING", "input_validation", "Не найдена защищённая целевая ветка для определения базы.", {
      path: repositoryRoot,
      expected: TRUSTED_TARGET_REF,
      actual: target.stderr.trim() || "missing",
    });
  }
  if (
    head.exitCode !== 0
    || mergeBase.exitCode !== 0
    || !FULL_SHA_PATTERN.test(head.stdout.trim())
    || !FULL_SHA_PATTERN.test(mergeBase.stdout.trim())
  ) {
    verificationFailure("BASE_AUTHORITY_UNAVAILABLE", "input_validation", "Не удалось вычислить общий предок HEAD и защищённой ветки.", {
      path: repositoryRoot,
      expected: `git merge-base HEAD ${TRUSTED_TARGET_REF}`,
      actual: mergeBase.stderr.trim() || mergeBase.stdout.trim() || "unavailable",
    });
  }
  return {
    kind: "protected-target-merge-base",
    repositoryRoot,
    targetRef: TRUSTED_TARGET_REF,
    headSha: head.stdout.trim(),
    targetSha: target.stdout.trim(),
    mergeBaseSha: mergeBase.stdout.trim(),
  };
}

async function verifiedBaseAuthority(repositoryRoot, claimedBase, code) {
  const authority = await captureBaseAuthority(repositoryRoot);
  if (claimedBase !== authority.mergeBaseSha) {
    verificationFailure(code, "input_validation", "Переданная база не совпадает с доверенным общим предком защищённой ветки.", {
      path: repositoryRoot,
      expected: authority.mergeBaseSha,
      actual: claimedBase,
      details: authority,
      next: `Используй точный git merge-base HEAD ${TRUSTED_TARGET_REF}.`,
    });
  }
  return authority;
}

async function assertBaseAuthorityStable(authority) {
  const actual = await captureBaseAuthority(authority.repositoryRoot);
  if (canonicalJson(authority) !== canonicalJson(actual)) {
    verificationFailure("CANDIDATE_DRIFT", "git_snapshot", "Доверенная база изменилась во время построения плана.", {
      path: authority.repositoryRoot,
      expected: sha256(canonicalJson(authority)),
      actual: sha256(canonicalJson(actual)),
      details: { expectedAuthority: authority, actualAuthority: actual },
    });
  }
}

/**
 * Запрещает локальные Git-атрибуты, которые не входят в снимок candidate.
 * Даже встроенный `ident` меняет нормализацию без запуска внешнего фильтра и
 * поэтому способен скрыть фактические байты рабочего дерева от `git diff`.
 */
async function assertRepositoryLocalAttributesSafe(repositoryRoot) {
  const attributesPathResult = await git(
    repositoryRoot,
    ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"],
    { allowFailure: true },
  );
  const attributesPath = attributesPathResult.stdout.trim();
  if (
    attributesPathResult.exitCode !== 0
    || attributesPath.length === 0
    || attributesPath.includes("\0")
    || attributesPath.includes("\n")
    || !isAbsolute(attributesPath)
  ) {
    verificationFailure("GIT_ATTRIBUTES_READ_FAILED", "git_snapshot", "Не удалось определить локальный файл Git-атрибутов.", {
      expected: "one absolute path from git rev-parse --git-path info/attributes",
      actual: attributesPath || attributesPathResult.stderr.trim() || `exit ${attributesPathResult.exitCode}`,
    });
  }

  let metadata;
  try {
    metadata = await lstat(attributesPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
    throw new VerificationError({
      code: "GIT_ATTRIBUTES_READ_FAILED",
      stage: "git_snapshot",
      path: attributesPath,
      message: "Не удалось проверить локальный файл Git-атрибутов.",
      actual: error?.message ?? String(error),
      cause: error,
    });
  }

  if (metadata.isFile() && metadata.size === 0) return;
  verificationFailure("GIT_ATTRIBUTES_UNSAFE", "git_snapshot", "Локальные Git-атрибуты могут скрыть байты рабочего дерева от сравнения.", {
    path: attributesPath,
    expected: "missing or empty regular .git/info/attributes",
    actual: metadata.isSymbolicLink()
      ? "symbolic link"
      : metadata.isFile()
        ? `non-empty file (${metadata.size} bytes)`
        : "non-regular path",
    next: "Удали локальные Git-атрибуты или используй доверенный checkout без них.",
  });
}

/**
 * Фиксирует итоговое изменение от точного base SHA до текущего рабочего дерева.
 * В один набор входят commits, index, незаписанные и untracked файлы; rename и
 * copy сохраняют обе стороны, чтобы каждая проверялась своей версией manifest.
 */
async function collectGitChangesCore({ repositoryRoot, base } = {}) {
  const root = await resolveRepositoryRoot(repositoryRoot, {
    stage: "git_snapshot",
    requiredCode: "REPOSITORY_REQUIRED",
  });
  const baseSha = await exactBaseSha(root, base);
  await assertRepositoryLocalAttributesSafe(root);
  const filterConfigResult = await git(
    root,
    ["config", "--includes", "--show-scope", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"],
    { allowFailure: true },
  );
  if (filterConfigResult.exitCode === 0 && filterConfigResult.stdout.trim() !== "") {
    verificationFailure("GIT_FILTER_UNSAFE", "git_snapshot", "Repository/worktree clean/process filter может выполнять внешний код при сравнении.", {
      expected: "no effective filter.<name>.clean or filter.<name>.process",
      actual: filterConfigResult.stdout.trim().split("\n").sort().join(", "),
      next: "Удали исполняемый filter из локальной Git-конфигурации или используй доверенный checkout без него.",
    });
  }
  if (!new Set([0, 1]).has(filterConfigResult.exitCode)) {
    verificationFailure("GIT_CONFIG_READ_FAILED", "git_snapshot", "Не удалось проверить локальные Git-фильтры.", {
      expected: "git config exit code 0 or 1",
      actual: String(filterConfigResult.exitCode),
    });
  }
  const [
    indexStageResult,
    indexFlagsResult,
    headResult,
    branchResult,
    untrackedResult,
  ] = await Promise.all([
    git(root, ["ls-files", "--stage", "-z"]),
    git(root, ["ls-files", "-v", "-z"]),
    git(root, ["rev-parse", "--verify", "HEAD"]),
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }),
    git(root, ["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z", "--", SNAPSHOT_EXCLUDE_PATHSPEC]),
  ]);
  const indexEntries = parseIndexEntries(indexStageResult.stdout);
  const { gitlinks } = indexEntries;
  if (indexEntries.unmergedPaths.length > 0) {
    verificationFailure("UNMERGED_INDEX", "git_snapshot", "Git index содержит неразрешённые конфликты.", {
      details: { paths: indexEntries.unmergedPaths },
      next: "Разреши конфликты index до построения плана проверок.",
    });
  }
  await assertInitializedSubmodulesAbsent(root, gitlinks);
  const hiddenIndexPaths = parseHiddenIndexPaths(indexFlagsResult.stdout);
  if (hiddenIndexPaths.length > 0) {
    verificationFailure("GIT_INDEX_HIDDEN_PATHS", "git_snapshot", "Git index скрывает пути от обычного сравнения.", {
      expected: "no assume-unchanged or skip-worktree flags",
      actual: hiddenIndexPaths.map((item) => `${item.flag}:${item.path}`).join(", "),
      details: { paths: hiddenIndexPaths },
      next: "Сними специальные index flags штатной командой Git и построй план заново.",
    });
  }
  const headSha = headResult.stdout.trim();
  const untrackedPaths = parseGitPathList(untrackedResult.stdout, "untracked");
  const [
    baseTreePathsResult,
    headTreePathsResult,
  ] = await Promise.all([
    git(root, ["ls-tree", "-r", "-z", "--name-only", baseSha]),
    git(root, ["ls-tree", "-r", "-z", "--name-only", headSha]),
  ]);
  const baseTrackedPaths = parseGitPathList(baseTreePathsResult.stdout, "baseTrackedPath");
  const headTrackedPaths = parseGitPathList(headTreePathsResult.stdout, "headTrackedPath");
  const indexPaths = indexEntries.paths.filter((path) => !snapshotPathExcluded(path));
  assertNoCaseFoldCollisions(indexPaths, untrackedPaths);
  const worktreePaths = [...new Set([...indexPaths, ...untrackedPaths])].sort();
  const contentAttributesSha256 = await assertContentAttributesSafe(root, [
    { id: "base", paths: baseTrackedPaths, argv: ["--source", baseSha] },
    { id: "head", paths: headTrackedPaths, argv: ["--source", headSha] },
    { id: "index", paths: indexPaths, argv: ["--cached"] },
    { id: "worktree", paths: worktreePaths, argv: [] },
  ]);
  const [
    committedNamesResult,
    indexNamesResult,
    worktreeNamesResult,
  ] = await Promise.all([
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--name-status", "-z", "-M", "-C", baseSha, "HEAD", "--", SNAPSHOT_EXCLUDE_PATHSPEC]),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--cached", "--name-status", "-z", "-M", "-C", "HEAD", "--", SNAPSHOT_EXCLUDE_PATHSPEC]),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--name-status", "-z", "-M", "-C", "--", SNAPSHOT_EXCLUDE_PATHSPEC]),
  ]);
  const layeredChanges = [
    ...parseNameStatus(committedNamesResult.stdout).map((change) => ({ ...change, provenance: ["base_to_head"] })),
    ...parseNameStatus(indexNamesResult.stdout).map((change) => ({ ...change, provenance: ["head_to_index"] })),
    ...parseNameStatus(worktreeNamesResult.stdout).map((change) => ({ ...change, provenance: ["index_to_worktree"] })),
  ];
  const changeMap = new Map();
  for (const change of layeredChanges) {
    const key = canonicalJson({
      status: change.status,
      rawStatus: change.rawStatus,
      path: change.path,
      oldPath: change.oldPath,
      newPath: change.newPath,
    });
    const existing = changeMap.get(key);
    if (existing === undefined) changeMap.set(key, change);
    else existing.provenance = [...new Set([...existing.provenance, ...change.provenance])].sort();
  }
  for (const path of untrackedPaths) {
    const change = { status: "untracked", rawStatus: "?", path, provenance: ["untracked"] };
    changeMap.set(canonicalJson(change), change);
  }
  const changes = [...changeMap.values()];
  const unmerged = changes.filter((change) => change.status === "unmerged");
  if (unmerged.length > 0) {
    verificationFailure("UNMERGED_INDEX", "git_snapshot", "Git index содержит неразрешённые конфликты.", {
      details: {
        paths: unmerged.map((change) => change.path),
        provenance: unmerged.map((change) => change.provenance),
      },
      next: "Разреши конфликты index до построения плана проверок.",
    });
  }
  const endpointPaths = new Set();
  for (const change of changes) {
    if (change.oldPath) endpointPaths.add(change.oldPath);
    if (change.newPath) endpointPaths.add(change.newPath);
    if (change.path) endpointPaths.add(change.path);
  }
  const sortedEndpointPaths = [...endpointPaths].sort();
  const baseStates = await basePathStates(root, baseSha, sortedEndpointPaths);
  const pathStates = await mapWithConcurrency(
    sortedEndpointPaths,
    PATH_STATE_CONCURRENCY,
    async (path) => ({
      path,
      base: baseStates.get(path),
      candidate: await pathState(root, path),
    }),
  );
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
  const snapshotCore = {
    repositoryRoot: root,
    baseSha,
    headSha,
    headState: branch === null ? "detached" : "branch",
    branch,
    excludedPaths: [...SNAPSHOT_EXCLUDED_PATHS],
    gitNormalization: {
      autocrlf: false,
      eol: "lf",
      ignorecase: false,
      symlinks: true,
    },
    filterConfigSha256: filterConfigResult.stdoutSha256,
    contentAttributesSha256,
    indexStageSha256: indexStageResult.stdoutSha256,
    gitlinks,
    indexFlagsSha256: indexFlagsResult.stdoutSha256,
    diffSha256: sha256(canonicalJson([
      committedNamesResult.stdoutSha256,
      indexNamesResult.stdoutSha256,
      worktreeNamesResult.stdoutSha256,
    ])),
    untrackedSha256: untrackedResult.stdoutSha256,
    changes,
    pathStates,
  };
  const snapshot = {
    ...snapshotCore,
    fingerprint: sha256(canonicalJson(snapshotCore)),
  };
  snapshotStabilityContexts.set(snapshot, {
    baseTrackedPaths,
    headTrackedPaths,
    indexPaths,
    worktreePaths,
    endpointPaths: sortedEndpointPaths,
    expected: {
      headSha,
      headState: snapshot.headState,
      branch,
      filterConfigSha256: snapshot.filterConfigSha256,
      contentAttributesSha256: snapshot.contentAttributesSha256,
      indexStageSha256: snapshot.indexStageSha256,
      indexFlagsSha256: snapshot.indexFlagsSha256,
      diffSha256: snapshot.diffSha256,
      untrackedSha256: snapshot.untrackedSha256,
      candidatePathStates: pathStates.map(({ path, candidate }) => ({ path, candidate })),
    },
  });
  return snapshot;
}

/**
 * Повторяет идентификаторы оптимистичного снимка. Planner либо использует одно
 * состояние HEAD/index/worktree, либо завершается типизированным отказом.
 */
async function assertGitSnapshotStable(snapshot) {
  const context = snapshotStabilityContexts.get(snapshot);
  if (context === undefined) {
    verificationFailure("CANDIDATE_DRIFT", "git_snapshot", "Отсутствует контекст повторной проверки candidate-снимка.", {
      path: snapshot?.repositoryRoot ?? "",
    });
  }
  const root = snapshot.repositoryRoot;
  await assertRepositoryLocalAttributesSafe(root);
  const [
    filterConfigResult,
    indexStageResult,
    indexFlagsResult,
    headResult,
    branchResult,
    untrackedResult,
    committedNamesResult,
    indexNamesResult,
    worktreeNamesResult,
  ] = await Promise.all([
    git(root, ["config", "--includes", "--show-scope", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"], { allowFailure: true }),
    git(root, ["ls-files", "--stage", "-z"]),
    git(root, ["ls-files", "-v", "-z"]),
    git(root, ["rev-parse", "--verify", "HEAD"]),
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }),
    git(root, ["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z", "--", SNAPSHOT_EXCLUDE_PATHSPEC]),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--name-status", "-z", "-M", "-C", snapshot.baseSha, "HEAD", "--", SNAPSHOT_EXCLUDE_PATHSPEC]),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--cached", "--name-status", "-z", "-M", "-C", "HEAD", "--", SNAPSHOT_EXCLUDE_PATHSPEC]),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--name-status", "-z", "-M", "-C", "--", SNAPSHOT_EXCLUDE_PATHSPEC]),
  ]);
  if (filterConfigResult.exitCode === 0 && filterConfigResult.stdout.trim() !== "") {
    verificationFailure("GIT_FILTER_UNSAFE", "git_snapshot", "Repository/worktree clean/process filter появился во время построения плана.", {
      expected: "no effective filter.<name>.clean or filter.<name>.process",
      actual: filterConfigResult.stdout.trim().split("\n").sort().join(", "),
    });
  }
  if (!new Set([0, 1]).has(filterConfigResult.exitCode)) {
    verificationFailure("GIT_CONFIG_READ_FAILED", "git_snapshot", "Не удалось повторно проверить локальные Git-фильтры.", {
      expected: "git config exit code 0 or 1",
      actual: String(filterConfigResult.exitCode),
    });
  }
  const currentIndex = parseIndexEntries(indexStageResult.stdout);
  if (currentIndex.unmergedPaths.length > 0) {
    verificationFailure("UNMERGED_INDEX", "git_snapshot", "Git index изменился и содержит неразрешённые конфликты.", {
      details: { paths: currentIndex.unmergedPaths },
    });
  }
  await assertInitializedSubmodulesAbsent(root, currentIndex.gitlinks);
  const hiddenIndexPaths = parseHiddenIndexPaths(indexFlagsResult.stdout);
  if (hiddenIndexPaths.length > 0) {
    verificationFailure("GIT_INDEX_HIDDEN_PATHS", "git_snapshot", "Git index получил специальные flags во время построения плана.", {
      details: { paths: hiddenIndexPaths },
    });
  }
  const currentUntrackedPaths = parseGitPathList(untrackedResult.stdout, "untracked");
  const currentIndexPaths = currentIndex.paths.filter((path) => !snapshotPathExcluded(path));
  assertNoCaseFoldCollisions(currentIndexPaths, currentUntrackedPaths);
  const contentAttributesSha256 = await assertContentAttributesSafe(root, [
    { id: "base", paths: context.baseTrackedPaths, argv: ["--source", snapshot.baseSha] },
    { id: "head", paths: context.headTrackedPaths, argv: ["--source", snapshot.headSha] },
    { id: "index", paths: context.indexPaths, argv: ["--cached"] },
    { id: "worktree", paths: context.worktreePaths, argv: [] },
  ]);
  const candidatePathStates = await mapWithConcurrency(
    context.endpointPaths,
    PATH_STATE_CONCURRENCY,
    async (path) => ({ path, candidate: await pathState(root, path) }),
  );
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
  const actual = {
    headSha: headResult.stdout.trim(),
    headState: branch === null ? "detached" : "branch",
    branch,
    filterConfigSha256: filterConfigResult.stdoutSha256,
    contentAttributesSha256,
    indexStageSha256: indexStageResult.stdoutSha256,
    indexFlagsSha256: indexFlagsResult.stdoutSha256,
    diffSha256: sha256(canonicalJson([
      committedNamesResult.stdoutSha256,
      indexNamesResult.stdoutSha256,
      worktreeNamesResult.stdoutSha256,
    ])),
    untrackedSha256: untrackedResult.stdoutSha256,
    candidatePathStates,
  };
  if (canonicalJson(context.expected) !== canonicalJson(actual)) {
    const changedEvidence = Object.keys(context.expected)
      .filter((field) => canonicalJson(context.expected[field]) !== canonicalJson(actual[field]));
    verificationFailure("CANDIDATE_DRIFT", "git_snapshot", "Candidate изменился во время построения плана проверок.", {
      path: root,
      expected: sha256(canonicalJson(context.expected)),
      actual: sha256(canonicalJson(actual)),
      details: { changedEvidence },
      next: "Останови параллельную запись в checkout и построй план заново.",
    });
  }
}

/**
 * Возвращает согласованный снимок всех изменений относительно точного base SHA.
 * Перед возвратом повторно сверяет Git и прочитанные файлы, поэтому вызывающий
 * код не получает план, собранный из нескольких состояний checkout.
 */
export async function collectGitChanges(options = {}) {
  if (planningReadBudgetStorage.getStore() === undefined) {
    return await planningReadBudgetStorage.run(
      createPlanningReadBudget(options.readLimits),
      async () => await collectGitChanges(options),
    );
  }
  const snapshot = await collectGitChangesCore(options);
  await assertGitSnapshotStable(snapshot);
  return snapshot;
}

/**
 * Читает candidate-конфигурацию только как обычный файл внутри checkout.
 * Один открытый descriptor ограничивает размер, а повторная сверка цепочки
 * отклоняет замену файла или каталога во время чтения.
 */
async function readCandidateBytesWithoutSymlinks(root, absolutePath, label) {
  const repositoryPath = relative(root, absolutePath).split(sep).join("/");
  if (escapesRoot(root, absolutePath)) {
    verificationFailure("CANDIDATE_DRIFT", "config_loading", "Candidate-конфигурация вышла за границы checkout.", {
      path: absolutePath,
      expected: root,
      actual: absolutePath,
      details: { label },
    });
  }
  const initial = await inspectPathChain(root, repositoryPath);
  if (initial.state !== "file") {
    verificationFailure("CANDIDATE_DRIFT", "config_loading", "Путь candidate-конфигурации изменился во время построения плана.", {
      path: absolutePath,
      expected: "regular file without symbolic-link parents",
      actual: initial.state,
      details: { label },
    });
  }
  let handle;
  try {
    handle = await open(absolutePath, SAFE_CANDIDATE_READ_FLAGS);
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("not a regular file");
    assertFileWithinLimit(
      before,
      absolutePath,
      CONFIG_FILE_LIMIT_BYTES,
      "CONFIG_FILE_TOO_LARGE",
      "config_loading",
    );
    const opened = await inspectPathChain(root, repositoryPath);
    if (
      opened.state !== "file"
      || canonicalJson(initial.chain) !== canonicalJson(opened.chain)
      || fileIdentity(before) !== fileIdentity(opened.metadata)
    ) {
      verificationFailure("CANDIDATE_DRIFT", "config_loading", "Путь candidate-конфигурации изменился между проверкой и открытием.", {
        path: absolutePath,
        details: { label, openedState: opened.state },
      });
    }
    const bytes = await readBoundedFileHandle(handle, {
      path: absolutePath,
      limitBytes: CONFIG_FILE_LIMIT_BYTES,
      limitCode: "CONFIG_FILE_TOO_LARGE",
      stage: "config_loading",
      collect: true,
    });
    const after = await handle.stat();
    const final = await inspectPathChain(root, repositoryPath);
    if (
      fileIdentity(before) !== fileIdentity(after)
      || final.state !== "file"
      || canonicalJson(opened.chain) !== canonicalJson(final.chain)
      || fileIdentity(after) !== fileIdentity(final.metadata)
    ) {
      verificationFailure("CANDIDATE_DRIFT", "config_loading", "Candidate-конфигурация изменилась во время повторного чтения.", {
        path: absolutePath,
        expected: fileIdentity(before),
        actual: final.state === "file" ? fileIdentity(final.metadata) : final.state,
        details: { label },
      });
    }
    return bytes;
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    verificationFailure("CANDIDATE_DRIFT", "config_loading", "Не удалось повторно прочитать candidate-конфигурацию.", {
      path: absolutePath,
      actual: error?.message ?? String(error),
      details: { label },
    });
  } finally {
    await handle?.close();
  }
}

/**
 * Выполняет последний барьер перед возвратом плана: повторно подтверждает
 * authority базы, Git-снимки и точные байты candidate registry и manifests.
 * Изменение любого источника превращается в типизированный drift.
 */
async function assertPlanningInputsStable({
  registries,
  manifestPairs = new Map(),
  snapshots,
  stabilitySnapshots = [],
  baseAuthorities = [],
}) {
  await Promise.all(baseAuthorities.map(async (authority) => await assertBaseAuthorityStable(authority)));
  const snapshotsToVerify = [
    ...Object.values(snapshots),
    ...stabilitySnapshots,
  ];
  await mapWithConcurrency(
    snapshotsToVerify,
    DOWNSTREAM_LOAD_CONCURRENCY,
    async (snapshot) => await assertGitSnapshotStable(snapshot),
  );
  const checks = [{
    label: "workspace-registry",
    root: registries.ownerRoot,
    path: registries.path,
    expected: registries.candidateBytes,
  }];
  for (const [repository, pair] of manifestPairs) {
    const candidate = pair?.candidate;
    if (candidate === undefined || !isAbsolute(candidate.path)) continue;
    checks.push({
      label: `manifest:${repository}`,
      root: candidate.root,
      path: candidate.path,
      expected: candidate.bytes,
    });
  }
  for (const check of checks) {
    const actual = await readCandidateBytesWithoutSymlinks(check.root, check.path, check.label);
    if (!actual.equals(check.expected)) {
      verificationFailure("CANDIDATE_DRIFT", "config_loading", "Candidate-конфигурация изменилась во время построения плана.", {
        path: check.path,
        expected: sha256(check.expected),
        actual: sha256(actual),
        details: { label: check.label },
        next: "Останови параллельную запись в checkout и построй план заново.",
      });
    }
  }
}

async function readJson(path, code = "CONFIG_READ_FAILED", { root = null, label = "config" } = {}) {
  let bytes;
  try {
    if (root !== null) {
      bytes = await readCandidateBytesWithoutSymlinks(root, path, label);
    } else {
      const metadata = await lstat(path);
      if (!metadata.isFile()) {
        verificationFailure(code, "config_loading", "Доверенная конфигурация должна быть обычным файлом.", {
          path,
          expected: "regular file",
          actual: "non-file",
        });
      }
      assertFileWithinLimit(
        metadata,
        path,
        CONFIG_FILE_LIMIT_BYTES,
        "CONFIG_FILE_TOO_LARGE",
        "config_loading",
      );
      bytes = await readFile(path);
      consumePlanningRead(bytes.length, path);
    }
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError({
      code,
      stage: "config_loading",
      path,
      message: `Не удалось прочитать ${path}.`,
      actual: error?.message ?? String(error),
      cause: error,
    });
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch (error) {
    throw new VerificationError({
      code: "CONFIG_JSON_INVALID",
      stage: "config_loading",
      path,
      message: `Файл ${path} содержит некорректный JSON.`,
      actual: error?.message ?? String(error),
      cause: error,
    });
  }
}

async function gitFile(
  repositoryRoot,
  base,
  repositoryRelativePath,
  {
    missingCode = "CONFIG_AT_BASE_MISSING",
    missingMessage = `В base отсутствует ${repositoryRelativePath}.`,
    missingNext = "",
  } = {},
) {
  portablePath(repositoryRelativePath, "git.path", { allowDot: false });
  let result;
  try {
    result = await git(
      repositoryRoot,
      ["show", `${base}:${repositoryRelativePath}`],
      {
        allowFailure: true,
        stdoutMode: "buffer",
        stdoutLimitBytes: CONFIG_FILE_LIMIT_BYTES,
      },
    );
  } catch (error) {
    if (error instanceof VerificationError && error.code === "GIT_OUTPUT_LIMIT") {
      verificationFailure("CONFIG_FILE_TOO_LARGE", "config_loading", "Версия конфигурации из Git превышает безопасный предел.", {
        path: `${base}:${repositoryRelativePath}`,
        expected: `не более ${CONFIG_FILE_LIMIT_BYTES} байт`,
        actual: error.actual,
        details: error.details,
      });
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    verificationFailure(missingCode, "config_loading", missingMessage, {
      path: repositoryRelativePath,
      actual: result.stderr.trim() || "missing",
      details: { base },
      next: missingNext,
    });
  }
  try {
    return {
      value: JSON.parse(result.stdoutBuffer.toString("utf8")),
      bytes: result.stdoutBuffer,
    };
  } catch (error) {
    throw new VerificationError({
      code: "CONFIG_JSON_INVALID",
      stage: "config_loading",
      path: repositoryRelativePath,
      message: `Версия ${repositoryRelativePath} из base содержит некорректный JSON.`,
      actual: error?.message ?? String(error),
      details: { base },
      cause: error,
    });
  }
}

async function discoverGitRoot(path) {
  const result = await git(path, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (result.exitCode !== 0) return null;
  return await realpath(result.stdout.trim());
}

const REGISTRATION_STABLE_FIELDS = Object.freeze(["root", "manifest", "status", "enrollment"]);

function registrationFields(entry, fields) {
  if (entry === undefined) return null;
  return Object.fromEntries(fields.map((field) => [field, entry[field] ?? null]));
}

function isRevisionOnlyTransition(baseEntry, candidateEntry) {
  return baseEntry?.enrollment === "enrolled"
    && candidateEntry?.enrollment === "enrolled"
    && baseEntry.revision !== candidateEntry.revision
    && canonicalJson(registrationFields(baseEntry, REGISTRATION_STABLE_FIELDS))
      === canonicalJson(registrationFields(candidateEntry, REGISTRATION_STABLE_FIELDS));
}

/**
 * Git-владелец registry определяется только по расположению самого файла.
 * Содержимое candidate registry не участвует в выборе trust root.
 */
async function loadRegistryPair({
  registryPath,
  base,
  registryBase,
  selectedRepository,
  explicitRepositoryRoot,
}) {
  const lexicalRegistryPath = resolve(registryPath);
  let lexicalMetadata;
  try {
    lexicalMetadata = await lstat(lexicalRegistryPath);
  } catch (error) {
    throw new VerificationError({
      code: "CONFIG_READ_FAILED",
      stage: "config_loading",
      path: lexicalRegistryPath,
      message: `Workspace config ${lexicalRegistryPath} отсутствует.`,
      actual: error?.message ?? String(error),
      cause: error,
    });
  }
  if (lexicalMetadata.isSymbolicLink()) {
    verificationFailure("CONFIG_SYMLINK_UNSUPPORTED", "config_loading", "Workspace registry не может быть symbolic link.", {
      path: lexicalRegistryPath,
      next: "Храни канонический registry обычным файлом внутри checkout владельца.",
    });
  }
  if (!lexicalMetadata.isFile()) {
    verificationFailure("CONFIG_READ_FAILED", "config_loading", "Workspace registry должен быть обычным файлом.", {
      path: lexicalRegistryPath,
      expected: "regular file",
      actual: "non-file",
    });
  }
  const registryGitRoot = await discoverGitRoot(dirname(lexicalRegistryPath));
  if (registryGitRoot === null) {
    verificationFailure("REGISTRY_NOT_IN_GIT", "config_loading", "Workspace registry не принадлежит Git-репозиторию.", {
      path: lexicalRegistryPath,
      next: "Помести registry внутрь checkout его канонического владельца.",
    });
  }
  const registryLexicalRoot = await lexicalCheckoutRoot(lexicalRegistryPath, registryGitRoot);
  const relativePath = relative(registryLexicalRoot, lexicalRegistryPath).split(sep).join("/");
  await lstatPathWithoutSymlinks(registryLexicalRoot, relativePath, "registry");
  let absoluteRegistryPath;
  try {
    absoluteRegistryPath = await realpath(lexicalRegistryPath);
  } catch (error) {
    throw new VerificationError({
      code: "CONFIG_READ_FAILED",
      stage: "config_loading",
      path: lexicalRegistryPath,
      message: `Workspace config ${lexicalRegistryPath} отсутствует.`,
      actual: error?.message ?? String(error),
      cause: error,
    });
  }
  if (escapesRoot(registryGitRoot, absoluteRegistryPath)) {
    verificationFailure("CONFIG_OUTSIDE_REPOSITORY", "config_loading", "Workspace registry разрешается вне Git checkout владельца.", {
      path: lexicalRegistryPath,
      expected: registryGitRoot,
      actual: absoluteRegistryPath,
    });
  }
  const effectiveRegistryBase = registryBase ?? (explicitRepositoryRoot === registryGitRoot ? base : null);
  if (effectiveRegistryBase === null) {
    verificationFailure("BASE_REGISTRY_REQUIRED", "config_loading", "Для другого selected repository нужен --registry-base.", {
      path: absoluteRegistryPath,
      expected: "полный SHA владельца workspace config",
      actual: "missing",
      next: "Передай полный SHA workspace config owner через --registry-base.",
    });
  }
  if (!FULL_SHA_PATTERN.test(String(effectiveRegistryBase ?? ""))) {
    verificationFailure("BASE_REGISTRY_REQUIRED", "config_loading", "--registry-base должен быть полным SHA коммита.", {
      expected: "40 or 64 lower-case hex characters",
      actual: String(effectiveRegistryBase ?? "missing"),
    });
  }
  const exact = await git(registryGitRoot, ["rev-parse", "--verify", `${effectiveRegistryBase}^{commit}`], { allowFailure: true });
  if (exact.exitCode !== 0 || exact.stdout.trim() !== effectiveRegistryBase) {
    verificationFailure("BASE_REGISTRY_REQUIRED", "config_loading", "--registry-base недоступен владельцу workspace config.", {
      path: absoluteRegistryPath,
      expected: effectiveRegistryBase,
      actual: exact.stdout.trim() || "commit unavailable",
    });
  }
  const baseAuthority = await verifiedBaseAuthority(
    registryGitRoot,
    effectiveRegistryBase,
    "REGISTRY_BASE_UNTRUSTED",
  );
  const baseRecord = await gitFile(registryGitRoot, effectiveRegistryBase, relativePath, {
    missingCode: "BOOTSTRAP_REQUIRED",
    missingMessage: "В доверенной базе владельца ещё нет workspace registry.",
    missingNext: "Сначала добавь и выпусти workspace registry отдельным bootstrap-изменением.",
  });
  const basePath = `${effectiveRegistryBase}:${relativePath}`;
  const baseValue = validateWorkspaceRegistry(baseRecord.value, { path: basePath });
  const candidateRecord = await readJson(absoluteRegistryPath, "CONFIG_READ_FAILED", {
    root: registryGitRoot,
    label: "workspace-registry",
  });
  const candidate = validateWorkspaceRegistry(candidateRecord.value, { path: absoluteRegistryPath });
  if (baseValue.ownerRepository !== candidate.ownerRepository) {
    verificationFailure("REGISTRY_OWNER_CHANGED", "config_validation", "Candidate изменяет владельца workspace registry.", {
      path: `${absoluteRegistryPath}#ownerRepository`,
      expected: baseValue.ownerRepository,
      actual: candidate.ownerRepository,
    });
  }
  const registrationFields = ["root", "manifest", "revision", "status", "enrollment"];
  for (const [repositoryId, baseRegistration] of Object.entries(baseValue.repositories)) {
    if (baseRegistration.enrollment !== "enrolled") continue;
    const candidateRegistration = candidate.repositories[repositoryId];
    const expected = Object.fromEntries(
      registrationFields.map((field) => [field, baseRegistration[field] ?? null]),
    );
    const actual = candidateRegistration === undefined
      ? null
      : Object.fromEntries(
          registrationFields.map((field) => [field, candidateRegistration[field] ?? null]),
        );
    const allowedRevisionTransition = selectedRepository === baseValue.ownerRepository
      && repositoryId !== baseValue.ownerRepository
      && isRevisionOnlyTransition(baseRegistration, candidateRegistration);
    if (
      actual === null
      || (canonicalJson(expected) !== canonicalJson(actual) && !allowedRevisionTransition)
    ) {
      verificationFailure("REPOSITORY_REGISTRATION_CHANGED", "config_validation", "Candidate изменяет доверенную регистрацию подключённого репозитория.", {
        path: `repositories.${repositoryId}`,
        expected: canonicalJson(expected),
        actual: canonicalJson(actual),
        details: { repository: repositoryId },
      });
    }
  }
  for (const [source, registry] of [["base", baseValue], ["candidate", candidate]]) {
    const ownerEntry = registry.repositories[registry.ownerRepository];
    if (ownerEntry.status !== "active" || ownerEntry.enrollment !== "enrolled") {
      verificationFailure("REGISTRY_OWNER_INVALID", "config_validation", "Владелец registry должен быть активным подключённым репозиторием.", {
        path: `${source}.repositories.${registry.ownerRepository}`,
        expected: "status=active, enrollment=enrolled",
        actual: `status=${ownerEntry.status}, enrollment=${ownerEntry.enrollment}`,
      });
    }
    const declaredOwnerRoot = await repositoryRootFromEntry(
      dirname(absoluteRegistryPath),
      registry.ownerRepository,
      ownerEntry,
    );
    if (declaredOwnerRoot !== registryGitRoot) {
      verificationFailure("REGISTRY_OWNER_ROOT_MISMATCH", "config_validation", "Owner entry не совпадает с Git-владельцем registry-файла.", {
        path: `${source}.repositories.${registry.ownerRepository}.root`,
        expected: registryGitRoot,
        actual: declaredOwnerRoot,
      });
    }
  }
  if (selectedRepository !== candidate.ownerRepository && !candidateRecord.bytes.equals(baseRecord.bytes)) {
    verificationFailure("REGISTRY_CONFOUNDER", "config_loading", "Workspace registry изменён вне задачи его владельца.", {
      path: absoluteRegistryPath,
      expected: sha256(baseRecord.bytes),
      actual: sha256(candidateRecord.bytes),
      next: `Верни registry к ${effectiveRegistryBase} либо строй план в отдельной задаче ${candidate.ownerRepository}.`,
      details: {
        selectedRepository,
        ownerRepository: candidate.ownerRepository,
        registryBase: effectiveRegistryBase,
      },
    });
  }
  return {
    base: baseValue,
    candidate,
    baseBytes: baseRecord.bytes,
    candidateBytes: candidateRecord.bytes,
    path: absoluteRegistryPath,
    directory: dirname(absoluteRegistryPath),
    ownerRoot: registryGitRoot,
    registryBase: effectiveRegistryBase,
    baseAuthority,
  };
}

async function repositoryRootFromEntry(registryDirectory, repositoryId, entry, { required = true } = {}) {
  const lexical = resolve(registryDirectory, entry.root);
  let resolved;
  try {
    resolved = await realpath(lexical);
  } catch (error) {
    if (!required && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return null;
    throw new VerificationError({
      code: "DOWNSTREAM_MISSING",
      stage: "planning",
      path: lexical,
      message: `Checkout ${repositoryId} отсутствует.`,
      actual: error?.message ?? String(error),
      details: { repository: repositoryId },
      cause: error,
    });
  }
  const topLevel = await discoverGitRoot(resolved);
  if (topLevel === null || topLevel !== resolved) {
    verificationFailure("REPOSITORY_ROOT_NOT_GIT_TOPLEVEL", "config_validation", `Root ${repositoryId} не является корнем Git checkout.`, {
      path: lexical,
      expected: topLevel ?? "Git checkout",
      actual: resolved,
      details: { repository: repositoryId },
    });
  }
  return resolved;
}

async function loadCandidateManifest(registryDirectory, repositoryId, entry, { required = true } = {}) {
  if (entry.enrollment !== "enrolled") return null;
  const root = await repositoryRootFromEntry(registryDirectory, repositoryId, entry, { required });
  if (root === null) return null;
  const manifestLexical = resolve(root, entry.manifest);
  let manifestMetadata;
  try {
    manifestMetadata = await lstatPathWithoutSymlinks(root, entry.manifest, "manifest");
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    if (!required && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return null;
    throw new VerificationError({
      code: "MANIFEST_MISSING",
      stage: "config_loading",
      path: manifestLexical,
      message: `Manifest репозитория ${repositoryId} отсутствует.`,
      actual: error?.message ?? String(error),
      cause: error,
    });
  }
  if (!manifestMetadata.isFile()) {
    verificationFailure("CONFIG_READ_FAILED", "config_loading", `Manifest репозитория ${repositoryId} должен быть обычным файлом.`, {
      path: manifestLexical,
      expected: "regular file",
      actual: "non-file",
    });
  }
  let manifestReal;
  try {
    manifestReal = await realpath(manifestLexical);
  } catch (error) {
    if (!required && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return null;
    throw new VerificationError({
      code: "MANIFEST_MISSING",
      stage: "config_loading",
      path: manifestLexical,
      message: `Manifest репозитория ${repositoryId} отсутствует.`,
      actual: error?.message ?? String(error),
      cause: error,
    });
  }
  if (escapesRoot(root, manifestReal)) {
    verificationFailure("MANIFEST_OUTSIDE_REPOSITORY", "config_loading", `Manifest ${repositoryId} выходит за границы checkout.`, {
      path: manifestReal,
      expected: root,
      actual: manifestReal,
    });
  }
  const record = await readJson(manifestReal, "CONFIG_READ_FAILED", {
    root,
    label: `manifest:${repositoryId}`,
  });
  const manifest = validateRepositoryManifest(record.value, { path: manifestReal, source: "candidate" });
  if (manifest.repository !== repositoryId) {
    verificationFailure("REPOSITORY_ID_MISMATCH", "config_validation", `Manifest объявляет ${manifest.repository} вместо ${repositoryId}.`, {
      path: `${manifestReal}#repository`,
      expected: repositoryId,
      actual: manifest.repository,
    });
  }
  if (manifest.status !== entry.status) {
    verificationFailure("REPOSITORY_STATUS_MISMATCH", "config_validation", `Статус manifest репозитория ${repositoryId} не совпадает с registry.`, {
      path: `${manifestReal}#status`,
      expected: entry.status,
      actual: manifest.status,
      details: { repository: repositoryId, source: "candidate" },
    });
  }
  return { manifest, bytes: record.bytes, path: manifestReal, root };
}

async function loadManifestAtRevision(registryDirectory, repositoryId, entry, revision, { required = true } = {}) {
  if (entry.enrollment !== "enrolled") return null;
  const root = await repositoryRootFromEntry(registryDirectory, repositoryId, entry, { required });
  if (root === null) return null;
  const exactRevision = await exactBaseSha(root, revision);
  const record = await gitFile(root, exactRevision, entry.manifest, {
    missingCode: "DOWNSTREAM_MANIFEST_UNTRUSTED",
    missingMessage: `В доверенной revision репозитория ${repositoryId} отсутствует manifest.`,
    missingNext: "Исправь pinned revision в registry и повтори построение плана.",
  });
  const manifestPath = `${exactRevision}:${entry.manifest}`;
  const manifest = validateRepositoryManifest(record.value, {
    path: manifestPath,
    source: "trusted-revision",
  });
  if (manifest.repository !== repositoryId) {
    verificationFailure("REPOSITORY_ID_MISMATCH", "config_validation", `Manifest объявляет ${manifest.repository} вместо ${repositoryId}.`, {
      path: `${manifestPath}#repository`,
      expected: repositoryId,
      actual: manifest.repository,
    });
  }
  if (manifest.status !== entry.status) {
    verificationFailure("REPOSITORY_STATUS_MISMATCH", "config_validation", `Статус manifest репозитория ${repositoryId} не совпадает с registry.`, {
      path: `${manifestPath}#status`,
      expected: entry.status,
      actual: manifest.status,
      details: { repository: repositoryId, source: "trusted-revision" },
    });
  }
  return { manifest, bytes: record.bytes, path: manifestPath, root, revision: exactRevision };
}

/**
 * Новое enrollment доверяется только после проверки уже зафиксированного и
 * чистого checkout. Иначе owner registry мог бы объявить готовым контракт,
 * который планировщик ещё ни разу не прочитал.
 */
async function preflightEnrollmentTransitions(registries) {
  const transitions = new Map();
  for (const [repositoryId, candidateEntry] of Object.entries(registries.candidate.repositories)) {
    const baseEntry = registries.base.repositories[repositoryId];
    if (candidateEntry.enrollment !== "enrolled" || baseEntry?.enrollment === "enrolled") continue;
    const candidateRecord = await loadCandidateManifest(
      registries.directory,
      repositoryId,
      candidateEntry,
    );
    validateRepositoryRelationReferences({
      repository: repositoryId,
      manifest: candidateRecord.manifest,
      referenceRelations: registries.candidate.relations,
      consumerRelations: registries.candidate.relations,
      source: "candidate-enrollment",
    });
    const trustedRevision = repositoryId === registries.candidate.ownerRepository
      ? registries.registryBase
      : candidateEntry.revision;
    const head = await repositoryHead(candidateRecord.root);
    if (head !== trustedRevision) {
      verificationFailure("ENROLLMENT_NOT_READY", "enrollment_preflight", "HEAD подключаемого репозитория не совпадает с закреплённой revision.", {
        path: candidateRecord.root,
        expected: trustedRevision,
        actual: head,
        details: { repository: repositoryId },
        next: "Переключи чистый checkout на закреплённый commit либо исправь revision до подключения.",
      });
    }
    const committedManifest = await gitFile(
      candidateRecord.root,
      trustedRevision,
      candidateEntry.manifest,
      {
        missingCode: "ENROLLMENT_NOT_READY",
        missingMessage: `Manifest подключаемого репозитория ${repositoryId} отсутствует в HEAD.`,
        missingNext: "Сначала выпусти manifest в репозитории, затем отдельной задачей включи enrollment.",
      },
    );
    if (!committedManifest.bytes.equals(candidateRecord.bytes)) {
      verificationFailure("ENROLLMENT_NOT_READY", "enrollment_preflight", "Рабочая версия manifest не совпадает с HEAD подключаемого репозитория.", {
        path: candidateRecord.path,
        expected: sha256(committedManifest.bytes),
        actual: sha256(candidateRecord.bytes),
        details: { repository: repositoryId, head },
        next: "Сначала выпусти точную версию manifest, затем отдельной задачей включи enrollment.",
      });
    }
    const snapshot = await collectGitChangesCore({ repositoryRoot: candidateRecord.root, base: trustedRevision });
    if (snapshot.changes.length > 0) {
      verificationFailure("ENROLLMENT_NOT_READY", "enrollment_preflight", "Подключаемый репозиторий содержит незаписанные изменения.", {
        path: candidateRecord.root,
        expected: "clean checkout with manifest committed at HEAD",
        actual: snapshot.pathStates.map((item) => item.path).join(", "),
        details: { repository: repositoryId, snapshotFingerprint: snapshot.fingerprint },
        next: "Сначала зафиксируй и проверь manifest в репозитории, затем отдельной задачей включи enrollment.",
      });
    }
    transitions.set(repositoryId, {
      pair: { base: null, candidate: candidateRecord },
      snapshot,
      evidence: {
        repository: repositoryId,
        repositoryRoot: candidateRecord.root,
        head: trustedRevision,
        revision: trustedRevision,
        manifestPath: candidateEntry.manifest,
        manifestSha256: sha256(candidateRecord.bytes),
        snapshotFingerprint: snapshot.fingerprint,
      },
    });
  }
  return transitions;
}

async function revisionTransitionDirection(root, baseRevision, candidateRevision) {
  const forward = await git(
    root,
    ["merge-base", "--is-ancestor", baseRevision, candidateRevision],
    { allowFailure: true },
  );
  if (forward.exitCode === 0) return "forward";
  if (forward.exitCode !== 1) {
    verificationFailure("REVISION_TRANSITION_CHECK_FAILED", "revision_preflight", "Git не подтвердил родство старой и новой revision.", {
      path: root,
      expected: "git merge-base --is-ancestor exit 0 or 1",
      actual: forward.stderr.trim() || `exit ${forward.exitCode}`,
      details: { baseRevision, candidateRevision, direction: "forward" },
    });
  }
  const rollback = await git(
    root,
    ["merge-base", "--is-ancestor", candidateRevision, baseRevision],
    { allowFailure: true },
  );
  if (rollback.exitCode === 0) return "rollback";
  if (rollback.exitCode !== 1) {
    verificationFailure("REVISION_TRANSITION_CHECK_FAILED", "revision_preflight", "Git не подтвердил родство старой и новой revision.", {
      path: root,
      expected: "git merge-base --is-ancestor exit 0 or 1",
      actual: rollback.stderr.trim() || `exit ${rollback.exitCode}`,
      details: { baseRevision, candidateRevision, direction: "rollback" },
    });
  }
  verificationFailure("REVISION_TRANSITION_DIVERGED", "revision_preflight", "Старая и новая revision принадлежат расходящимся ветвям.", {
    path: root,
    expected: "fast-forward or rollback to ancestor",
    actual: `${baseRevision} -> ${candidateRevision}`,
  });
}

/**
 * Проверяет только переходы ревизий, объявленные владельцем workspace registry.
 * Допускается fast-forward или откат к предку; checkout обязан находиться на
 * новой закреплённой ревизии, быть чистым и содержать обе версии manifest.
 */
async function preflightRevisionTransitions(registries, selectedRepository) {
  const transitions = new Map();
  if (selectedRepository !== registries.base.ownerRepository) return transitions;
  for (const [repositoryId, baseEntry] of Object.entries(registries.base.repositories)) {
    const candidateEntry = registries.candidate.repositories[repositoryId];
    if (!isRevisionOnlyTransition(baseEntry, candidateEntry)) continue;
    const root = await repositoryRootFromEntry(registries.directory, repositoryId, candidateEntry);
    await Promise.all([
      exactBaseSha(root, baseEntry.revision),
      exactBaseSha(root, candidateEntry.revision),
    ]);
    const head = await repositoryHead(root);
    if (head !== candidateEntry.revision) {
      verificationFailure("REVISION_TRANSITION_NOT_READY", "revision_preflight", "Checkout перехода revision не находится на новой закреплённой версии.", {
        path: root,
        expected: candidateEntry.revision,
        actual: head,
        details: { repository: repositoryId },
      });
    }
    const targetAuthority = await verifiedBaseAuthority(
      root,
      candidateEntry.revision,
      "REVISION_TARGET_UNTRUSTED",
    );
    const direction = await revisionTransitionDirection(
      root,
      baseEntry.revision,
      candidateEntry.revision,
    );
    const [baseRecord, candidateRecord, cleanSnapshot] = await Promise.all([
      loadManifestAtRevision(
        registries.directory,
        repositoryId,
        baseEntry,
        baseEntry.revision,
      ),
      loadManifestAtRevision(
        registries.directory,
        repositoryId,
        candidateEntry,
        candidateEntry.revision,
      ),
      collectGitChangesCore({ repositoryRoot: root, base: candidateEntry.revision }),
    ]);
    if (cleanSnapshot.changes.length > 0) {
      verificationFailure("REVISION_TRANSITION_NOT_READY", "revision_preflight", "Checkout новой revision содержит незаписанные изменения.", {
        path: root,
        expected: `clean checkout at ${candidateEntry.revision}`,
        actual: cleanSnapshot.pathStates.map((item) => item.path).join(", "),
        details: { repository: repositoryId, snapshotFingerprint: cleanSnapshot.fingerprint },
      });
    }
    const snapshot = await collectGitChangesCore({
      repositoryRoot: root,
      base: baseEntry.revision,
    });
    validateRepositoryRelationReferences({
      repository: repositoryId,
      manifest: baseRecord.manifest,
      referenceRelations: registries.base.relations,
      consumerRelations: registries.base.relations,
      source: "revision-base",
    });
    validateRepositoryRelationReferences({
      repository: repositoryId,
      manifest: candidateRecord.manifest,
      referenceRelations: registries.candidate.relations,
      consumerRelations: registries.candidate.relations,
      source: "revision-candidate",
    });
    transitions.set(repositoryId, {
      pair: { base: baseRecord, candidate: candidateRecord },
      snapshot,
      stabilitySnapshot: cleanSnapshot,
      authority: targetAuthority,
      evidence: {
        repository: repositoryId,
        repositoryRoot: root,
        baseRevision: baseEntry.revision,
        candidateRevision: candidateEntry.revision,
        direction,
        baseManifestSha256: sha256(baseRecord.bytes),
        candidateManifestSha256: sha256(candidateRecord.bytes),
        targetAuthority,
        cleanSnapshotFingerprint: cleanSnapshot.fingerprint,
        snapshotFingerprint: snapshot.fingerprint,
      },
    });
  }
  return transitions;
}

async function loadSelectedManifestPair({ registryDirectory, repositoryId, baseEntry, candidateEntry, base }) {
  const candidateRecord = await loadCandidateManifest(registryDirectory, repositoryId, candidateEntry);
  if (candidateRecord === null) {
    verificationFailure("REPOSITORY_NOT_ENROLLED", "planning", `Репозиторий ${repositoryId} не подключён к выбору проверок.`, {
      details: { repository: repositoryId, enrollment: candidateEntry.enrollment },
    });
  }
  const relativeManifest = candidateEntry.manifest;
  let historical;
  try {
    historical = await gitFile(candidateRecord.root, base, relativeManifest, { missingCode: "BOOTSTRAP_REQUIRED" });
  } catch (error) {
    if (error instanceof VerificationError && error.code === "BOOTSTRAP_REQUIRED") {
      error.message = `В base выбранного репозитория нет ${relativeManifest}; нужен отдельный bootstrap.`;
      error.next = "Сначала добавь и выпусти manifest без использования селектора для этого изменения.";
    }
    throw error;
  }
  const baseManifest = validateRepositoryManifest(historical.value, {
    path: `${base}:${relativeManifest}`,
    source: "base",
  });
  if (baseManifest.repository !== repositoryId) {
    verificationFailure("REPOSITORY_ID_MISMATCH", "config_validation", "Base manifest принадлежит другому репозиторию.", {
      path: `${base}:${relativeManifest}#repository`,
      expected: repositoryId,
      actual: baseManifest.repository,
    });
  }
  if (baseEntry === undefined || baseManifest.status !== baseEntry.status) {
    verificationFailure("REPOSITORY_STATUS_MISMATCH", "config_validation", `Статус base manifest репозитория ${repositoryId} не совпадает с base registry.`, {
      path: `${base}:${relativeManifest}#status`,
      expected: baseEntry?.status ?? "registered repository",
      actual: baseManifest.status,
      details: { repository: repositoryId, source: "base" },
    });
  }
  return {
    base: { manifest: baseManifest, bytes: historical.bytes, path: `${base}:${relativeManifest}`, root: candidateRecord.root },
    candidate: candidateRecord,
  };
}

function matchingAreas(manifest, path) {
  return Object.entries(manifest.areas)
    .filter(([, area]) => area.paths.some((pattern) => globMatches(pattern, path)))
    .map(([id]) => id);
}

function matchingContracts(contracts, path) {
  return Object.entries(contracts)
    .filter(([, contract]) => contract.paths.some((pattern) => globMatches(pattern, path)))
    .map(([id]) => id);
}

function contractOwnedByAreas(manifest, contract, areaIds) {
  return contract.paths.every((contractPattern) => [...areaIds].some((areaId) => (
    manifest.areas[areaId].paths.some(
      (areaPattern) => areaPatternCoversSurface(areaPattern, contractPattern),
    )
  )));
}

function changedEndpoints(snapshot) {
  const endpoints = new Map();
  const add = (path, manifestSource, role, change) => {
    const key = `${manifestSource}:${role}:${path}`;
    const endpoint = endpoints.get(key) ?? {
      path,
      manifestSource,
      role,
      statuses: [],
      provenance: [],
    };
    endpoint.statuses = [...new Set([...endpoint.statuses, change.status])].sort();
    endpoint.provenance = [...new Set([...endpoint.provenance, ...change.provenance])].sort();
    endpoints.set(key, endpoint);
  };
  for (const change of snapshot.changes) {
    if (change.status === "renamed" || change.status === "copied") {
      add(change.oldPath, "base", "old", change);
      add(change.newPath, "candidate", "new", change);
    } else if (change.status === "deleted") {
      add(change.path, "base", "old", change);
    } else if (new Set(["modified", "type_changed", "unmerged"]).has(change.status)) {
      add(change.path, "base", "old", change);
      add(change.path, "candidate", "new", change);
    } else {
      add(change.path, "candidate", "new", change);
    }
  }
  const states = new Map(snapshot.pathStates.map((item) => [item.path, item]));
  return [...endpoints.values()].filter((endpoint) => {
    const state = states.get(endpoint.path);
    const version = endpoint.manifestSource === "base" ? state?.base : state?.candidate;
    return version !== undefined && version.type !== "missing";
  });
}

function reverseDependentAreas(manifest, initial) {
  const reverse = new Map(Object.keys(manifest.areas).map((id) => [id, []]));
  for (const [consumer, area] of Object.entries(manifest.areas)) {
    for (const dependency of area.dependsOn) reverse.get(dependency).push(consumer);
  }
  const selected = new Set(initial);
  const queue = [...initial];
  while (queue.length) {
    const current = queue.shift();
    for (const consumer of reverse.get(current) ?? []) {
      if (selected.has(consumer)) continue;
      selected.add(consumer);
      queue.push(consumer);
    }
  }
  return selected;
}

/**
 * Схлопывает одинаковое действие base/candidate в один вариант с provenance
 * `both`. Различающиеся определения сохраняет отдельно, чтобы план не потерял
 * проверку ни старого, ни нового контракта.
 */
function actionVariants(repository, actionId, manifestPair, reasons) {
  const baseDefinition = manifestPair?.base?.manifest?.actions?.[actionId];
  const candidateDefinition = manifestPair?.candidate?.manifest?.actions?.[actionId];
  if (baseDefinition === undefined && candidateDefinition === undefined) {
    verificationFailure("UNKNOWN_ACTION", "planning", `Действие ${repository}:${actionId} отсутствует в обеих версиях manifest.`, {
      details: { repository, action: actionId },
    });
  }
  if (baseDefinition !== undefined && candidateDefinition !== undefined && canonicalJson(baseDefinition) === canonicalJson(candidateDefinition)) {
    return [{
      key: `${repository}:${actionId}:both`,
      repository,
      id: actionId,
      provenance: "both",
      sources: ["base", "candidate"],
      definition: candidateDefinition,
      reasons,
    }];
  }
  const variants = [];
  if (baseDefinition !== undefined) {
    variants.push({
      key: `${repository}:${actionId}:base`,
      repository,
      id: actionId,
      provenance: "base",
      sources: ["base"],
      definition: baseDefinition,
      reasons,
    });
  }
  if (candidateDefinition !== undefined) {
    variants.push({
      key: `${repository}:${actionId}:candidate`,
      repository,
      id: actionId,
      provenance: "candidate",
      sources: ["candidate"],
      definition: candidateDefinition,
      reasons,
    });
  }
  return variants;
}

function unionRelationVariants(baseRegistry, candidateRegistry) {
  const baseById = new Map(baseRegistry.relations.map((relation) => [relation.id, relation]));
  const candidateById = new Map(candidateRegistry.relations.map((relation) => [relation.id, relation]));
  const variants = [];
  for (const id of [...new Set([...baseById.keys(), ...candidateById.keys()])].sort()) {
    const base = baseById.get(id);
    const candidate = candidateById.get(id);
    // Relation JSON может совпадать, пока export/input surfaces различаются.
    // Поэтому исторические варианты никогда не схлопываются до проверки surfaces.
    if (base) variants.push({ relation: base, provenance: "base", sources: ["base"] });
    if (candidate) variants.push({ relation: candidate, provenance: "candidate", sources: ["candidate"] });
  }
  return variants;
}

function validateRepositoryRelationReferences({ repository, manifest, referenceRelations, consumerRelations, source }) {
  for (const relation of referenceRelations) {
    if (
      relation.producer.repository === repository
      && relation.producer.path !== undefined
      && !Object.values(manifest.areas).some((area) => area.paths.some(
        (areaPattern) => areaPatternCoversSurface(areaPattern, relation.producer.path),
      ))
    ) {
      verificationFailure("CONTRACT_SURFACE_UNOWNED", "config_validation", `Producer path связи ${relation.id} не принадлежит ни одной области.`, {
        path: `${source}.relations.${relation.id}.producer.path`,
        actual: relation.producer.path,
        details: { repository, relation: relation.id, source },
      });
    }
    if (
      relation.producer.repository === repository
      && relation.producer.export !== undefined
      && !Object.hasOwn(manifest.exports, relation.producer.export)
    ) {
      verificationFailure("UNKNOWN_EXPORT_REF", "config_validation", `Связь ${relation.id} ссылается на неизвестный export.`, {
        path: `${source}.relations.${relation.id}.producer.export`,
        actual: relation.producer.export,
        details: { repository, source },
      });
    }
    if (
      relation.consumer.repository === repository
      && relation.consumer.input !== undefined
      && !Object.hasOwn(manifest.inputs, relation.consumer.input)
    ) {
      verificationFailure("UNKNOWN_INPUT_REF", "config_validation", `Связь ${relation.id} ссылается на неизвестный input.`, {
        path: `${source}.relations.${relation.id}.consumer.input`,
        actual: relation.consumer.input,
        details: { repository, source },
      });
    }
    if (
      relation.verifier.kind === "action"
      && relation.verifier.repository === repository
      && !Object.hasOwn(manifest.actions, relation.verifier.action)
    ) {
      verificationFailure("UNKNOWN_ACTION_REF", "config_validation", `Verifier связи ${relation.id} ссылается на неизвестное действие.`, {
        path: `${source}.relations.${relation.id}.verifier.action`,
        actual: relation.verifier.action,
        details: { repository, source },
      });
    }
  }
  for (const exportId of Object.keys(manifest.exports)) {
    if (!consumerRelations.some((relation) => relation.producer.repository === repository && relation.producer.export === exportId)) {
      verificationFailure("EXPORT_WITHOUT_CONSUMER", "config_validation", `Export ${repository}:${exportId} не имеет consumer relation.`, {
        path: `${source}.exports.${exportId}`,
        details: { repository, export: exportId, source },
      });
    }
  }
}

function endpointPatterns(endpoint, side, manifest) {
  if (endpoint.path !== undefined) return [endpoint.path];
  const collection = side === "producer" ? manifest.exports : manifest.inputs;
  const name = side === "producer" ? endpoint.export : endpoint.input;
  return collection?.[name]?.paths ?? null;
}

function patternsPotentiallyOverlap(left, right) {
  if (left === right) return true;
  const leftConcrete = !/[*?[\]]/u.test(left);
  const rightConcrete = !/[*?[\]]/u.test(right);
  if (leftConcrete) return globMatches(right, left);
  if (rightConcrete) return globMatches(left, right);
  const leftPrefix = left.split(/[*?[\]]/u, 1)[0];
  const rightPrefix = right.split(/[*?[\]]/u, 1)[0];
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

/**
 * Дополняет существующий снимок точными путями артефактов exact-copy.
 * Функция намеренно обновляет pathStates, контекст финальной сверки и fingerprint,
 * чтобы добавленные после основного Git-обхода пути участвовали в drift-защите.
 */
async function includeArtifactPathsInSnapshot(snapshot, paths) {
  const context = snapshotStabilityContexts.get(snapshot);
  if (context === undefined) {
    verificationFailure("CANDIDATE_DRIFT", "git_snapshot", "Отсутствует контекст exact-copy снимка.", {
      path: snapshot.repositoryRoot,
    });
  }
  const existing = new Map(snapshot.pathStates.map((state) => [state.path, state]));
  const additions = [...new Set(paths)].filter((path) => !existing.has(path)).sort();
  if (additions.length > 0) {
    const baseStates = await basePathStates(snapshot.repositoryRoot, snapshot.baseSha, additions);
    const captured = await mapWithConcurrency(
      additions,
      PATH_STATE_CONCURRENCY,
      async (path) => ({
        path,
        base: baseStates.get(path),
        candidate: await pathState(snapshot.repositoryRoot, path),
      }),
    );
    for (const state of captured) existing.set(state.path, state);
    snapshot.pathStates = [...existing.values()].sort((left, right) => left.path.localeCompare(right.path));
  }
  context.endpointPaths = [...new Set([...context.endpointPaths, ...paths])].sort();
  context.expected.candidatePathStates = context.endpointPaths.map((path) => ({
    path,
    candidate: existing.get(path)?.candidate ?? { type: "missing" },
  }));
  const { fingerprint: _oldFingerprint, ...snapshotCore } = snapshot;
  snapshot.fingerprint = sha256(canonicalJson(snapshotCore));
}

function exactCopyArtifact(snapshot, path, source) {
  const record = snapshot.pathStates.find((state) => state.path === path);
  const state = source === "base" ? record?.base : record?.candidate;
  if (state === undefined || state.type === "missing") return { path, state: "missing" };
  if (state.type === "symlink") {
    return { path, state: "symlink", code: "EXACT_COPY_SYMLINK_UNSUPPORTED" };
  }
  if (state.type !== "file") return { path, state: "unsupported" };
  if (source === "base") {
    return {
      path,
      state: "file",
      digest: state.object,
      digestKind: "git-blob",
      executable: state.mode === "100755",
    };
  }
  return {
    path,
    state: "file",
    size: state.size,
    digest: state.sha256,
    digestKind: "sha256",
    executable: state.mode === "100755",
  };
}

/**
 * Сравнивает exact-copy по исторически согласованному source. Результат `equal`
 * или `different` требует двух обычных файлов с сопоставимыми digest и режимом;
 * symlink даёт `rejected`, а неполный или шаблонный контракт — `unresolved`.
 */
async function verifyExactCopy({
  relationVariant,
  producerManifest,
  consumerManifest,
  snapshots,
}) {
  const { relation, provenance } = relationVariant;
  const producerPatterns = endpointPatterns(relation.producer, "producer", producerManifest);
  const consumerPatterns = endpointPatterns(relation.consumer, "consumer", consumerManifest);
  if (
    producerPatterns === null
    || consumerPatterns === null
    || producerPatterns.length !== consumerPatterns.length
    || producerPatterns.some((path) => /[*?[\]]/u.test(path))
    || consumerPatterns.some((path) => /[*?[\]]/u.test(path))
  ) {
    return {
      relation: relation.id,
      provenance,
      status: "unresolved",
      code: "EXACT_COPY_UNRESOLVED",
      producerPaths: producerPatterns,
      consumerPaths: consumerPatterns,
    };
  }
  const producerSnapshot = snapshots[relation.producer.repository];
  const consumerSnapshot = snapshots[relation.consumer.repository];
  if (producerSnapshot === undefined || consumerSnapshot === undefined) {
    return {
      relation: relation.id,
      provenance,
      status: "unresolved",
      code: "EXACT_COPY_UNRESOLVED",
      producerPaths: producerPatterns,
      consumerPaths: consumerPatterns,
    };
  }
  await includeArtifactPathsInSnapshot(producerSnapshot, producerPatterns);
  await includeArtifactPathsInSnapshot(consumerSnapshot, consumerPatterns);
  const pairs = [];
  for (let index = 0; index < producerPatterns.length; index += 1) {
    const producer = exactCopyArtifact(producerSnapshot, producerPatterns[index], provenance);
    const consumer = exactCopyArtifact(consumerSnapshot, consumerPatterns[index], provenance);
    const equal = producer.state === "file"
      && consumer.state === "file"
      && producer.digestKind === consumer.digestKind
      && producer.digest === consumer.digest
      && producer.executable === consumer.executable;
    pairs.push({ producer, consumer, equal });
  }
  if (pairs.some(({ producer, consumer }) => producer.state === "symlink" || consumer.state === "symlink")) {
    return {
      relation: relation.id,
      provenance,
      status: "rejected",
      code: "EXACT_COPY_SYMLINK_UNSUPPORTED",
      pairs,
    };
  }
  if (pairs.some(({ producer, consumer }) => producer.state !== "file" || consumer.state !== "file")) {
    return {
      relation: relation.id,
      provenance,
      status: "unresolved",
      code: "EXACT_COPY_UNRESOLVED",
      pairs,
    };
  }
  return {
    relation: relation.id,
    provenance,
    status: pairs.every((pair) => pair.equal) ? "equal" : "different",
    code: pairs.every((pair) => pair.equal) ? "EXACT_COPY_EQUAL" : "EXACT_COPY_DIFFERENT",
    pairs,
  };
}

function manifestForSource(pair, source) {
  return source === "base" ? pair?.base?.manifest : pair?.candidate?.manifest;
}

function addSelectedAction(selected, repository, actionId, reason) {
  const key = `${repository}:${actionId}`;
  const record = selected.get(key) ?? { repository, actionId, reasons: [] };
  pushUniqueCanonical(record.reasons, reason);
  selected.set(key, record);
}

function addSelectedAreas(selectedAreasBySource, repository, source, areaIds) {
  const key = `${repository}:${source}`;
  const selected = selectedAreasBySource.get(key) ?? new Set();
  for (const areaId of areaIds) selected.add(areaId);
  selectedAreasBySource.set(key, selected);
}

function registryEntryForSource(registries, repository, source) {
  return (source === "base" ? registries.base : registries.candidate).repositories[repository]
    ?? registries.candidate.repositories[repository]
    ?? registries.base.repositories[repository];
}

function relationProducerSelected(
  relation,
  relationSource,
  selectedExports,
  selectedAreasBySource,
  changedBySource,
  producerManifest,
) {
  if (relation.producer.export !== undefined) {
    return selectedExports.has(`${relation.producer.repository}:${relation.producer.export}:${relationSource}`)
      || selectedExports.has(`${relation.producer.repository}:${relation.producer.export}:both`);
  }
  const paths = changedBySource.get(`${relation.producer.repository}:${relationSource}`) ?? [];
  if (paths.some((path) => globMatches(relation.producer.path, path))) return true;
  const selectedAreas = selectedAreasBySource.get(`${relation.producer.repository}:${relationSource}`);
  return selectedAreas !== undefined && contractOwnedByAreas(
    producerManifest,
    { paths: [relation.producer.path] },
    selectedAreas,
  );
}

async function repositoryHead(repositoryRoot) {
  return (await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
}

function outcomeForPlan({ changes, fallbackIssues, confounders, obligations, actions }) {
  if (confounders.length) return "blocked";
  if (obligations.some((item) => item.code.endsWith("_UNVERIFIED") || item.code.endsWith("_MISSING"))) {
    return "unverified";
  }
  if (fallbackIssues.length) return "requires_boundary";
  if (obligations.length) return "action_required";
  if (actions.length) return "planned";
  if (changes.length === 0) return "no_changes";
  return "requires_boundary";
}

/**
 * Строит неизменяемый план из исторических Git-версий конфигурации и текущего
 * checkout: выбирает изменённые и обратнозависимые области, распространяет
 * межрепозиторные связи и формирует автоматические действия, ручные обязательства
 * и безопасные границы. Ни одну выбранную команду функция не запускает.
 */
export async function buildVerificationPlan(options = {}) {
  if (planningReadBudgetStorage.getStore() === undefined) {
    return await planningReadBudgetStorage.run(
      createPlanningReadBudget(options.readLimits),
      async () => await buildVerificationPlan(options),
    );
  }
  const profile = options.profile ?? "affected";
  if (!PROFILES.has(profile)) {
    verificationFailure("PROFILE_INVALID", "planning", `Неизвестный профиль ${profile}.`, {
      expected: [...PROFILES].join(" | "),
      actual: String(profile),
    });
  }
  const repository = options.repository;
  requireRepositoryName(repository, "repository");
  const explicitRoot = await resolveRepositoryRoot(options.repositoryRoot, {
    stage: "input_validation",
    requiredCode: "REPOSITORY_ROOT_REQUIRED",
  });
  const explicitTopLevel = await discoverGitRoot(explicitRoot);
  if (explicitTopLevel === null || explicitTopLevel !== explicitRoot) {
    verificationFailure("REPOSITORY_ROOT_NOT_GIT_TOPLEVEL", "input_validation", "repositoryRoot должен быть точным корнем Git checkout.", {
      path: "repositoryRoot",
      expected: explicitTopLevel ?? "Git checkout",
      actual: explicitRoot,
    });
  }
  const base = await exactBaseSha(explicitRoot, options.base);
  const selectedBaseAuthority = await verifiedBaseAuthority(
    explicitRoot,
    base,
    "BASE_REVISION_UNTRUSTED",
  );
  if (options.registryPath === undefined) {
    verificationFailure("REGISTRY_PATH_REQUIRED", "input_validation", "Planner требует явный registryPath.", {
      path: "registryPath",
      next: "Передай канонический workspace registry отдельно от repositoryRoot.",
    });
  }
  const registryPath = resolve(options.registryPath);
  const registries = await loadRegistryPair({
    registryPath,
    base,
    registryBase: options.registryBase,
    selectedRepository: repository,
    explicitRepositoryRoot: explicitRoot,
  });
  const enrollmentPreflights = await preflightEnrollmentTransitions(registries);
  const enrollmentTransitions = new Set(enrollmentPreflights.keys());
  const revisionPreflights = await preflightRevisionTransitions(registries, repository);
  const revisionTransitions = new Set(revisionPreflights.keys());
  const revisionStabilitySnapshots = [...revisionPreflights.values()]
    .map((preflight) => preflight.stabilitySnapshot);
  const planningBaseAuthorities = [
    selectedBaseAuthority,
    registries.baseAuthority,
    ...[...revisionPreflights.values()].map((preflight) => preflight.authority),
  ];
  validateRelationGraph(
    unionRelationVariants(registries.base, registries.candidate).map((variant) => variant.relation),
    "base-union-candidate",
  );
  const baseEntry = registries.base.repositories[repository];
  const candidateEntry = registries.candidate.repositories[repository];
  if (candidateEntry === undefined) {
    if (baseEntry?.enrollment === "enrolled") {
      verificationFailure("REPOSITORY_REGISTRATION_CHANGED", "config_validation", "Candidate удаляет регистрацию подключённого репозитория.", {
        path: `repositories.${repository}`,
        expected: canonicalJson(baseEntry),
        actual: "missing",
      });
    }
    verificationFailure("UNKNOWN_REPOSITORY", "planning", `Репозиторий ${repository} отсутствует в candidate workspace config.`, {
      details: { repository },
    });
  }
  if (baseEntry?.enrollment === "enrolled") {
    const trustedBaseRevision = repository === registries.base.ownerRepository
      ? registries.registryBase
      : baseEntry.revision;
    if (base !== trustedBaseRevision) {
      verificationFailure("BASE_REVISION_UNTRUSTED", "input_validation", "Переданный --base не совпадает с доверенной версией репозитория.", {
        path: `repositories.${repository}.revision`,
        expected: trustedBaseRevision ?? "trusted registration revision",
        actual: base,
        details: {
          repository,
          authority: repository === registries.base.ownerRepository ? "registry-base" : "base-registration",
        },
        next: "Используй SHA из доверенной base-регистрации или обнови регистрацию отдельным проверенным изменением её владельца.",
      });
    }
  }
  const registrationMustRemainStable = baseEntry !== undefined && (
    baseEntry.enrollment === "enrolled"
    || new Set(["reserved", "historical", "unmanaged"]).has(baseEntry.status)
  );
  const registrationFields = ["root", "manifest", "revision", "status", "enrollment"];
  const expectedRegistration = baseEntry === undefined
    ? null
    : Object.fromEntries(registrationFields.map((field) => [field, baseEntry[field] ?? null]));
  const actualRegistration = Object.fromEntries(
    registrationFields.map((field) => [field, candidateEntry[field] ?? null]),
  );
  if (registrationMustRemainStable) {
    if (canonicalJson(expectedRegistration) !== canonicalJson(actualRegistration)) {
      verificationFailure("REPOSITORY_REGISTRATION_CHANGED", "config_validation", "Candidate изменяет доверенную регистрацию подключённого репозитория.", {
        path: `repositories.${repository}`,
        expected: canonicalJson(expectedRegistration),
        actual: canonicalJson(actualRegistration),
      });
    }
  }
  const selectedRoot = await repositoryRootFromEntry(registries.directory, repository, candidateEntry);
  if (selectedRoot !== explicitRoot) {
    const code = baseEntry?.enrollment === "enrolled"
      ? "REPOSITORY_REGISTRATION_CHANGED"
      : "REPOSITORY_ROOT_MISMATCH";
    verificationFailure(code, "planning", "Candidate registry перенаправляет выбранный repositoryRoot.", {
      expected: explicitRoot,
      actual: selectedRoot,
    });
  }
  if (registrationMustRemainStable) {
    const baseRoot = await repositoryRootFromEntry(registries.directory, repository, baseEntry);
    if (baseRoot !== selectedRoot || baseRoot !== explicitRoot) {
      verificationFailure("REPOSITORY_REGISTRATION_CHANGED", "config_validation", "Candidate изменяет доверенную регистрацию подключённого репозитория.", {
        path: `repositories.${repository}`,
        expected: canonicalJson({ ...expectedRegistration, canonicalRoot: baseRoot }),
        actual: canonicalJson({ ...actualRegistration, canonicalRoot: selectedRoot }),
      });
    }
  }
  if (candidateEntry.enrollment === "enrolled") {
    try {
      await lstatPathWithoutSymlinks(selectedRoot, candidateEntry.manifest, "manifest");
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      // Отсутствие оформит loader manifest; здесь сохраняется стабильный код
      // именно для небезопасного symbolic-link предка доверенного файла.
    }
  }
  const snapshot = await collectGitChangesCore({ repositoryRoot: selectedRoot, base });
  if (candidateEntry.status === "reserved" && candidateEntry.enrollment !== "pending") {
    verificationFailure("REPOSITORY_STATE_INVALID", "config_validation", "Reserved repository должен оставаться pending.", {
      path: `repositories.${repository}`,
      expected: "status=reserved, enrollment=pending",
      actual: `status=${candidateEntry.status}, enrollment=${candidateEntry.enrollment}`,
    });
  }
  if (candidateEntry.status === "active" && candidateEntry.enrollment === "pending") {
    const reason = {
      code: "REPOSITORY_PENDING",
      repository,
      reason: "Активный репозиторий ещё не подключён к verification contract.",
    };
    const planCore = {
      schemaVersion: 1,
      kind: "verification-plan",
      outcome: "unverified",
      repository,
      repositoryRoot: selectedRoot,
      profile,
      boundary: options.boundary ?? null,
      baseSha: snapshot.baseSha,
      registryBaseSha: registries.registryBase,
      baseAuthority: selectedBaseAuthority,
      registryBaseAuthority: registries.baseAuthority,
      requiredBoundary: null,
      actions: [],
      obligations: [],
      reasons: [reason],
      fallbackIssues: [],
      resolvedFallbackIssues: [],
      confounders: [],
      relationEvidence: [],
      enrollmentEvidence: [],
      roots: { [repository]: selectedRoot },
      snapshots: { [repository]: snapshot },
    };
    await assertPlanningInputsStable({
      registries,
      snapshots: planCore.snapshots,
      baseAuthorities: planningBaseAuthorities,
    });
    return { ...planCore, fingerprint: sha256(canonicalJson(planCore)) };
  }
  if (new Set(["historical", "unmanaged"]).has(candidateEntry.status)) {
    verificationFailure("REPOSITORY_STATE_INVALID", "config_validation", "Historical и unmanaged repository нельзя выбирать для verification plan.", {
      path: `repositories.${repository}`,
      expected: "active or reserved+pending",
      actual: `status=${candidateEntry.status}, enrollment=${candidateEntry.enrollment}`,
    });
  }
  if (candidateEntry.status === "reserved") {
    if (
      baseEntry?.status !== "reserved"
      || baseEntry.enrollment !== "pending"
      || candidateEntry.enrollment !== "pending"
    ) {
      verificationFailure("REPOSITORY_REGISTRATION_CHANGED", "config_validation", "Reserved repository не подтверждён одинаковой base/candidate регистрацией.", {
        path: `repositories.${repository}`,
        expected: canonicalJson(baseEntry ?? null),
        actual: canonicalJson(candidateEntry),
      });
    }
    const reason = {
      code: "REPOSITORY_RESERVED",
      repository,
      reason: "Статус репозитория исключает его из обычного verification plan.",
    };
    const planCore = {
      schemaVersion: 1,
      kind: "verification-plan",
      outcome: "not_applicable",
      repository,
      repositoryRoot: selectedRoot,
      profile,
      boundary: options.boundary ?? null,
      baseSha: snapshot.baseSha,
      registryBaseSha: registries.registryBase,
      baseAuthority: selectedBaseAuthority,
      registryBaseAuthority: registries.baseAuthority,
      requiredBoundary: null,
      actions: [],
      obligations: [],
      reasons: [reason],
      fallbackIssues: [],
      resolvedFallbackIssues: [],
      confounders: [],
      relationEvidence: [],
      enrollmentEvidence: [],
      roots: { [repository]: selectedRoot },
      snapshots: { [repository]: snapshot },
    };
    await assertPlanningInputsStable({
      registries,
      snapshots: planCore.snapshots,
      baseAuthorities: planningBaseAuthorities,
    });
    return { ...planCore, fingerprint: sha256(canonicalJson(planCore)) };
  }
  if (candidateEntry.status !== "active" || candidateEntry.enrollment !== "enrolled") {
    verificationFailure("REPOSITORY_STATE_INVALID", "config_validation", "Неподдерживаемая комбинация status/enrollment выбранного репозитория.", {
      path: `repositories.${repository}`,
      actual: `status=${candidateEntry.status}, enrollment=${candidateEntry.enrollment}`,
    });
  }
  const selectedPair = await loadSelectedManifestPair({
    registryDirectory: registries.directory,
    repositoryId: repository,
    baseEntry,
    candidateEntry,
    base: snapshot.baseSha,
  });
  const allRelationDefinitions = unionRelationVariants(registries.base, registries.candidate)
    .map((variant) => variant.relation);
  validateRepositoryRelationReferences({
    repository,
    manifest: selectedPair.base.manifest,
    referenceRelations: registries.base.relations,
    consumerRelations: allRelationDefinitions,
    source: "base",
  });
  validateRepositoryRelationReferences({
    repository,
    manifest: selectedPair.candidate.manifest,
    referenceRelations: registries.candidate.relations,
    consumerRelations: allRelationDefinitions,
    source: "candidate",
  });
  const manifestPairs = new Map([[repository, selectedPair]]);
  const roots = { [repository]: selectedRoot };
  const snapshots = { [repository]: snapshot };
  for (const [repositoryId, preflight] of enrollmentPreflights) {
    manifestPairs.set(repositoryId, preflight.pair);
    roots[repositoryId] = preflight.pair.candidate.root;
    snapshots[repositoryId] = preflight.snapshot;
  }
  for (const [repositoryId, preflight] of revisionPreflights) {
    manifestPairs.set(repositoryId, preflight.pair);
    roots[repositoryId] = preflight.pair.candidate.root;
    snapshots[repositoryId] = preflight.snapshot;
  }
  const changedBySource = new Map([
    [`${repository}:base`, []],
    [`${repository}:candidate`, []],
  ]);
  const endpoints = changedEndpoints(snapshot);
  for (const endpoint of endpoints) {
    changedBySource.get(`${repository}:${endpoint.manifestSource}`).push(endpoint.path);
  }

  const selectedActions = new Map();
  const selectedExports = new Set();
  const selectedAreasBySource = new Map();
  const forcedRelations = new Set();
  const reasons = [];
  const fallbackIssues = [];
  const obligations = [];
  const confounders = [];
  const relationEvidence = [];
  let localActionSelected = false;
  const addLocalSelectedAction = (actionId, reason) => {
    localActionSelected = true;
    addSelectedAction(selectedActions, repository, actionId, reason);
  };

  for (const [repositoryId, preflight] of enrollmentPreflights) {
    reasons.push({
      code: "REPOSITORY_ENROLLMENT_CHANGED",
      repository: repositoryId,
      enrollment: "enrolled",
    });
    const manifest = preflight.pair.candidate.manifest;
    const fallbackBoundary = manifest.policy.fallbackBoundary;
    for (const actionId of manifest.boundaries[fallbackBoundary].actions) {
      addSelectedAction(selectedActions, repositoryId, actionId, {
        code: "ENROLLMENT_FULL_BOUNDARY",
        repository: repositoryId,
        boundary: fallbackBoundary,
        manifestSource: "candidate",
      });
    }
    for (const actionId of manifest.metaGate.actions) {
      addSelectedAction(selectedActions, repositoryId, actionId, {
        code: "ENROLLMENT_META_GATE",
        repository: repositoryId,
        manifestSource: "candidate",
      });
    }
  }
  for (const [repositoryId, preflight] of revisionPreflights) {
    reasons.push({
      code: "REPOSITORY_REVISION_CHANGED",
      repository: repositoryId,
      ...preflight.evidence,
    });
    for (const source of ["base", "candidate"]) {
      const manifest = manifestForSource(preflight.pair, source);
      const fallbackBoundary = manifest.policy.fallbackBoundary;
      for (const actionId of manifest.boundaries[fallbackBoundary].actions) {
        addSelectedAction(selectedActions, repositoryId, actionId, {
          code: "REVISION_FULL_BOUNDARY",
          repository: repositoryId,
          boundary: fallbackBoundary,
          manifestSource: source,
        });
      }
      for (const actionId of manifest.metaGate.actions) {
        addSelectedAction(selectedActions, repositoryId, actionId, {
          code: "REVISION_META_GATE",
          repository: repositoryId,
          manifestSource: source,
        });
      }
    }
  }
  for (const relationVariant of unionRelationVariants(registries.base, registries.candidate)) {
    if (relationVariant.provenance !== "candidate") continue;
    const relation = relationVariant.relation;
    const verifierRepository = relation.verifier.kind === "action"
      ? relation.verifier.repository
      : null;
    if (
      enrollmentTransitions.has(relation.producer.repository)
      || enrollmentTransitions.has(relation.consumer.repository)
      || (verifierRepository !== null && enrollmentTransitions.has(verifierRepository))
    ) {
      forcedRelations.add(`${relation.id}:candidate`);
    }
  }
  for (const relationVariant of unionRelationVariants(registries.base, registries.candidate)) {
    const { relation, provenance } = relationVariant;
    const verifierRepository = relation.verifier.kind === "action"
      ? relation.verifier.repository
      : null;
    if (
      revisionTransitions.has(relation.producer.repository)
      || revisionTransitions.has(relation.consumer.repository)
      || (verifierRepository !== null && revisionTransitions.has(verifierRepository))
    ) {
      forcedRelations.add(`${relation.id}:${provenance}`);
    }
  }

  const selectManifestAreas = (manifest, source, sourceEndpoints) => {
    const directAreas = new Set();
    for (const endpoint of sourceEndpoints) {
      const matches = matchingAreas(manifest, endpoint.path);
      const overlapException = registries.base.exceptions.find(
        (exception) => exception.scope.repository === repository
          && exception.scope.path !== undefined
          && globMatches(exception.scope.path, endpoint.path),
      );
      const pendingException = registries.candidate.exceptions.find(
        (exception) => exception.scope.repository === repository
          && exception.scope.path !== undefined
          && globMatches(exception.scope.path, endpoint.path)
          && !registries.base.exceptions.some((trusted) => canonicalJson(trusted) === canonicalJson(exception)),
      );
      if (matches.length > 1 && overlapException !== undefined) {
        for (const areaId of matches) directAreas.add(areaId);
        reasons.push({
          code: "PATH_OVERLAP_EXPLAINED",
          repository,
          path: endpoint.path,
          areas: matches,
          exception: overlapException.id,
          exceptionVersion: overlapException.version,
          owner: overlapException.owner,
          expiresAt: overlapException.expiresAt,
          manifestSource: source,
        });
      } else if (matches.length !== 1) {
        const code = matches.length === 0 ? "PATH_UNMATCHED" : "PATH_AMBIGUOUS";
        const issue = {
          code,
          repository,
          path: endpoint.path,
          manifestSource: source,
          areas: matches,
          statuses: endpoint.statuses,
          provenance: endpoint.provenance,
          role: endpoint.role,
        };
        fallbackIssues.push(issue);
        reasons.push(issue);
        if (matches.length > 1 && pendingException !== undefined) {
          reasons.push({
            code: "EXCEPTION_PENDING_ACTIVATION",
            repository,
            path: endpoint.path,
            exception: pendingException.id,
            exceptionVersion: pendingException.version,
            owner: pendingException.owner,
            expiresAt: pendingException.expiresAt,
          });
        }
      } else {
        directAreas.add(matches[0]);
        reasons.push({
          code: endpoint.role === "old" ? "OLD_PATH_MATCHED" : "PATH_MATCHED",
          repository,
          path: endpoint.path,
          area: matches[0],
          manifestSource: source,
          statuses: endpoint.statuses,
          provenance: endpoint.provenance,
        });
      }
      for (const exportId of matchingContracts(manifest.exports, endpoint.path)) {
        selectedExports.add(`${repository}:${exportId}:${source}`);
      }
    }
    const expanded = reverseDependentAreas(manifest, directAreas);
    addSelectedAreas(selectedAreasBySource, repository, source, expanded);
    for (const [exportId, exported] of Object.entries(manifest.exports)) {
      if (contractOwnedByAreas(manifest, exported, expanded)) {
        selectedExports.add(`${repository}:${exportId}:${source}`);
      }
    }
    for (const areaId of expanded) {
      const direct = directAreas.has(areaId);
      for (const actionId of manifest.areas[areaId].coverage[profile]) {
        addLocalSelectedAction(actionId, {
          code: direct ? "AREA_COVERAGE" : "REVERSE_DEPENDENCY",
          repository,
          area: areaId,
          manifestSource: source,
          profile,
        });
      }
    }
    if (manifest.metaGate.profiles.includes(profile) && sourceEndpoints.length > 0) {
      for (const actionId of manifest.metaGate.actions) {
        addLocalSelectedAction(actionId, {
          code: "META_GATE",
          repository,
          manifestSource: source,
          profile,
        });
      }
    }
  };

  selectManifestAreas(
    selectedPair.base.manifest,
    "base",
    endpoints.filter((endpoint) => endpoint.manifestSource === "base"),
  );
  selectManifestAreas(
    selectedPair.candidate.manifest,
    "candidate",
    endpoints.filter((endpoint) => endpoint.manifestSource === "candidate"),
  );
  if (canonicalJson(selectedPair.base.manifest.metaGate) !== canonicalJson(selectedPair.candidate.manifest.metaGate)) {
    for (const source of ["base", "candidate"]) {
      const manifest = manifestForSource(selectedPair, source);
      if (!manifest.metaGate.profiles.includes(profile)) continue;
      for (const actionId of manifest.metaGate.actions) {
        addLocalSelectedAction(actionId, {
          code: "META_GATE_CHANGED",
          repository,
          manifestSource: source,
          profile,
        });
        reasons.push({
          code: "META_GATE_CHANGED",
          repository,
          manifestSource: source,
          profile,
          action: actionId,
        });
      }
    }
  }

  for (const actionId of new Set([
    ...Object.keys(selectedPair.base.manifest.actions),
    ...Object.keys(selectedPair.candidate.manifest.actions),
  ])) {
    const baseAction = selectedPair.base.manifest.actions[actionId];
    const candidateAction = selectedPair.candidate.manifest.actions[actionId];
    if (canonicalJson(baseAction) === canonicalJson(candidateAction)) continue;
    const code = baseAction === undefined
      ? "ACTION_ADDED"
      : candidateAction === undefined
        ? "ACTION_REMOVED"
        : "ACTION_CHANGED";
    const reason = {
      code,
      repository,
      action: actionId,
      variants: [baseAction === undefined ? null : "base", candidateAction === undefined ? null : "candidate"].filter(Boolean),
    };
    addLocalSelectedAction(actionId, reason);
    reasons.push(reason);
    for (const [source, registry] of [["base", registries.base], ["candidate", registries.candidate]]) {
      for (const relation of registry.relations) {
        if (
          relation.verifier.kind === "action"
          && relation.verifier.repository === repository
          && relation.verifier.action === actionId
        ) {
          forcedRelations.add(`${relation.id}:${source}`);
        }
      }
    }
  }

  if (fallbackIssues.length === 0 && snapshot.changes.length > 0 && !localActionSelected) {
    const issue = {
      code: "EMPTY_SELECTION",
      repository,
      profile,
    };
    fallbackIssues.push(issue);
    reasons.push(issue);
  }

  const boundary = options.boundary ?? null;
  if (boundary !== null) {
    requireIdentifier(boundary, "boundary");
    let found = false;
    for (const source of ["base", "candidate"]) {
      const manifest = manifestForSource(selectedPair, source);
      const definition = manifest.boundaries[boundary];
      if (definition === undefined) continue;
      found = true;
      for (const actionId of definition.actions) {
        addSelectedAction(selectedActions, repository, actionId, {
          code: "EXPLICIT_BOUNDARY",
          repository,
          boundary,
          manifestSource: source,
        });
      }
      if (manifest.metaGate.profiles.includes(profile)) {
        for (const actionId of manifest.metaGate.actions) {
          addSelectedAction(selectedActions, repository, actionId, {
            code: "META_GATE",
            repository,
            boundary,
            manifestSource: source,
            profile,
          });
        }
      }
    }
    if (!found) {
      verificationFailure("BOUNDARY_UNKNOWN", "planning", `Граница ${boundary} отсутствует в обеих версиях manifest.`, {
        details: { repository, boundary },
      });
    }
  }

  for (const exportId of new Set([
    ...Object.keys(selectedPair.base.manifest.exports),
    ...Object.keys(selectedPair.candidate.manifest.exports),
  ])) {
    const baseExport = selectedPair.base.manifest.exports[exportId];
    const candidateExport = selectedPair.candidate.manifest.exports[exportId];
    if (canonicalJson(baseExport) === canonicalJson(candidateExport)) continue;
    if (baseExport !== undefined) selectedExports.add(`${repository}:${exportId}:base`);
    if (candidateExport !== undefined) selectedExports.add(`${repository}:${exportId}:candidate`);
    reasons.push({ code: "EXPORT_CHANGED", repository, export: exportId });
    if (candidateExport === undefined) {
      const reason = { code: "EXPORT_REMOVED", repository, export: exportId };
      confounders.push(reason);
      reasons.push(reason);
    }
  }
  for (const inputId of new Set([
    ...Object.keys(selectedPair.base.manifest.inputs),
    ...Object.keys(selectedPair.candidate.manifest.inputs),
  ])) {
    const baseInput = selectedPair.base.manifest.inputs[inputId];
    const candidateInput = selectedPair.candidate.manifest.inputs[inputId];
    if (canonicalJson(baseInput) === canonicalJson(candidateInput)) continue;
    reasons.push({ code: "INPUT_CHANGED", repository, input: inputId });
    for (const relation of registries.base.relations) {
      if (relation.consumer.repository === repository && relation.consumer.input === inputId) {
        forcedRelations.add(`${relation.id}:base`);
      }
    }
    for (const relation of registries.candidate.relations) {
      if (relation.consumer.repository === repository && relation.consumer.input === inputId) {
        forcedRelations.add(`${relation.id}:candidate`);
      }
    }
  }
  const baseRelationsById = new Map(registries.base.relations.map((relation) => [relation.id, relation]));
  const candidateRelationsById = new Map(registries.candidate.relations.map((relation) => [relation.id, relation]));
  for (const relationId of new Set([...baseRelationsById.keys(), ...candidateRelationsById.keys()])) {
    const baseRelation = baseRelationsById.get(relationId);
    const candidateRelation = candidateRelationsById.get(relationId);
    if (canonicalJson(baseRelation) === canonicalJson(candidateRelation)) continue;
    if (baseRelation !== undefined) forcedRelations.add(`${relationId}:base`);
    if (candidateRelation !== undefined) forcedRelations.add(`${relationId}:candidate`);
    if (baseRelation !== undefined && candidateRelation === undefined) {
      const reason = { code: "RELATION_REMOVED", repository, relation: relationId };
      confounders.push(reason);
      reasons.push(reason);
    } else {
      reasons.push({
        code: "RELATION_CHANGED",
        repository,
        relation: relationId,
        variants: [baseRelation === undefined ? null : "base", candidateRelation === undefined ? null : "candidate"].filter(Boolean),
      });
    }
  }
  const trustedFallbackBoundary = selectedPair.base.manifest.policy.fallbackBoundary;
  if (fallbackIssues.length > 0 && boundary === trustedFallbackBoundary) {
    for (const relationVariant of unionRelationVariants(registries.base, registries.candidate)) {
      const { relation, provenance } = relationVariant;
      const incident = relation.producer.repository === repository
        || relation.consumer.repository === repository
        || (relation.verifier.kind === "action" && relation.verifier.repository === repository);
      if (!incident) continue;
      forcedRelations.add(`${relation.id}:${provenance}`);
      reasons.push({
        code: "FALLBACK_RELATION_CLOSURE",
        repository,
        boundary: trustedFallbackBoundary,
        relation: relation.id,
        provenance,
      });
    }
  }

  // Загрузки выполняются параллельно, а их причины применяются позже в
  // сортированном порядке: fingerprint не зависит от скорости отдельных Git.
  const downstreamLoads = new Map();
  const appliedDownstreamOutcomes = new Set();
  const applyDownstreamOutcome = (outcome, repositoryId, relationSource, relationId) => {
    const requestKey = canonicalJson([repositoryId, relationSource, relationId]);
    if (appliedDownstreamOutcomes.has(requestKey)) return;
    appliedDownstreamOutcomes.add(requestKey);
    const relationFields = {
      relationSource,
      ...(relationId === null ? {} : { relation: relationId }),
    };
    const decorate = (record) => ({
      ...record,
      ...relationFields,
      details: {
        ...(record.details ?? {}),
        relationSource,
        ...(relationId === null ? {} : { relation: relationId }),
      },
    });
    if (outcome.obligation !== undefined) {
      pushUniqueCanonical(obligations, decorate(outcome.obligation));
    }
    if (outcome.confounder !== undefined) {
      const issue = decorate(outcome.confounder);
      pushUniqueCanonical(confounders, issue);
      pushUniqueCanonical(reasons, issue);
    }
  };
  const loadDownstreamRecord = async (repositoryId, relationSource) => {
    const baseRegistration = registries.base.repositories[repositoryId];
    const candidateRegistration = registries.candidate.repositories[repositoryId];
    if (baseRegistration?.enrollment === "enrolled") {
      const fields = ["root", "manifest", "revision", "status", "enrollment"];
      const expected = Object.fromEntries(fields.map((field) => [field, baseRegistration[field] ?? null]));
      const actual = candidateRegistration === undefined
        ? null
        : Object.fromEntries(fields.map((field) => [field, candidateRegistration[field] ?? null]));
      if (
        actual === null
        || (canonicalJson(expected) !== canonicalJson(actual) && !revisionTransitions.has(repositoryId))
      ) {
        verificationFailure("REPOSITORY_REGISTRATION_CHANGED", "config_validation", "Candidate изменяет доверенную регистрацию связанного репозитория.", {
          path: `repositories.${repositoryId}`,
          expected: canonicalJson(expected),
          actual: canonicalJson(actual),
          details: { repository: repositoryId },
        });
      }
    }
    const entry = registryEntryForSource(registries, repositoryId, relationSource);
    if (entry === undefined || entry.status !== "active" || entry.enrollment !== "enrolled") {
      return { pair: null };
    }
    let downstreamRoot;
    try {
      downstreamRoot = await repositoryRootFromEntry(registries.directory, repositoryId, entry);
    } catch (error) {
      if (error instanceof VerificationError && error.code === "DOWNSTREAM_MISSING") {
        return {
          pair: null,
          obligation: {
            code: "DOWNSTREAM_MISSING",
            repository: repositoryId,
            obligationType: "manual",
            reason: "Обязательный downstream checkout недоступен.",
            path: error.path,
            expected: "доступный checkout закреплённого репозитория",
            actual: error.actual,
            next: `Восстанови checkout ${repositoryId} по пути registry и построй план заново.`,
            details: error.toJSON(),
          },
        };
      }
      throw error;
    }
    const trustedRevision = repositoryId === registries.base.ownerRepository
      ? registries.registryBase
      : entry.revision;
    const head = await repositoryHead(downstreamRoot);
    if (head !== trustedRevision) {
      return {
        pair: null,
        confounder: {
          code: "DOWNSTREAM_CONFOUNDER",
          repository: repositoryId,
          reason: "HEAD связанного checkout не совпадает с доверенной revision.",
          expected: trustedRevision,
          actual: head,
          changedPaths: [],
          next: `Переключи чистый checkout ${repositoryId} на ${trustedRevision} либо построй отдельный план его изменений.`,
          details: { trustedRevision },
        },
      };
    }
    const downstreamSnapshot = await collectGitChangesCore({
      repositoryRoot: downstreamRoot,
      base: trustedRevision,
    });
    if (downstreamSnapshot.changes.length > 0) {
      return {
        pair: null,
        confounder: {
          code: "DOWNSTREAM_CONFOUNDER",
          repository: repositoryId,
          reason: "Связанный checkout содержит изменения поверх доверенной revision.",
          expected: `clean checkout at ${trustedRevision}`,
          actual: `${downstreamSnapshot.pathStates.length} changed paths`,
          changedPaths: downstreamSnapshot.pathStates.map((item) => item.path),
          next: `Очисти checkout ${repositoryId} либо построй отдельный план его изменений.`,
          details: { trustedRevision, snapshotFingerprint: downstreamSnapshot.fingerprint },
        },
      };
    }
    const trustedRecord = await loadManifestAtRevision(
      registries.directory,
      repositoryId,
      entry,
      trustedRevision,
    );
    for (const [source, registry] of [["base", registries.base], ["candidate", registries.candidate]]) {
      validateRepositoryRelationReferences({
        repository: repositoryId,
        manifest: trustedRecord.manifest,
        referenceRelations: registry.relations,
        consumerRelations: allRelationDefinitions,
        source: `downstream-${source}`,
      });
    }
    const pair = {
      base: { ...trustedRecord, path: `${trustedRevision}:${entry.manifest}` },
      candidate: { ...trustedRecord, path: `${trustedRevision}:${entry.manifest}` },
    };
    manifestPairs.set(repositoryId, pair);
    roots[repositoryId] = trustedRecord.root;
    snapshots[repositoryId] = downstreamSnapshot;
    return { pair };
  };
  const loadDownstream = async (
    repositoryId,
    relationSource,
    { applyOutcome = true, relationId = null } = {},
  ) => {
    if (manifestPairs.has(repositoryId)) {
      return manifestPairs.get(repositoryId);
    }
    const entry = registryEntryForSource(registries, repositoryId, relationSource);
    const trustedRevision = repositoryId === registries.base.ownerRepository
      ? registries.registryBase
      : entry?.revision ?? null;
    const physicalKey = canonicalJson([
      repositoryId,
      entry?.root ?? null,
      entry?.manifest ?? null,
      trustedRevision,
    ]);
    let pending = downstreamLoads.get(physicalKey);
    if (pending === undefined) {
      pending = loadDownstreamRecord(repositoryId, relationSource);
      downstreamLoads.set(physicalKey, pending);
    }
    const outcome = await pending;
    if (applyOutcome) applyDownstreamOutcome(outcome, repositoryId, relationSource, relationId);
    return outcome.pair;
  };

  // Индекс producer export превращает распространение связей в очередь. Новая
  // выбранная поверхность будит только свои relations, без повторного полного
  // обхода реестра на каждом звене цепочки.
  const relationVariants = unionRelationVariants(registries.base, registries.candidate);
  const relationVariantsByKey = new Map();
  const relationOrder = new Map();
  const relationsByExport = new Map();
  for (const [index, relationVariant] of relationVariants.entries()) {
    const { relation, provenance } = relationVariant;
    const processKey = `${relation.id}:${provenance}`;
    relationVariantsByKey.set(processKey, relationVariant);
    relationOrder.set(processKey, index);
    if (relation.producer.export !== undefined) {
      const exportKey = `${relation.producer.repository}:${relation.producer.export}:${provenance}`;
      const related = relationsByExport.get(exportKey) ?? [];
      related.push(processKey);
      relationsByExport.set(exportKey, related);
    }
  }
  const processed = new Set();
  const queued = new Set();
  const enqueueRelation = (processKey) => {
    if (!processed.has(processKey)) queued.add(processKey);
  };
  const selectExport = (exportKey) => {
    if (selectedExports.has(exportKey)) return;
    selectedExports.add(exportKey);
    for (const processKey of relationsByExport.get(exportKey) ?? []) enqueueRelation(processKey);
  };
  for (const relationVariant of relationVariants) {
    const { relation, provenance } = relationVariant;
    const processKey = `${relation.id}:${provenance}`;
    const producerPair = manifestPairs.get(relation.producer.repository);
    const producerManifest = manifestForSource(producerPair, provenance === "base" ? "base" : "candidate")
      ?? producerPair?.candidate?.manifest
      ?? producerPair?.base?.manifest;
    if (
      forcedRelations.has(processKey)
      || (producerManifest !== undefined
        && relationProducerSelected(
          relation,
          provenance,
          selectedExports,
          selectedAreasBySource,
          changedBySource,
          producerManifest,
        ))
    ) {
      enqueueRelation(processKey);
    }
  }

  while (queued.size > 0) {
    const waveKeys = [...queued].sort((left, right) => relationOrder.get(left) - relationOrder.get(right));
    queued.clear();
    const wave = waveKeys.map((processKey) => relationVariantsByKey.get(processKey));
    const preloadRequests = new Map();
    const requestPreload = (repositoryId, relationSource, relationId) => {
      const requestKey = canonicalJson([repositoryId, relationSource, relationId]);
      if (!manifestPairs.has(repositoryId) && !preloadRequests.has(requestKey)) {
        preloadRequests.set(requestKey, { repositoryId, relationSource, relationId });
      }
    };
    for (const { relation, provenance } of wave) {
      const relationSource = provenance === "base" ? "base" : "candidate";
      const processKey = `${relation.id}:${provenance}`;
      if (forcedRelations.has(processKey)) requestPreload(relation.producer.repository, relationSource, relation.id);
      const consumerEntry = registryEntryForSource(registries, relation.consumer.repository, relationSource);
      if (consumerEntry?.status === "active" && consumerEntry.enrollment === "enrolled") {
        requestPreload(relation.consumer.repository, relationSource, relation.id);
      }
      if (relation.verifier.kind === "action" && relation.verifier.repository !== repository) {
        requestPreload(relation.verifier.repository, relationSource, relation.id);
      }
    }
    const orderedPreloads = [...preloadRequests.values()].sort(
      (left, right) => canonicalJson(left).localeCompare(canonicalJson(right)),
    );
    await mapWithConcurrency(
      orderedPreloads,
      DOWNSTREAM_LOAD_CONCURRENCY,
      async ({ repositoryId, relationSource, relationId }) => await loadDownstream(
        repositoryId,
        relationSource,
        { applyOutcome: false, relationId },
      ),
    );
    for (const { repositoryId, relationSource, relationId } of orderedPreloads) {
      await loadDownstream(repositoryId, relationSource, { relationId });
    }

    for (const relationVariant of wave) {
      const { relation, provenance } = relationVariant;
      const processKey = `${relation.id}:${provenance}`;
      if (processed.has(processKey)) continue;
      if (relation.verifier.kind === "action") {
        const verifierPair = relation.verifier.repository === repository
          ? selectedPair
          : await loadDownstream(
            relation.verifier.repository,
            provenance === "base" ? "base" : "candidate",
            { relationId: relation.id },
          );
        if (verifierPair === null) {
          obligations.push({
            code: "VERIFIER_UNVERIFIED",
            relation: relation.id,
            provenance,
            repository: relation.verifier.repository,
            obligationType: "manual",
            reason: "Репозиторий verifier недоступен или не подключён.",
            expected: "active/enrolled verifier with trusted revision",
            actual: "missing, pending or blocked checkout",
            next: `Подключи manifest и revision verifier ${relation.verifier.repository}, затем построй план заново.`,
          });
        } else {
          addSelectedAction(selectedActions, relation.verifier.repository, relation.verifier.action, {
            code: "CROSS_REPOSITORY_RELATION",
            relation: relation.id,
            provenance,
            producer: relation.producer.repository,
            consumer: relation.consumer.repository,
          });
        }
      } else {
        obligations.push({
          code: "RELATION_OBLIGATION",
          relation: relation.id,
          provenance,
          repository: relation.consumer.repository,
          obligationType: relation.verifier.obligationType,
          reason: relation.verifier.reason,
          next: "Выполни обязательство связи и сохрани подтверждение перед выпуском.",
        });
      }
      let producerPair = manifestPairs.get(relation.producer.repository);
      if (producerPair === undefined && forcedRelations.has(processKey)) {
          producerPair = await loadDownstream(
            relation.producer.repository,
            provenance === "base" ? "base" : "candidate",
            { relationId: relation.id },
          );
          if (producerPair === null) {
            obligations.push({
              code: "UPSTREAM_UNVERIFIED",
              relation: relation.id,
              provenance,
              repository: relation.producer.repository,
              obligationType: "manual",
              reason: "Producer изменённой связи недоступен или не подключён.",
              expected: "active/enrolled producer with trusted revision",
              actual: "missing or pending",
              next: `Подключи manifest и revision репозитория ${relation.producer.repository}, затем построй план заново.`,
            });
            processed.add(processKey);
            continue;
          }
      }
        const producerManifest = manifestForSource(producerPair, provenance === "base" ? "base" : "candidate")
          ?? producerPair?.candidate?.manifest
          ?? producerPair?.base?.manifest;
        if (producerManifest === undefined) continue;
        if (
          !forcedRelations.has(processKey)
          && !relationProducerSelected(
            relation,
            provenance,
            selectedExports,
            selectedAreasBySource,
            changedBySource,
            producerManifest,
          )
        ) {
          continue;
        }
        processed.add(processKey);
        const consumerEntry = registryEntryForSource(registries, relation.consumer.repository, provenance === "base" ? "base" : "candidate");
        if (consumerEntry === undefined || consumerEntry.status !== "active" || consumerEntry.enrollment !== "enrolled") {
          obligations.push({
            code: "DOWNSTREAM_UNVERIFIED",
            relation: relation.id,
            provenance,
            repository: relation.consumer.repository,
            obligationType: "manual",
            reason: "Связанный репозиторий ещё не подключён к selector manifest.",
            expected: "active/enrolled downstream with trusted revision",
            actual: consumerEntry === undefined
              ? "registration missing"
              : `${consumerEntry.status}/${consumerEntry.enrollment}`,
            next: `Добавь и выпусти manifest ${relation.consumer.repository}, затем закрепи revision и включи enrollment.`,
          });
          continue;
        }
        const consumerPair = await loadDownstream(
          relation.consumer.repository,
          provenance === "base" ? "base" : "candidate",
          { relationId: relation.id },
        );
        if (consumerPair === null) continue;
        const consumerManifest = manifestForSource(consumerPair, provenance)
          ?? consumerPair.candidate?.manifest
          ?? consumerPair.base?.manifest;
        const producerPatterns = endpointPatterns(relation.producer, "producer", producerManifest);
        const consumerPatterns = endpointPatterns(relation.consumer, "consumer", consumerManifest);
        if (producerPatterns === null || consumerPatterns === null) {
          obligations.push({
            code: "RELATION_ENDPOINT_UNVERIFIED",
            relation: relation.id,
            provenance,
            repository: relation.consumer.repository,
            obligationType: "manual",
            reason: "Export или input отсутствует в доступной версии manifest.",
            expected: "declared producer export and consumer input",
            actual: "relation endpoint missing",
            next: "Исправь именованные поверхности связи в manifest/registry и построй план заново.",
          });
          continue;
        }
        if (relation.type === "exact-copy") {
          relationEvidence.push(await verifyExactCopy({
            relationVariant,
            producerManifest,
            consumerManifest,
            snapshots,
          }));
        }

        const directConsumerAreas = new Set();
        for (const [areaId, area] of Object.entries(consumerManifest.areas)) {
          if (!area.paths.some((areaPattern) => consumerPatterns.some((inputPattern) => patternsPotentiallyOverlap(areaPattern, inputPattern)))) {
            continue;
          }
          directConsumerAreas.add(areaId);
        }
        const expandedConsumerAreas = reverseDependentAreas(consumerManifest, directConsumerAreas);
        for (const areaId of expandedConsumerAreas) {
          for (const actionId of consumerManifest.areas[areaId].coverage[profile]) {
            addSelectedAction(selectedActions, relation.consumer.repository, actionId, {
              code: directConsumerAreas.has(areaId) ? "CROSS_REPOSITORY_INPUT" : "REVERSE_DEPENDENCY",
              relation: relation.id,
              provenance,
              area: areaId,
              profile,
            });
          }
        }
        for (const [exportId, exported] of Object.entries(consumerManifest.exports)) {
          if (contractOwnedByAreas(consumerManifest, exported, expandedConsumerAreas)) {
            selectExport(`${relation.consumer.repository}:${exportId}:${provenance}`);
          }
        }
    }
  }

  if (relationEvidence.some((evidence) => evidence.status !== "equal")) {
    for (const evidence of relationEvidence.filter((item) => item.status !== "equal")) {
      const reason = {
        code: evidence.code,
        relation: evidence.relation,
        provenance: evidence.provenance,
        reason: "Связанная exact-copy копия не доказана побайтно с тем же executable bit.",
      };
      confounders.push(reason);
      reasons.push(reason);
    }
  }
  for (const evidence of relationEvidence) {
    reasons.push({
      code: evidence.code,
      relation: evidence.relation,
      provenance: evidence.provenance,
    });
  }

  const actions = [];
  for (const { repository: actionRepository, actionId, reasons: actionReasons } of selectedActions.values()) {
    const pair = manifestPairs.get(actionRepository);
    for (const variant of actionVariants(actionRepository, actionId, pair, actionReasons)) {
      actions.push(variant);
      for (const reason of variant.reasons) reasons.push(reason);
    }
  }
  const automatic = [];
  for (const action of actions) {
    if (action.definition.kind === "obligation") {
      obligations.push({
        code: "ACTION_OBLIGATION",
        repository: action.repository,
        action: action.id,
        provenance: action.provenance,
        obligationType: action.definition.obligationType,
        reason: action.definition.reason,
      });
    } else {
      automatic.push(action);
    }
  }

  const fallbackBoundary = selectedPair.base.manifest.policy.fallbackBoundary;
  const candidateFallbackBoundary = selectedPair.candidate.manifest.policy.fallbackBoundary;
  if (fallbackIssues.length > 0 && fallbackBoundary !== candidateFallbackBoundary) {
    reasons.push({
      code: "FALLBACK_BOUNDARY_CHANGED",
      repository,
      baseBoundary: fallbackBoundary,
      candidateBoundary: candidateFallbackBoundary,
    });
  }
  const fallbackSatisfied = fallbackIssues.length === 0
    || boundary === fallbackBoundary;
  const unresolvedFallbackIssues = fallbackSatisfied ? [] : fallbackIssues;
  const resolvedFallbackIssues = fallbackSatisfied ? fallbackIssues : [];
  const outcome = outcomeForPlan({
    changes: snapshot.changes,
    fallbackIssues: unresolvedFallbackIssues,
    confounders,
    obligations,
    actions: automatic,
  });
  for (const [repositoryId, preflight] of enrollmentPreflights) {
    preflight.evidence.snapshotFingerprint = snapshots[repositoryId].fingerprint;
  }
  for (const [repositoryId, preflight] of revisionPreflights) {
    preflight.evidence.snapshotFingerprint = snapshots[repositoryId].fingerprint;
    const revisionReason = reasons.find(
      (reason) => reason.code === "REPOSITORY_REVISION_CHANGED"
        && reason.repository === repositoryId,
    );
    if (revisionReason !== undefined) {
      revisionReason.snapshotFingerprint = preflight.evidence.snapshotFingerprint;
    }
  }
  await assertPlanningInputsStable({
    registries,
    manifestPairs,
    snapshots,
    stabilitySnapshots: revisionStabilitySnapshots,
    baseAuthorities: planningBaseAuthorities,
  });
  const uniqueReasons = [];
  for (const reason of [...reasons, ...obligations, ...confounders]) pushUniqueCanonical(uniqueReasons, reason);
  const planCore = {
    schemaVersion: 1,
    kind: "verification-plan",
    outcome,
    repository,
    repositoryRoot: selectedRoot,
    profile,
    boundary,
    baseSha: snapshot.baseSha,
    registryBaseSha: registries.registryBase,
    baseAuthority: selectedBaseAuthority,
    registryBaseAuthority: registries.baseAuthority,
    requiredBoundary: outcome === "requires_boundary" ? fallbackBoundary : null,
    actions: automatic,
    obligations,
    reasons: uniqueReasons,
    fallbackIssues: unresolvedFallbackIssues,
    resolvedFallbackIssues,
    confounders,
    relationEvidence,
    enrollmentEvidence: [...enrollmentPreflights.values()].map((item) => item.evidence),
    revisionEvidence: [...revisionPreflights.values()].map((item) => item.evidence),
    roots,
    snapshots,
  };
  return {
    ...planCore,
    fingerprint: sha256(canonicalJson(planCore)),
  };
}

function outcomeLabel(outcome) {
  return ({
    planned: "план готов",
    no_changes: "изменений нет",
    requires_boundary: "нужна явная полная граница",
    action_required: "нужны ручные действия",
    blocked: "планирование заблокировано",
    unverified: "проверка не доказана",
    not_applicable: "проверка неприменима",
  })[outcome] ?? outcome;
}

function escapeUnsafeHumanCharacters(value) {
  return value.replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Экранирует недоверенное значение так, чтобы оно оставалось одной строкой отчёта. */
function humanAtom(value) {
  const jsonString = JSON.stringify(String(value));
  return escapeUnsafeHumanCharacters(jsonString.slice(1, -1));
}

function humanJson(value) {
  return escapeUnsafeHumanCharacters(JSON.stringify(value));
}

function boundedHumanJson(value, limit = 2048) {
  const encoded = humanJson(value);
  return encoded.length <= limit ? encoded : `${encoded.slice(0, limit)}…`;
}

function humanIssue(issue) {
  const fields = [];
  for (const [key, label] of [
    ["repository", "repository"],
    ["relation", "relation"],
    ["relationSource", "relationSource"],
    ["provenance", "provenance"],
    ["path", "path"],
    ["action", "action"],
  ]) {
    if (issue[key] !== undefined && issue[key] !== "") {
      fields.push(`${label}=${humanAtom(issue[key])}`);
    }
  }
  if (Array.isArray(issue.changedPaths) && issue.changedPaths.length > 0) {
    fields.push(`changedPaths=${boundedHumanJson(issue.changedPaths)}`);
  }
  for (const [key, label] of [
    ["reason", "reason"],
    ["expected", "expected"],
    ["actual", "actual"],
    ["next", "next"],
  ]) {
    if (issue[key] !== undefined && issue[key] !== "") {
      fields.push(`${label}=${humanAtom(issue[key])}`);
    }
  }
  if (isRecord(issue.details) && Object.keys(issue.details).length > 0) {
    fields.push(`details=${boundedHumanJson(issue.details)}`);
  }
  return `${humanAtom(issue.code)}${fields.length === 0 ? "" : `; ${fields.join("; ")}`}`;
}

/**
 * Формирует основной человекочитаемый результат с итогом, обязательствами и
 * точным следующим действием; полный структурный evidence остаётся в JSON.
 */
export function formatHumanReport(record) {
  const revisionEvidence = record?.revisionEvidence ?? [];
  const arrays = [
    record?.actions,
    record?.obligations,
    record?.reasons,
    record?.fallbackIssues,
    record?.resolvedFallbackIssues,
    record?.confounders,
    revisionEvidence,
  ];
  const snapshotsValid = isRecord(record?.snapshots)
    && Object.values(record.snapshots).every(
      (snapshot) => isRecord(snapshot) && Array.isArray(snapshot.changes),
    );
  const actionsValid = Array.isArray(record?.actions)
    && record.actions.every(
      (action) => isRecord(action)
        && isRecord(action.definition)
        && Array.isArray(action.definition.argv)
        && typeof action.definition.cwd === "string"
        && Array.isArray(action.reasons),
    );
  if (
    !isRecord(record)
    || record.kind !== "verification-plan"
    || typeof record.repository !== "string"
    || typeof record.profile !== "string"
    || typeof record.outcome !== "string"
    || typeof record.fingerprint !== "string"
    || arrays.some((value) => !Array.isArray(value))
    || !snapshotsValid
    || !actionsValid
  ) {
    verificationFailure("REPORT_INVALID", "reporting", "Нельзя сформировать отчёт из переданного значения.");
  }
  const lines = [
    `План: ${humanAtom(outcomeLabel(record.outcome))}.`,
    `Репозиторий: ${humanAtom(record.repository)}.`,
    `Профиль: ${humanAtom(record.profile)}.`,
  ];
  if (isRecord(record.baseAuthority)) {
    lines.push(
      `Доверенная база: ${humanAtom(record.baseAuthority.mergeBaseSha)}; HEAD=${humanAtom(record.baseAuthority.headSha)}; ${humanAtom(record.baseAuthority.targetRef)}=${humanAtom(record.baseAuthority.targetSha)}.`,
    );
  }
  const changedPaths = new Set();
  for (const snapshot of Object.values(record.snapshots ?? {})) {
    for (const change of snapshot.changes ?? []) {
      if (change.path) changedPaths.add(change.path);
      if (change.oldPath) changedPaths.add(change.oldPath);
      if (change.newPath) changedPaths.add(change.newPath);
    }
  }
  lines.push(`Изменённых путей: ${changedPaths.size}.`);
  for (const evidence of revisionEvidence) {
    if (!isRecord(evidence)) continue;
    lines.push(
      `Переход revision ${humanAtom(evidence.repository)}: ${humanAtom(evidence.baseRevision)} -> ${humanAtom(evidence.candidateRevision)} (${humanAtom(evidence.direction)}); snapshot=${humanAtom(evidence.snapshotFingerprint)}.`,
    );
  }
  if (record.boundary) lines.push(`Явная граница: ${humanAtom(record.boundary)}.`);
  lines.push(`Запланированные команды: ${record.actions.length}.`);
  lines.push(`Обязательства: ${record.obligations.length}.`);
  for (const action of record.actions) {
    const causes = [...new Set((action.reasons ?? []).map((reason) => {
      const subject = reason.area ?? reason.relation ?? reason.path;
      return subject === undefined ? reason.code : `${reason.code}:${subject}`;
    }))];
    lines.push(
      `- ${humanAtom(action.repository)}:${humanAtom(action.id)} (${humanAtom(action.provenance)}); cwd=${humanJson(action.definition.cwd)}; argv=${humanJson(action.definition.argv)}; причины: ${causes.map(humanAtom).join(", ") || "не указаны"}`,
    );
  }
  for (const obligation of record.obligations) {
    lines.push(`- Требуется действие ${humanIssue(obligation)}`);
  }
  if ((record.resolvedFallbackIssues ?? []).length > 0) {
    lines.push(`Причины, закрытые явной границей: ${record.resolvedFallbackIssues.length}.`);
  }
  for (const issue of record.resolvedFallbackIssues ?? []) {
    lines.push(`- ${humanIssue(issue)}`);
  }
  const blockingIssues = [...(record.fallbackIssues ?? []), ...(record.confounders ?? [])];
  if (blockingIssues.length > 0) lines.push(`Блокирующие причины: ${blockingIssues.length}.`);
  for (const issue of blockingIssues) {
    lines.push(`- ${humanIssue(issue)}`);
  }
  if (record.actions.length === 0 && record.obligations.length === 0 && blockingIssues.length === 0 && record.reasons.length > 0) {
    lines.push(`Причины результата: ${record.reasons.length}.`);
    for (const reason of record.reasons) {
      lines.push(`- ${humanIssue(reason)}`);
    }
  }
  const next = ({
    planned: "Проверь декларативные команды и выполни их штатными средствами репозитория.",
    no_changes: "Дополнительных действий по этому снимку не требуется.",
    requires_boundary: `Повтори построение плана с --boundary ${humanAtom(record.requiredBoundary)}.`,
    action_required: "Выполни перечисленные обязательства и сохрани подтверждение.",
    blocked: "Выполни точные шаги next у блокирующих причин и построй план заново.",
    unverified: "Выполни точные шаги next у обязательств и построй план заново.",
    not_applicable: "Дополнительных действий для этого статуса не требуется.",
  })[record.outcome];
  if (next) lines.push(`Следующий шаг: ${next}`);
  lines.push("Планировщик не запускал выбранные проверки и не изменял файлы проекта.");
  lines.push(`Подробности: повтори исходную команду с --json; fingerprint ${humanAtom(record.fingerprint)}.`);
  return `${lines.join("\n")}\n`;
}

function parseCliArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "plan") {
    verificationFailure("CLI_USAGE", "input_validation", "Поддерживается только команда plan.", {
      expected: "plan",
      actual: String(command ?? "missing"),
      next: "Используй `plan` и передай обязательные --repository, --repository-root и --base.",
    });
  }
  const options = { command, json: false };
  const valueOptions = new Map([
    ["--registry", "registryPath"],
    ["--repository", "repository"],
    ["--repository-root", "repositoryRoot"],
    ["--base", "base"],
    ["--registry-base", "registryBase"],
    ["--profile", "profile"],
    ["--boundary", "boundary"],
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    const field = valueOptions.get(token);
    if (field === undefined) {
      verificationFailure("CLI_USAGE", "input_validation", `Неизвестный аргумент ${token}.`, {
        actual: token,
        next: "Удали неизвестный аргумент; JSON выводится только флагом --json в stdout.",
      });
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      verificationFailure("CLI_USAGE", "input_validation", `Аргумент ${token} требует значение.`, {
        path: token,
        next: `Передай значение сразу после ${token}.`,
      });
    }
    options[field] = value;
    index += 1;
  }
  for (const field of ["repository", "repositoryRoot", "base"]) {
    if (options[field] === undefined) {
      verificationFailure("CLI_USAGE", "input_validation", `Не передан обязательный аргумент ${field}.`, {
        path: field,
        next: `Передай --${field.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} со значением.`,
      });
    }
  }
  return options;
}

/**
 * CLI-граница разбирает только документированные флаги и возвращает неизменяемый
 * план без запуска перечисленных в нём команд.
 */
export async function main(
  argv = process.argv.slice(2),
  {
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  try {
    const options = parseCliArguments(argv);
    const registryPath = options.registryPath === undefined
      ? resolve(PACKAGE_ROOT, "config/workspace-verification.json")
      : resolve(cwd, options.registryPath);
    const plan = await buildVerificationPlan({
      registryPath,
      repository: options.repository,
      repositoryRoot: resolve(cwd, options.repositoryRoot),
      base: options.base,
      registryBase: options.registryBase,
      profile: options.profile ?? "affected",
      boundary: options.boundary,
    });
    if (options.json) {
      stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      stdout.write(formatHumanReport(plan));
    }
    return new Set(["planned", "no_changes"]).has(plan.outcome) ? 0 : 2;
  } catch (error) {
    const normalized = error instanceof VerificationError
      ? error
      : new VerificationError({
          code: "UNEXPECTED_ERROR",
          stage: "unknown",
          message: "Непредвиденная ошибка выбора проверок.",
          actual: error?.message ?? String(error),
          cause: error,
        });
    if (argv.includes("--json")) {
      stderr.write(`${JSON.stringify(normalized.toJSON(), null, 2)}\n`);
    } else {
      const fields = [
        `Ошибка: ${humanAtom(normalized.message)}`,
        `Код: ${humanAtom(normalized.code)}`,
        `Этап: ${humanAtom(normalized.stage)}`,
        normalized.path ? `Путь: ${humanAtom(normalized.path)}` : null,
        normalized.expected ? `Ожидалось: ${humanAtom(normalized.expected)}` : null,
        normalized.actual ? `Получено: ${humanAtom(normalized.actual)}` : null,
        normalized.next ? `Следующий шаг: ${humanAtom(normalized.next)}` : null,
      ].filter(Boolean);
      stderr.write(`${fields.join("\n")}\n`);
    }
    return 1;
  }
}
