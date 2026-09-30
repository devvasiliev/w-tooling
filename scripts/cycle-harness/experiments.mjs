import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  assertEnum,
  assertString,
  assertTaskId,
  canonicalJson,
  CycleHarnessError,
  DECISIONS,
  DOSSIER_ROOT,
  durationOrNull,
  escapesRoot,
  EXPERIMENT_RESULTS,
  EXPERIMENT_SCENARIOS,
  HARNESS_LAYERS,
  normalizedFacets,
  normalizedStrings,
  OVERLAY_OPERATIONS,
  pathForDisplay,
  prettyJson,
  PROVENANCE_VALUES,
  SCHEMA_VERSION,
  schemaFailure,
  schemaNestedObject,
  schemaObject,
  schemaString,
  schemaStringArray,
  sha256,
  TASK_CLASSES,
  validateWorktreeSchema,
} from "./core.mjs";
import {
  ensureDirectoryChain,
  immutableWrite,
  optionalLstat,
  optionalSafeFile,
  readJson,
  validateExistingPathChain,
} from "./safe-files.mjs";
import { splitNull } from "./worktree.mjs";

/**
 * Реестр immutable harness-кандидатов и append-only evidence. Сервис использует
 * фасад только для разрешения владельцев, task mutation и Git-команд.
 */
function parseCandidateRef(value) {
  const candidateRef = assertString(value, "candidate_ref");
  const match = /^(?<repository>[a-z0-9]+(?:-[a-z0-9]+)*):(?<taskId>[A-Z][A-Z0-9]*-[0-9]+):(?<digest>[a-f0-9]{64})$/u.exec(candidateRef);
  if (!match) {
    throw new CycleHarnessError({
      code: "INVALID_CANDIDATE_REF",
      stage: "input_validation",
      path: "candidate_ref",
      message: `Некорректная ссылка на кандидата: ${candidateRef}.`,
      expected: "repository:CODE-N:<sha256>",
      actual: candidateRef,
      next: "Скопируй candidate_ref из результата experiment create/list.",
    });
  }
  return { candidateRef, ...match.groups };
}

function assertRelativeArtifactPath(value, field) {
  const path = assertString(value, field);
  if (
    isAbsolute(path)
    || path.includes("\\")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new CycleHarnessError({
      code: "INVALID_ARTIFACT_PATH",
      stage: "candidate_validation",
      path: field,
      message: `Artifact path должен быть безопасным repository-relative POSIX path: ${path}.`,
      expected: "relative/path/inside/repository",
      actual: path,
      next: "Убери absolute path, backslash, '.' и '..' segments.",
    });
  }
  return path;
}

function candidateIdentity({ state, target, manifest, overlay, rubric, evaluation }) {
  return {
    title: manifest.title,
    target,
    task_class: state.task.class,
    facets: state.task.facets,
    hypothesis: manifest.hypothesis,
    overlay,
    rubric,
    evaluation,
    quality_criteria: manifest.quality_criteria,
    regression_scenarios: manifest.regression_scenarios,
    negative_scenarios: manifest.negative_scenarios,
  };
}

function variantFingerprint(identity) {
  return sha256(
    canonicalJson({
      target: identity.target,
      overlay: identity.overlay.map((change) => ({
        layer: change.layer,
        operation: change.operation,
        target: change.target,
        before: change.before,
        after: change.after,
      })),
      rubric: identity.rubric,
      evaluation: identity.evaluation,
    }),
  );
}

function validateCandidateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new CycleHarnessError({
      code: "INVALID_CANDIDATE",
      stage: "candidate_validation",
      path: "candidate",
      message: "Candidate manifest должен быть JSON-объектом.",
      expected: "object",
      actual: Array.isArray(manifest) ? "array" : typeof manifest,
      next: "Используй документированный candidate manifest.",
    });
  }
  assertCandidateInputKeys(
    manifest,
    new Set(["title", "hypothesis", "target_repository", "changes", "rubric", "evaluation", "quality_criteria", "regression_scenarios", "negative_scenarios"]),
    "candidate",
  );
  const changes = manifest.changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new CycleHarnessError({
      code: "INVALID_CANDIDATE",
      stage: "candidate_validation",
      path: "changes",
      message: "Кандидат должен содержать хотя бы одно изменение harness.",
      expected: "непустой массив changes",
      actual: Array.isArray(changes) ? "пустой массив" : typeof changes,
      next: "Добавь layer, target и proposal для каждого изменения.",
    });
  }
  assertCandidateInputKeys(manifest.rubric, new Set(["version", "path"]), "rubric");
  assertCandidateInputKeys(manifest.evaluation, new Set(["version", "path"]), "evaluation");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.target_repository ?? "")) {
    candidateInputFailure("target_repository", "lower-kebab-case", String(manifest.target_repository));
  }
  return {
    title: assertString(manifest.title, "title"),
    hypothesis: assertString(manifest.hypothesis, "hypothesis"),
    target_repository: assertString(manifest.target_repository, "target_repository"),
    changes: changes.map((change, index) => {
      assertCandidateInputKeys(
        change,
        new Set(["layer", "operation", "target", "content_path", "summary"]),
        `changes[${index}]`,
      );
      const operation = assertEnum(change?.operation, `changes[${index}].operation`, OVERLAY_OPERATIONS);
      if (operation === "delete" && change.content_path !== undefined && change.content_path !== null) {
        candidateInputFailure(`changes[${index}].content_path`, "поле отсутствует для delete", String(change.content_path));
      }
      return {
        layer: assertEnum(change?.layer, `changes[${index}].layer`, HARNESS_LAYERS),
        operation,
        target: assertRelativeArtifactPath(change?.target, `changes[${index}].target`),
        content_path: operation === "delete"
          ? null
          : assertRelativeArtifactPath(change?.content_path, `changes[${index}].content_path`),
        summary: assertString(change?.summary, `changes[${index}].summary`),
      };
    }),
    rubric: {
      version: assertString(manifest.rubric?.version, "rubric.version"),
      path: assertRelativeArtifactPath(manifest.rubric?.path, "rubric.path"),
    },
    evaluation: {
      version: assertString(manifest.evaluation?.version, "evaluation.version"),
      path: assertRelativeArtifactPath(manifest.evaluation?.path, "evaluation.path"),
    },
    quality_criteria: normalizedStrings(manifest.quality_criteria, "quality_criteria", { required: true }),
    regression_scenarios: normalizedStrings(manifest.regression_scenarios, "regression_scenarios", { required: true }),
    negative_scenarios: normalizedStrings(manifest.negative_scenarios, "negative_scenarios", { required: true }),
  };
}

function candidateInputFailure(path, expected, actual) {
  throw new CycleHarnessError({
    code: "INVALID_CANDIDATE",
    stage: "candidate_validation",
    path,
    message: `Candidate manifest содержит некорректное поле: ${path}.`,
    expected,
    actual,
    next: "Исправь manifest по документированной schema и повтори создание кандидата.",
  });
}

function assertCandidateInputKeys(record, allowed, path) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    candidateInputFailure(path, "object", Array.isArray(record) ? "array" : typeof record);
  }
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) candidateInputFailure(path, `keys: ${[...allowed].join(", ")}`, `unused: ${unexpected.join(", ")}`);
}

function validateDigestField(record, field, path) {
  const value = schemaString(record, field, path);
  if (!/^[a-f0-9]{64}$/u.test(value)) schemaFailure(path, field, "sha256 hex", value);
  return value;
}

function validateEmbeddedArtifact(record, path) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    schemaFailure(path, "artifact", "object", record === null ? "null" : typeof record);
  }
  if (record.mode !== undefined && !new Set(["100644", "100755"]).has(record.mode)) {
    schemaFailure(path, "mode", "100644|100755", String(record.mode));
  }
  const digest = validateDigestField(record, "sha256", path);
  if (record.content_base64 !== undefined) {
    const content = schemaString(record, "content_base64", path, { empty: true });
    const bytes = Buffer.from(content, "base64");
    if (bytes.toString("base64") !== content || sha256(bytes) !== digest) {
      schemaFailure(path, "content_base64", `bytes with sha256 ${digest}`, "digest mismatch");
    }
  }
  return record;
}

function validateRepositoryName(value, path, field) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) schemaFailure(path, field, "lower-kebab-case", value);
}

function validateTaskIdCode(value, path, field) {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(value)) schemaFailure(path, field, "CODE-N", value);
}

function validateGitObject(value, path, field) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) schemaFailure(path, field, "Git object id", value);
}

function validateIsoTimestamp(value, path, field) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) schemaFailure(path, field, "UTC ISO-8601 timestamp", value);
}

function validateRecordPath(value, path, field) {
  if (
    isAbsolute(value)
    || value.includes("\\")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    schemaFailure(path, field, "безопасный repository-relative POSIX path", value);
  }
}

function validateSortedUnique(values, path, field, { facets = false } = {}) {
  if (new Set(values).size !== values.length) schemaFailure(path, field, "уникальные значения", "duplicates");
  if (facets) {
    values.forEach((value, index) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) schemaFailure(path, `${field}[${index}]`, "lower-kebab-case", value);
    });
    if (canonicalJson(values) !== canonicalJson([...values].sort())) schemaFailure(path, field, "отсортированный массив", "unsorted");
  }
}

function validateCandidateRecord(record, path) {
  schemaObject(record, path);
  for (const field of ["candidate_ref", "digest", "created_at", "title", "variant_fingerprint"]) {
    schemaString(record, field, path);
  }
  validateDigestField(record, "digest", path);
  validateDigestField(record, "variant_fingerprint", path);
  validateIsoTimestamp(record.created_at, path, "created_at");
  schemaNestedObject(record, "source", path);
  schemaString(record.source, "repository", `${path}#source`);
  schemaString(record.source, "taskId", `${path}#source`);
  validateRepositoryName(record.source.repository, path, "source.repository");
  validateTaskIdCode(record.source.taskId, path, "source.taskId");
  const identity = record.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) schemaFailure(path, "identity", "object", typeof identity);
  schemaString(identity, "title", `${path}#identity`);
  if (record.title !== identity.title) schemaFailure(path, "title", identity.title, record.title);
  if (!identity.target || typeof identity.target !== "object") schemaFailure(path, "identity.target", "object", typeof identity?.target);
  schemaString(identity.target, "repository", `${path}#identity.target`);
  schemaString(identity.target, "baseline_sha", `${path}#identity.target`);
  validateRepositoryName(identity.target.repository, path, "identity.target.repository");
  validateGitObject(identity.target.baseline_sha, path, "identity.target.baseline_sha");
  schemaString(identity, "task_class", `${path}#identity`);
  schemaString(identity, "hypothesis", `${path}#identity`);
  if (!TASK_CLASSES.has(identity.task_class)) schemaFailure(path, "identity.task_class", [...TASK_CLASSES].join("|"), identity.task_class);
  for (const field of ["facets", "quality_criteria", "regression_scenarios", "negative_scenarios"]) {
    schemaStringArray(identity, field, `${path}#identity`);
    if (identity[field].length === 0) schemaFailure(path, `identity.${field}`, "непустой массив", "empty");
    validateSortedUnique(identity[field], path, `identity.${field}`, { facets: field === "facets" });
  }
  if (!Array.isArray(identity.overlay) || identity.overlay.length === 0) {
    schemaFailure(path, "identity.overlay", "непустой массив", Array.isArray(identity.overlay) ? "empty" : typeof identity.overlay);
  }
  for (const [index, change] of identity.overlay.entries()) {
    const changePath = `${path}#identity.overlay[${index}]`;
    if (!change || typeof change !== "object" || Array.isArray(change)) schemaFailure(changePath, "", "object", typeof change);
    for (const field of ["layer", "operation", "target", "summary"]) schemaString(change, field, changePath);
    if (!HARNESS_LAYERS.has(change.layer)) schemaFailure(changePath, "layer", [...HARNESS_LAYERS].join("|"), change.layer);
    if (!OVERLAY_OPERATIONS.has(change.operation)) schemaFailure(changePath, "operation", [...OVERLAY_OPERATIONS].join("|"), change.operation);
    validateRecordPath(change.target, changePath, "target");
    if (change.before !== null) {
      validateEmbeddedArtifact(change.before, `${changePath}.before`);
      schemaString(change.before, "git_object", `${changePath}.before`);
      schemaString(change.before, "mode", `${changePath}.before`);
      schemaString(change.before, "content_base64", `${changePath}.before`, { empty: true });
      validateGitObject(change.before.git_object, `${changePath}.before`, "git_object");
    }
    if (change.after !== null) {
      validateEmbeddedArtifact(change.after, `${changePath}.after`);
      schemaString(change.after, "content_base64", `${changePath}.after`, { empty: true });
    }
    if (change.operation === "add" && change.before !== null) schemaFailure(changePath, "before", "null for add", "object");
    if (change.operation !== "add" && change.before === null) schemaFailure(changePath, "before", "object", "null");
    if (change.operation === "delete" && change.after !== null) schemaFailure(changePath, "after", "null for delete", "object");
    if (change.operation !== "delete" && change.after === null) schemaFailure(changePath, "after", "object", "null");
  }
  const overlayTargets = identity.overlay.map((change) => change.target);
  validateSortedUnique(overlayTargets, path, "identity.overlay.target");
  for (const field of ["rubric", "evaluation"]) {
    const artifact = identity[field];
    validateEmbeddedArtifact(artifact, `${path}#identity.${field}`);
    schemaString(artifact, "version", `${path}#identity.${field}`);
    schemaString(artifact, "content_base64", `${path}#identity.${field}`, { empty: true });
  }
  const referenceMatch = /^(?<repository>[a-z0-9]+(?:-[a-z0-9]+)*):(?<taskId>[A-Z][A-Z0-9]*-[0-9]+):(?<digest>[a-f0-9]{64})$/u.exec(record.candidate_ref);
  if (!referenceMatch) schemaFailure(path, "candidate_ref", "repository:CODE-N:<sha256>", record.candidate_ref);
  const identityDigest = sha256(canonicalJson(identity));
  if (record.digest !== identityDigest) schemaFailure(path, "digest", identityDigest, record.digest);
  if (referenceMatch && (
    referenceMatch.groups.repository !== record.source.repository
    || referenceMatch.groups.taskId !== record.source.taskId
    || referenceMatch.groups.digest !== record.digest
  )) schemaFailure(path, "candidate_ref", `${record.source.repository}:${record.source.taskId}:${record.digest}`, record.candidate_ref);
  const expectedVariant = variantFingerprint(identity);
  if (record.variant_fingerprint !== expectedVariant) schemaFailure(path, "variant_fingerprint", expectedVariant, record.variant_fingerprint);
  return record;
}

function validateEvidenceRecord(record, path) {
  schemaObject(record, path);
  for (const field of ["identity_digest", "kind", "candidate_ref", "recorded_at", "summary", "provenance"]) {
    schemaString(record, field, path);
  }
  validateDigestField(record, "identity_digest", path);
  validateIsoTimestamp(record.recorded_at, path, "recorded_at");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*:[A-Z][A-Z0-9]*-[0-9]+:[a-f0-9]{64}$/u.test(record.candidate_ref)) {
    schemaFailure(path, "candidate_ref", "repository:CODE-N:<sha256>", record.candidate_ref);
  }
  if (!new Set(["validation", "decision"]).has(record.kind)) schemaFailure(path, "kind", "validation|decision", record.kind);
  if (!PROVENANCE_VALUES.has(record.provenance)) schemaFailure(path, "provenance", [...PROVENANCE_VALUES].join("|"), record.provenance);
  if (!record.owner || typeof record.owner !== "object") schemaFailure(path, "owner", "object", typeof record.owner);
  schemaString(record.owner, "repository", `${path}#owner`);
  schemaString(record.owner, "taskId", `${path}#owner`);
  validateRepositoryName(record.owner.repository, path, "owner.repository");
  validateTaskIdCode(record.owner.taskId, path, "owner.taskId");
  schemaStringArray(record, "evidence", path);
  if (record.kind === "validation") {
    for (const field of ["scenario", "scenario_id", "run_key", "result"]) schemaString(record, field, path);
    if (!EXPERIMENT_SCENARIOS.has(record.scenario)) schemaFailure(path, "scenario", [...EXPERIMENT_SCENARIOS].join("|"), record.scenario);
    if (!EXPERIMENT_RESULTS.has(record.result)) schemaFailure(path, "result", [...EXPERIMENT_RESULTS].join("|"), record.result);
    validateDigestField(record, "task_worktree_fingerprint", path);
    validateDigestField(record, "target_worktree_fingerprint", path);
    if (record.duration_minutes !== null && (!Number.isFinite(record.duration_minutes) || record.duration_minutes < 0)) {
      schemaFailure(path, "duration_minutes", "number >= 0|null", String(record.duration_minutes));
    }
    if (!record.variant || typeof record.variant !== "object") schemaFailure(path, "variant", "object", typeof record.variant);
    validateDigestField(record.variant, "variant_fingerprint", `${path}#variant`);
    schemaString(record.variant, "target_repository", `${path}#variant`);
    schemaString(record.variant, "baseline_sha", `${path}#variant`);
    validateRepositoryName(record.variant.target_repository, path, "variant.target_repository");
    validateGitObject(record.variant.baseline_sha, path, "variant.baseline_sha");
    validateDigestField(record.variant, "target_worktree_fingerprint", `${path}#variant`);
    validateWorktreeSchema(record.variant.target_worktree, `${path}#variant.target_worktree`);
    validateWorktreeSchema(record.variant.verification_worktree, `${path}#variant.verification_worktree`);
    if (record.variant.target_worktree.fingerprint !== record.variant.target_worktree_fingerprint) {
      schemaFailure(
        path,
        "variant.target_worktree_fingerprint",
        record.variant.target_worktree.fingerprint,
        record.variant.target_worktree_fingerprint,
      );
    }
    if (!Array.isArray(record.variant.verified_paths)) schemaFailure(path, "variant.verified_paths", "array", typeof record.variant.verified_paths);
    for (const [index, verified] of record.variant.verified_paths.entries()) {
      const verifiedPath = `${path}#variant.verified_paths[${index}]`;
      if (!verified || typeof verified !== "object" || Array.isArray(verified)) schemaFailure(verifiedPath, "", "object", typeof verified);
      validateRecordPath(schemaString(verified, "path", verifiedPath), verifiedPath, "path");
      if (verified.after !== null) validateEmbeddedArtifact(verified.after, `${verifiedPath}.after`);
    }
    if (!record.task_pool || typeof record.task_pool !== "object") schemaFailure(path, "task_pool", "object", typeof record.task_pool);
    schemaString(record.task_pool, "class", `${path}#task_pool`);
    schemaStringArray(record.task_pool, "facets", `${path}#task_pool`);
    if (!TASK_CLASSES.has(record.task_pool.class)) schemaFailure(path, "task_pool.class", [...TASK_CLASSES].join("|"), record.task_pool.class);
    validateSortedUnique(record.task_pool.facets, path, "task_pool.facets", { facets: true });
    if (!record.evaluation || typeof record.evaluation !== "object") schemaFailure(path, "evaluation", "object", typeof record.evaluation);
    for (const field of ["rubric_version", "rubric_digest", "eval_version", "eval_digest"]) {
      schemaString(record.evaluation, field, `${path}#evaluation`);
    }
    validateDigestField(record.evaluation, "rubric_digest", `${path}#evaluation`);
    validateDigestField(record.evaluation, "eval_digest", `${path}#evaluation`);
    validateWorktreeSchema(record.task_worktree, `${path}#task_worktree`);
    if (record.task_worktree.fingerprint !== record.task_worktree_fingerprint) {
      schemaFailure(path, "task_worktree_fingerprint", record.task_worktree.fingerprint, record.task_worktree_fingerprint);
    }
    if (
      record.variant.target_worktree.head_sha !== record.variant.baseline_sha
      || record.variant.verification_worktree.head_sha !== record.variant.baseline_sha
    ) {
      schemaFailure(
        path,
        "variant.worktree.head_sha",
        record.variant.baseline_sha,
        `${record.variant.target_worktree.head_sha}/${record.variant.verification_worktree.head_sha}`,
      );
    }
    const targetPaths = record.variant.target_worktree.changed_paths;
    const sameRepository = record.owner.repository === record.variant.target_repository;
    const overlapping = sameRepository
      ? record.task_worktree.changed_paths.filter((taskPath) =>
          targetPaths.some((targetPath) => pathsOverlap(taskPath, targetPath))
        )
      : [];
    if (overlapping.length) {
      schemaFailure(path, "task_worktree.changed_paths", "paths без пересечения с target overlay", overlapping.join(","));
    }
    const expectedVerificationPaths = sameRepository
      ? [...new Set([...targetPaths, ...record.task_worktree.changed_paths])].sort()
      : targetPaths;
    if (
      canonicalJson(record.variant.verification_worktree.changed_paths)
      !== canonicalJson(expectedVerificationPaths)
    ) {
      schemaFailure(
        path,
        "variant.verification_worktree.changed_paths",
        canonicalJson(expectedVerificationPaths),
        canonicalJson(record.variant.verification_worktree.changed_paths),
      );
    }
  } else {
    schemaString(record, "decision_id", path);
    schemaString(record, "decision", path);
    validateDigestField(record, "evidence_set_digest", path);
    if (!DECISIONS.has(record.decision)) schemaFailure(path, "decision", [...DECISIONS].join("|"), record.decision);
  }
  const identity = record.kind === "validation"
    ? {
        kind: record.kind,
        candidate_ref: record.candidate_ref,
        owner: record.owner,
        scenario: record.scenario,
        scenario_id: record.scenario_id,
        run_key: record.run_key,
        variant_fingerprint: record.variant_fingerprint,
        target_worktree_fingerprint: record.target_worktree_fingerprint,
        task_worktree_fingerprint: record.task_worktree_fingerprint,
      }
    : {
        kind: record.kind,
        candidate_ref: record.candidate_ref,
        owner: record.owner,
        decision_id: record.decision_id,
        evidence_set_digest: record.evidence_set_digest,
      };
  const expectedIdentityDigest = sha256(canonicalJson(identity));
  if (record.identity_digest !== expectedIdentityDigest) {
    schemaFailure(path, "identity_digest", expectedIdentityDigest, record.identity_digest);
  }
  const fileMatch = /(?:^|[/\\])(?<digest>[a-f0-9]{64})\.json$/u.exec(path);
  if (fileMatch && fileMatch.groups.digest !== record.identity_digest) {
    schemaFailure(path, "filename", `${record.identity_digest}.json`, path);
  }
  return record;
}

function validationRunKey(record) {
  return canonicalJson({
    candidate_ref: record.candidate_ref,
    owner: record.owner,
    scenario: record.scenario,
    scenario_id: record.scenario_id,
    run_key: record.run_key,
  });
}

function validationEvidenceSetDigest(items) {
  const records = items
    .map((item) => item.record ?? item)
    .filter((record) => record.kind === "validation")
    .map((record) => ({
      identity_digest: record.identity_digest,
      record_digest: sha256(canonicalJson(record)),
    }))
    .sort((left, right) => left.identity_digest.localeCompare(right.identity_digest));
  return sha256(canonicalJson(records));
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export class CycleExperimentService {
  constructor(harness) {
    this.harness = harness;
  }

  async readManifestFromRepository(repositoryRoot, manifestPath) {
    const input = assertString(manifestPath, "candidate_path");
    const absolute = resolve(repositoryRoot, input);
    if (escapesRoot(repositoryRoot, absolute)) {
      throw new CycleHarnessError({
        code: "PATH_OUTSIDE_ROOT",
        stage: "candidate_load",
        path: absolute,
        message: `Candidate manifest выходит за пределы репозитория: ${input}`,
        expected: repositoryRoot,
        actual: absolute,
        next: "Помести manifest внутрь репозитория-владельца.",
      });
    }
    await validateExistingPathChain(repositoryRoot, absolute, {
      stage: "candidate_load",
      finalType: "file",
      label: "Candidate manifest",
    });
    return readJson(absolute, "candidate_load");
  }

  async readCandidateArtifact(repositoryRoot, artifactPath, label) {
    const relativePath = assertRelativeArtifactPath(artifactPath, label);
    const absolute = resolve(repositoryRoot, relativePath);
    await validateExistingPathChain(repositoryRoot, absolute, {
      stage: "candidate_load",
      finalType: "file",
      label,
    });
    const [content, metadata] = await Promise.all([readFile(absolute), lstat(absolute)]);
    return {
      source_path: relativePath,
      mode: metadata.mode & 0o111 ? "100755" : "100644",
      sha256: sha256(content),
      content_base64: content.toString("base64"),
    };
  }

  async resolveCandidateBaseline(repositoryRoot, baselineSha) {
    const requested = baselineSha ? assertString(baselineSha, "baseline_sha") : "HEAD";
    try {
      const { stdout } = await this.harness.git(
        repositoryRoot,
        ["rev-parse", "--verify", `${requested}^{commit}`],
        "candidate_baseline",
      );
      return stdout.toString("utf8").trim();
    } catch (error) {
      if (!(error instanceof CycleHarnessError)) throw error;
      throw new CycleHarnessError({
        code: "INVALID_BASELINE",
        stage: "candidate_baseline",
        path: repositoryRoot,
        message: `Baseline commit не существует в target repository: ${requested}.`,
        expected: "существующий commit target repository",
        actual: requested,
        next: "Передай commit SHA канонического target repository.",
      });
    }
  }

  async baselineArtifact(repositoryRoot, baselineSha, targetPath) {
    const { stdout } = await this.harness.git(
      repositoryRoot,
      ["ls-tree", "-z", baselineSha, "--", `:(literal)${targetPath}`],
      "candidate_baseline",
    );
    const record = splitNull(stdout)[0];
    if (!record) return null;
    const separator = record.indexOf("\t");
    const [mode, type, object] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (separator === -1 || path !== targetPath || type !== "blob" || !new Set(["100644", "100755"]).has(mode)) {
      throw new CycleHarnessError({
        code: "INVALID_BASELINE_ENTRY",
        stage: "candidate_baseline",
        path: targetPath,
        message: `Baseline target должен быть обычным Git blob: ${targetPath}.`,
        expected: "обычный executable/non-executable file blob",
        actual: `${type ?? "unknown"}:${mode ?? "unknown"}`,
        next: "Выбери file target или исправь operation кандидата.",
      });
    }
    const { stdout: content } = await this.harness.git(
      repositoryRoot,
      ["cat-file", "blob", object],
      "candidate_baseline",
    );
    return {
      mode,
      git_object: object,
      sha256: sha256(content),
      content_base64: content.toString("base64"),
    };
  }

  async verifyAppliedVariant(candidate, { taskOwner = null, taskWorktree = null } = {}) {
    const target = await this.harness.resolveRepository(candidate.identity.target.repository);
    const head = (
      await this.harness.git(target.root, ["rev-parse", "HEAD"], "variant_verification")
    ).stdout.toString("utf8").trim();
    if (head !== candidate.identity.target.baseline_sha) {
      throw new CycleHarnessError({
        code: "CANDIDATE_BASELINE_MISMATCH",
        stage: "variant_verification",
        path: target.root,
        message: "Target repository находится не на baseline кандидата.",
        expected: candidate.identity.target.baseline_sha,
        actual: head,
        next: "Переключи target repository на baseline и примени immutable overlay.",
      });
    }
    const verifiedPaths = [];
    for (const change of candidate.identity.overlay) {
      const absolute = resolve(target.root, change.target);
      const metadata = await optionalSafeFile(target.root, absolute, {
        stage: "variant_verification",
        label: `Overlay target ${change.target}`,
      });
      if (change.after === null) {
        if (metadata !== null) {
          throw new CycleHarnessError({
            code: "CANDIDATE_OVERLAY_MISMATCH",
            stage: "variant_verification",
            path: absolute,
            message: `Delete overlay не применён: ${change.target}.`,
            expected: "missing",
            actual: "file существует",
            next: "Примени точный immutable overlay перед записью evidence.",
          });
        }
        verifiedPaths.push({ path: change.target, after: null });
        continue;
      }
      if (metadata === null) {
        throw new CycleHarnessError({
          code: "CANDIDATE_OVERLAY_MISMATCH",
          stage: "variant_verification",
          path: absolute,
          message: `Overlay target отсутствует: ${change.target}.`,
          expected: change.after.sha256,
          actual: "missing",
          next: "Примени точный immutable overlay перед записью evidence.",
        });
      }
      const content = await readFile(absolute);
      const actual = {
        mode: metadata.mode & 0o111 ? "100755" : "100644",
        sha256: sha256(content),
      };
      if (actual.sha256 !== change.after.sha256 || actual.mode !== change.after.mode) {
        throw new CycleHarnessError({
          code: "CANDIDATE_OVERLAY_MISMATCH",
          stage: "variant_verification",
          path: absolute,
          message: `Применённый overlay отличается от immutable candidate: ${change.target}.`,
          expected: `${change.after.mode}:${change.after.sha256}`,
          actual: `${actual.mode}:${actual.sha256}`,
          next: "Восстанови точные bytes/mode из candidate record.",
        });
      }
      verifiedPaths.push({ path: change.target, after: actual });
    }
    const actualFingerprint = variantFingerprint(candidate.identity);
    if (actualFingerprint !== candidate.variant_fingerprint) {
      throw new CycleHarnessError({
        code: "CANDIDATE_VARIANT_MISMATCH",
        stage: "variant_verification",
        path: candidate.candidate_ref,
        message: "Variant fingerprint не совпадает с candidate identity.",
        expected: candidate.variant_fingerprint,
        actual: actualFingerprint,
        next: "Восстанови immutable candidate record.",
      });
    }
    const expectedChangedPaths = candidate.identity.overlay.map((change) => change.target).sort();
    const [targetWorktree, verificationWorktree] = await Promise.all([
      this.harness.worktreeSnapshot(target.root, { includePaths: expectedChangedPaths }),
      this.harness.worktreeSnapshot(target.root),
    ]);
    if (canonicalJson(targetWorktree.changed_paths) !== canonicalJson(expectedChangedPaths)) {
      const unexpected = targetWorktree.changed_paths.filter((path) => !expectedChangedPaths.includes(path));
      const missing = expectedChangedPaths.filter((path) => !targetWorktree.changed_paths.includes(path));
      throw new CycleHarnessError({
        code: "CANDIDATE_TARGET_CONFOUNDER",
        stage: "variant_verification",
        path: target.root,
        message: "Target worktree содержит изменения вне точного candidate overlay либо не содержит overlay path.",
        expected: expectedChangedPaths.join(", ") || "clean overlay",
        actual: targetWorktree.changed_paths.join(", ") || "clean worktree",
        next: "Примени каждый immutable overlay path и повтори evidence run.",
        details: { unexpected, missing },
      });
    }
    const sameTaskRepository = taskOwner?.name === target.name;
    if (sameTaskRepository) {
      if (!taskWorktree) {
        throw new CycleHarnessError({
          code: "CANDIDATE_TASK_BASELINE_REQUIRED",
          stage: "variant_verification",
          path: target.root,
          message: "Same-repository evidence требует отдельный task-only snapshot до применения overlay.",
          expected: "task checkpoint или task_worktree предыдущего evidence этого кандидата",
          actual: "task baseline отсутствует",
          next: "Убери overlay, создай task checkpoint, снова примени overlay и повтори run.",
        });
      }
      if (
        taskWorktree.head_sha !== verificationWorktree.head_sha
        || taskWorktree.head_state !== verificationWorktree.head_state
        || taskWorktree.branch !== verificationWorktree.branch
      ) {
        throw new CycleHarnessError({
          code: "CANDIDATE_TASK_BASELINE_DRIFT",
          stage: "variant_verification",
          path: target.root,
          message: "Task-only snapshot и применённый variant относятся к разным Git states.",
          expected: `${taskWorktree.head_sha}:${taskWorktree.head_state}:${taskWorktree.branch ?? "detached"}`,
          actual: `${verificationWorktree.head_sha}:${verificationWorktree.head_state}:${verificationWorktree.branch ?? "detached"}`,
          next: "Верни task checkout к checkpoint state и повторно примени immutable overlay.",
        });
      }
      const overlapping = taskWorktree.changed_paths.filter((taskPath) =>
        expectedChangedPaths.some((overlayPath) => pathsOverlap(taskPath, overlayPath))
      );
      if (overlapping.length) {
        throw new CycleHarnessError({
          code: "CANDIDATE_TASK_OVERLAP",
          stage: "variant_verification",
          path: target.root,
          message: "Task-only changes пересекаются с candidate overlay и не могут быть разделены.",
          expected: "непересекающиеся task и overlay paths",
          actual: overlapping.join(", "),
          next: "Подготовь отдельный task checkpoint без overlay targets либо используй отдельный checkout.",
          details: { overlapping },
        });
      }
      const expectedCombinedPaths = [...new Set([
        ...taskWorktree.changed_paths,
        ...expectedChangedPaths,
      ])].sort();
      if (canonicalJson(verificationWorktree.changed_paths) !== canonicalJson(expectedCombinedPaths)) {
        const unexpected = verificationWorktree.changed_paths.filter(
          (path) => !expectedCombinedPaths.includes(path),
        );
        const missing = expectedCombinedPaths.filter(
          (path) => !verificationWorktree.changed_paths.includes(path),
        );
        throw new CycleHarnessError({
          code: "CANDIDATE_TARGET_CONFOUNDER",
          stage: "variant_verification",
          path: target.root,
          message: "Same-repository checkout отличается от точного объединения task checkpoint и candidate overlay.",
          expected: expectedCombinedPaths.join(", ") || "clean worktree",
          actual: verificationWorktree.changed_paths.join(", ") || "clean worktree",
          next: "Удали изменения после task checkpoint, оставь task paths и immutable overlay, затем повтори run.",
          details: { unexpected, missing },
        });
      }
      if (taskWorktree.changed_paths.length) {
        const currentTaskWorktree = await this.harness.worktreeSnapshot(target.root, {
          includePaths: taskWorktree.changed_paths,
        });
        if (currentTaskWorktree.fingerprint !== taskWorktree.fingerprint) {
          throw new CycleHarnessError({
            code: "CANDIDATE_TASK_WORKTREE_DRIFT",
            stage: "variant_verification",
            path: target.root,
            message: "Task-owned paths изменились после task checkpoint.",
            expected: taskWorktree.fingerprint,
            actual: currentTaskWorktree.fingerprint,
            next: "Восстанови task-owned paths по checkpoint или создай новый checkpoint до применения overlay.",
          });
        }
      }
    } else if (canonicalJson(verificationWorktree.changed_paths) !== canonicalJson(expectedChangedPaths)) {
      const unexpected = verificationWorktree.changed_paths.filter(
        (path) => !expectedChangedPaths.includes(path),
      );
      const missing = expectedChangedPaths.filter(
        (path) => !verificationWorktree.changed_paths.includes(path),
      );
      throw new CycleHarnessError({
        code: "CANDIDATE_TARGET_CONFOUNDER",
        stage: "variant_verification",
        path: target.root,
        message: "Target worktree содержит изменения вне точного candidate overlay либо не содержит overlay path.",
        expected: expectedChangedPaths.join(", ") || "clean overlay",
        actual: verificationWorktree.changed_paths.join(", ") || "clean worktree",
        next: "Удали посторонние изменения, примени только immutable overlay и повтори evidence run.",
        details: { unexpected, missing },
      });
    }
    return {
      target_repository: target.name,
      baseline_sha: head,
      variant_fingerprint: actualFingerprint,
      target_worktree_fingerprint: targetWorktree.fingerprint,
      target_worktree: targetWorktree,
      verification_worktree: verificationWorktree,
      verified_paths: verifiedPaths,
    };
  }

  async createCandidate({ repository, taskId, manifest, manifestPath, baselineSha }) {
    const context = await this.harness.acquireTask(repository, taskId);
    const candidateManifest = validateCandidateManifest(
      manifest ?? (await this.readManifestFromRepository(context.owner.root, manifestPath)),
    );
    const target = await this.harness.resolveRepository(candidateManifest.target_repository);
    const baseline = await this.resolveCandidateBaseline(target.root, baselineSha);
    const seenTargets = new Set();
    const overlay = [];
    for (const change of candidateManifest.changes) {
      if (seenTargets.has(change.target)) {
        throw new CycleHarnessError({
          code: "DUPLICATE_OVERLAY_TARGET",
          stage: "candidate_validation",
          path: change.target,
          message: `Overlay target указан больше одного раза: ${change.target}.`,
          expected: "одна operation на target",
          actual: "duplicate target",
          next: "Объедини изменение target в одну operation.",
        });
      }
      seenTargets.add(change.target);
      const before = await this.baselineArtifact(target.root, baseline, change.target);
      if (change.operation === "add" ? before !== null : before === null) {
        throw new CycleHarnessError({
          code: "CANDIDATE_TARGET_STATE_MISMATCH",
          stage: "candidate_baseline",
          path: change.target,
          message: `Operation ${change.operation} не соответствует baseline target: ${change.target}.`,
          expected: change.operation === "add" ? "target отсутствует" : "target существует",
          actual: before === null ? "target отсутствует" : "target существует",
          next: "Исправь operation или выбери правильный target baseline.",
        });
      }
      const afterArtifact = change.operation === "delete"
        ? null
        : await this.readCandidateArtifact(
            context.owner.root,
            change.content_path,
            `Overlay content ${change.target}`,
          );
      overlay.push({
        layer: change.layer,
        operation: change.operation,
        target: change.target,
        summary: change.summary,
        before,
        after: afterArtifact === null
          ? null
          : {
              mode: afterArtifact.mode,
              sha256: afterArtifact.sha256,
              content_base64: afterArtifact.content_base64,
            },
      });
    }
    const rubricArtifact = await this.readCandidateArtifact(
      context.owner.root,
      candidateManifest.rubric.path,
      "Rubric artifact",
    );
    const evaluationArtifact = await this.readCandidateArtifact(
      context.owner.root,
      candidateManifest.evaluation.path,
      "Evaluation artifact",
    );
    return this.harness.withMutation(repository, taskId, async (mutable) => {
      const identity = candidateIdentity({
        state: mutable.state,
        target: { repository: target.name, baseline_sha: baseline },
        manifest: candidateManifest,
        overlay,
        rubric: {
          version: candidateManifest.rubric.version,
          sha256: rubricArtifact.sha256,
          content_base64: rubricArtifact.content_base64,
        },
        evaluation: {
          version: candidateManifest.evaluation.version,
          sha256: evaluationArtifact.sha256,
          content_base64: evaluationArtifact.content_base64,
        },
      });
      const digest = sha256(canonicalJson(identity));
      const candidateRef = `${mutable.owner.name}:${mutable.taskId}:${digest}`;
      const candidatePath = join(mutable.taskRoot, "experiments", "candidates", `${digest}.json`);
      const event = this.harness.buildEvent(
        mutable.state,
        {
          summary: `Создан неизменяемый harness-кандидат: ${candidateManifest.title}`,
          phase: "Эксперимент",
          expected: candidateManifest.hypothesis,
          actual: `Candidate ref: ${candidateRef}`,
          next: "Проверить replay, regression, negative и fresh-task сценарии.",
          evidence: [pathForDisplay(relative(mutable.taskRoot, candidatePath))],
        },
        "decision",
      );
      const record = {
        schema_version: SCHEMA_VERSION,
        candidate_ref: candidateRef,
        digest,
        source: { repository: mutable.owner.name, taskId: mutable.taskId },
        created_at: event.occurred_at,
        title: candidateManifest.title,
        identity,
        variant_fingerprint: variantFingerprint(identity),
      };
      validateCandidateRecord(record, candidatePath);
      const worktree = await this.harness.worktreeSnapshot(mutable.owner.root);
      const prepared = await this.harness.prepareEventMutation(mutable, event, { worktree });
      await ensureDirectoryChain(mutable.taskRoot, join(mutable.taskRoot, "experiments", "candidates"));
      await immutableWrite(candidatePath, prettyJson(record), "IMMUTABLE_CANDIDATE");
      await this.harness.commitPreparedEventMutation(mutable, prepared);
      return { candidate: record, candidatePath };
    });
  }

  async loadCandidate(candidateRef) {
    const reference = parseCandidateRef(candidateRef);
    const context = await this.harness.acquireTask(reference.repository, reference.taskId);
    const candidatePath = join(context.taskRoot, "experiments", "candidates", `${reference.digest}.json`);
    const metadata = await optionalLstat(candidatePath);
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new CycleHarnessError({
        code: "CANDIDATE_NOT_FOUND",
        stage: "candidate_load",
        path: candidatePath,
        message: `Кандидат не найден: ${reference.candidateRef}`,
        expected: "immutable candidate record",
        actual: metadata === null ? "missing" : "неподдерживаемый тип",
        next: "Проверь candidate_ref через experiment list.",
      });
    }
    const candidate = validateCandidateRecord(
      await readJson(candidatePath, "candidate_load"),
      candidatePath,
    );
    const actualDigest = sha256(canonicalJson(candidate.identity));
    if (
      candidate.candidate_ref !== reference.candidateRef
      || candidate.digest !== reference.digest
      || actualDigest !== reference.digest
      || variantFingerprint(candidate.identity) !== candidate.variant_fingerprint
      || candidate.source?.repository !== reference.repository
      || candidate.source?.taskId !== reference.taskId
    ) {
      throw new CycleHarnessError({
        code: "CANDIDATE_DIGEST_MISMATCH",
        stage: "candidate_load",
        path: candidatePath,
        message: `Identity кандидата не совпадает с candidate_ref: ${reference.candidateRef}`,
        expected: reference.digest,
        actual: actualDigest,
        next: "Восстанови исходный immutable record; изменённый кандидат должен получить новый digest.",
      });
    }
    return { reference, candidate, sourceContext: context, candidatePath };
  }

  assertLocalOwnership({ repository, taskId, dossierRepository, dossierTaskId }) {
    const owner = `${assertString(repository, "repository")}/${assertTaskId(taskId)}`;
    const target = `${assertString(dossierRepository ?? repository, "dossier_repository")}/${assertTaskId(dossierTaskId ?? taskId)}`;
    if (owner !== target) {
      throw new CycleHarnessError({
        code: "OWNERSHIP_MISMATCH",
        stage: "experiment_write",
        path: target,
        message: `Задача ${owner} не может записывать evidence в чужое досье ${target}.`,
        expected: owner,
        actual: target,
        next: "Запиши append-only evidence в досье текущей задачи и укажи candidate_ref источника.",
      });
    }
  }

  async assertRunIdentityAvailable(context, record, evidencePath) {
    const evidenceRoot = join(context.taskRoot, "experiments", "evidence");
    const metadata = await optionalLstat(evidenceRoot);
    if (metadata === null) return;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new CycleHarnessError({
        code: "UNSAFE_ENTRY",
        stage: "experiment_validation",
        path: evidenceRoot,
        message: "Evidence registry должен быть обычным directory.",
        expected: "directory",
        actual: metadata.isSymbolicLink() ? "symbolic link" : "другой тип",
        next: "Освободи managed evidence path и повтори run.",
      });
    }
    const expectedRun = validationRunKey(record);
    for (const name of (await readdir(evidenceRoot)).filter((item) => item.endsWith(".json"))) {
      const existingPath = join(evidenceRoot, name);
      const existing = validateEvidenceRecord(await readJson(existingPath, "experiment_validation"), existingPath);
      if (existing.kind === "validation" && validationRunKey(existing) === expectedRun) {
        throw new CycleHarnessError({
          code: "DUPLICATE_EVIDENCE",
          stage: "immutable_write",
          path: evidencePath,
          message: "Exact run identity уже записана в досье этой задачи.",
          expected: "новые scenario-id или run-key для нового запуска",
          actual: existing.identity_digest,
          next: "Используй существующий evidence record; новый фактический запуск должен получить новый run-key.",
        });
      }
    }
  }

  async taskWorktreeBaseline(context, candidateRef) {
    const evidenceRoot = join(context.taskRoot, "experiments", "evidence");
    const metadata = await optionalLstat(evidenceRoot);
    const baselines = [];
    const reusableBaselines = [];
    if (metadata !== null) {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new CycleHarnessError({
          code: "UNSAFE_ENTRY",
          stage: "experiment_validation",
          path: evidenceRoot,
          message: "Evidence registry должен быть обычным directory.",
          expected: "directory",
          actual: metadata.isSymbolicLink() ? "symbolic link" : "другой тип",
          next: "Освободи managed evidence path и повтори run.",
        });
      }
      for (const name of (await readdir(evidenceRoot)).filter((item) => item.endsWith(".json")).sort()) {
        const evidencePath = join(evidenceRoot, name);
        const record = validateEvidenceRecord(
          await readJson(evidencePath, "experiment_validation"),
          evidencePath,
        );
        if (
          record.kind === "validation"
          && record.owner.repository === context.owner.name
          && record.owner.taskId === context.taskId
        ) {
          reusableBaselines.push(record.task_worktree);
          if (record.candidate_ref === candidateRef) baselines.push(record.task_worktree);
        }
      }
    }
    if (baselines.length) {
      const fingerprints = [...new Set(baselines.map((worktree) => worktree.fingerprint))];
      if (fingerprints.length !== 1) {
        throw new CycleHarnessError({
          code: "EVIDENCE_TASK_SNAPSHOT_CONFLICT",
          stage: "experiment_validation",
          path: `${context.owner.name}/${context.taskId}`,
          message: "Evidence одного кандидата содержит разные task-only snapshots.",
          expected: fingerprints[0],
          actual: fingerprints.slice(1).join(", "),
          next: "Восстанови согласованный immutable evidence-set или создай нового кандидата.",
        });
      }
      return baselines[0];
    }
    const reusableFingerprints = [
      ...new Set(reusableBaselines.map((worktree) => worktree.fingerprint)),
    ];
    if (reusableFingerprints.length === 1) return reusableBaselines[0];
    if (!/events\/[0-9]{4}-checkpoint\.json$/u.test(context.state.last_event)) {
      throw new CycleHarnessError({
        code: "CANDIDATE_TASK_BASELINE_REQUIRED",
        stage: "experiment_validation",
        path: `${context.owner.name}/${context.taskId}`,
        message: "Первый same-repository evidence run требует явный task checkpoint до применения overlay.",
        expected: "последнее событие checkpoint без candidate overlay",
        actual: context.state.last_event,
        next: "Убери overlay и временные candidate assets, создай checkpoint, снова примени overlay и повтори run.",
      });
    }
    return context.state.current.worktree;
  }

  async recordEvidence({ repository, taskId, dossierRepository, dossierTaskId, candidateRef, scenario, scenarioId, runKey, result, summary, evidence = [], durationMinutes, provenance = "observed" }) {
    this.assertLocalOwnership({ repository, taskId, dossierRepository, dossierTaskId });
    const normalizedScenario = assertEnum(scenario, "scenario", EXPERIMENT_SCENARIOS);
    const normalizedResult = assertEnum(result, "result", EXPERIMENT_RESULTS);
    const normalizedSummary = assertString(summary, "summary");
    const normalizedEvidence = normalizedStrings(evidence, "evidence");
    const normalizedProvenance = assertEnum(provenance, "provenance", PROVENANCE_VALUES);
    const loaded = await this.loadCandidate(candidateRef);
    return this.harness.withMutation(repository, taskId, async (context) => {
      const event = this.harness.buildEvent(
        context.state,
        {
          summary: `Проверен кандидат ${loaded.reference.digest.slice(0, 12)}: ${normalizedSummary}`,
          phase: "Эксперимент",
          actual: `${normalizedScenario}: ${normalizedResult}`,
          result: normalizedResult,
          next: "Пересчитать агрегированный статус кандидата.",
          evidence: normalizedEvidence,
          durationMinutes,
          provenance: normalizedProvenance,
        },
        "verification",
      );
      if (normalizedScenario === "fresh-task") {
        const isDifferentTask = context.owner.name !== loaded.reference.repository || context.taskId !== loaded.reference.taskId;
        if (!isDifferentTask) {
          throw new CycleHarnessError({
            code: "FRESH_TASK_REQUIRED",
            stage: "experiment_validation",
            path: `${context.owner.name}/${context.taskId}`,
            message: "Fresh-task проверка должна выполняться в другой задаче.",
            expected: `не ${loaded.reference.repository}/${loaded.reference.taskId}`,
            actual: `${context.owner.name}/${context.taskId}`,
            next: "Запусти кандидата на следующей типовой задаче того же пула.",
          });
        }
        const sameClass = context.state.task.class === loaded.candidate.identity.task_class;
        const missingFacets = loaded.candidate.identity.facets.filter(
          (facet) => !context.state.task.facets.includes(facet),
        );
        if (!sameClass || missingFacets.length) {
          throw new CycleHarnessError({
            code: "TASK_POOL_MISMATCH",
            stage: "experiment_validation",
            path: `${context.owner.name}/${context.taskId}`,
            message: "Fresh-task проверка относится к другому пулу задач.",
            expected: `${loaded.candidate.identity.task_class}; facets=${loaded.candidate.identity.facets.join(",")}`,
            actual: `${context.state.task.class}; facets=${context.state.task.facets.join(",")}`,
            next: "Выбери другую задачу того же класса и с теми же обязательными facets.",
            details: { missingFacets },
          });
        }
      }
      const sameTargetRepository = context.owner.name === loaded.candidate.identity.target.repository;
      let taskWorktree;
      let mutationWorktree;
      let variant;
      if (sameTargetRepository) {
        taskWorktree = await this.taskWorktreeBaseline(context, loaded.reference.candidateRef);
        variant = await this.verifyAppliedVariant(loaded.candidate, {
          taskOwner: context.owner,
          taskWorktree,
        });
        mutationWorktree = variant.verification_worktree;
      } else {
        [variant, taskWorktree] = await Promise.all([
          this.verifyAppliedVariant(loaded.candidate),
          this.harness.worktreeSnapshot(context.owner.root),
        ]);
        mutationWorktree = taskWorktree;
      }
      const identity = {
        kind: "validation",
        candidate_ref: loaded.reference.candidateRef,
        owner: { repository: context.owner.name, taskId: context.taskId },
        scenario: normalizedScenario,
        scenario_id: assertString(scenarioId, "scenario_id"),
        run_key: assertString(runKey, "run_key"),
        variant_fingerprint: variant.variant_fingerprint,
        target_worktree_fingerprint: variant.target_worktree_fingerprint,
        task_worktree_fingerprint: taskWorktree.fingerprint,
      };
      const identityDigest = sha256(canonicalJson(identity));
      const evidencePath = join(context.taskRoot, "experiments", "evidence", `${identityDigest}.json`);
      event.evidence = [pathForDisplay(relative(context.taskRoot, evidencePath)), ...normalizedEvidence];
      const record = {
        schema_version: SCHEMA_VERSION,
        identity_digest: identityDigest,
        ...identity,
        recorded_at: event.occurred_at,
        result: normalizedResult,
        summary: normalizedSummary,
        duration_minutes: durationOrNull(durationMinutes),
        provenance: normalizedProvenance,
        evidence: normalizedEvidence,
        variant,
        target_worktree_fingerprint: variant.target_worktree_fingerprint,
        task_worktree_fingerprint: taskWorktree.fingerprint,
        task_worktree: taskWorktree,
        task_pool: { class: context.state.task.class, facets: context.state.task.facets },
        evaluation: {
          rubric_version: loaded.candidate.identity.rubric.version,
          rubric_digest: loaded.candidate.identity.rubric.sha256,
          eval_version: loaded.candidate.identity.evaluation.version,
          eval_digest: loaded.candidate.identity.evaluation.sha256,
        },
      };
      validateEvidenceRecord(record, evidencePath);
      await this.assertRunIdentityAvailable(context, record, evidencePath);
      const prepared = await this.harness.prepareEventMutation(
        context,
        event,
        { worktree: mutationWorktree },
      );
      await ensureDirectoryChain(context.taskRoot, join(context.taskRoot, "experiments", "evidence"));
      await immutableWrite(evidencePath, prettyJson(record), "DUPLICATE_EVIDENCE");
      await this.harness.commitPreparedEventMutation(context, prepared);
      return { evidence: record, evidencePath };
    });
  }

  async recordDecision({ repository, taskId, dossierRepository, dossierTaskId, candidateRef, decisionId, decision, summary, evidence = [], provenance = "observed" }) {
    this.assertLocalOwnership({ repository, taskId, dossierRepository, dossierTaskId });
    const normalizedDecision = assertEnum(decision, "decision", DECISIONS);
    const loaded = await this.loadCandidate(candidateRef);
    const projection = await this.candidateStatus(candidateRef);
    const technicalGateNames = ["replay", "regression", "negative", "fresh_task"];
    const missingGates = technicalGateNames.filter((name) => !projection.gates[name]);
    if (
      normalizedDecision === "approved"
      && (missingGates.length || projection.failures.length || projection.rejections.length)
    ) {
      throw new CycleHarnessError({
        code: "APPROVAL_GATES_INCOMPLETE",
        stage: "human_approval",
        path: candidateRef,
        message: "Human approval разрешён только после успешных технических gates.",
        expected: "replay, regression, negative и fresh-task pass без fail/rejected",
        actual: `missing=${missingGates.join(",") || "нет"}; failures=${projection.failures.length}; rejections=${projection.rejections.length}`,
        next: projection.failures.length || projection.rejections.length
          ? "Создай нового кандидата с новым digest после исправления причины fail/rejected."
          : "Заверши технические проверки, покажи их человеку и запиши решение.",
        details: { missing_gates: missingGates },
      });
    }
    return this.harness.withMutation(repository, taskId, async (context) => {
      const identity = {
        kind: "decision",
        candidate_ref: loaded.reference.candidateRef,
        owner: { repository: context.owner.name, taskId: context.taskId },
        decision_id: assertString(decisionId, "decision_id"),
        evidence_set_digest: projection.technical_evidence_digest,
      };
      const identityDigest = sha256(canonicalJson(identity));
      const normalizedEvidence = normalizedStrings(evidence, "evidence");
      const evidencePath = join(context.taskRoot, "experiments", "evidence", `${identityDigest}.json`);
      const event = this.harness.buildEvent(
        context.state,
        {
          summary: `Решение по кандидату ${loaded.reference.digest.slice(0, 12)}: ${summary}`,
          phase: "Эксперимент",
          result: normalizedDecision,
          next: normalizedDecision === "approved"
            ? "Approval связан с текущим evidence-set; promotion требует отдельной задачи w-tooling."
            : "Создать нового кандидата с новым digest после исправления причины отказа.",
          evidence: [pathForDisplay(relative(context.taskRoot, evidencePath)), ...normalizedEvidence],
          provenance,
        },
        "decision",
      );
      const record = {
        schema_version: SCHEMA_VERSION,
        identity_digest: identityDigest,
        ...identity,
        recorded_at: event.occurred_at,
        decision: normalizedDecision,
        summary: assertString(summary, "summary"),
        provenance: assertEnum(provenance, "provenance", PROVENANCE_VALUES),
        evidence: normalizedEvidence,
      };
      validateEvidenceRecord(record, evidencePath);
      const worktree = await this.harness.worktreeSnapshot(context.owner.root);
      const prepared = await this.harness.prepareEventMutation(context, event, { worktree });
      await ensureDirectoryChain(context.taskRoot, join(context.taskRoot, "experiments", "evidence"));
      await immutableWrite(evidencePath, prettyJson(record), "DUPLICATE_EVIDENCE");
      await this.harness.commitPreparedEventMutation(context, prepared);
      return { decision: record, evidencePath };
    });
  }

  async collectExperimentRecords() {
    const candidates = [];
    const evidence = [];
    for (const repository of this.harness.repositories) {
      const owner = await this.harness.resolveRepository(repository);
      const tasksRoot = join(owner.root, DOSSIER_ROOT);
      const rootMetadata = await optionalLstat(tasksRoot);
      if (rootMetadata === null) continue;
      await validateExistingPathChain(owner.root, tasksRoot, {
        stage: "experiment_projection",
        finalType: "directory",
        label: "Task registry",
      });
      const taskEntries = await readdir(tasksRoot, { withFileTypes: true });
      for (const taskEntry of taskEntries.filter((entry) => /^[A-Z][A-Z0-9]*-[0-9]+$/u.test(entry.name))) {
        if (!taskEntry.isDirectory()) {
          throw new CycleHarnessError({
            code: "UNSAFE_ENTRY",
            stage: "experiment_projection",
            path: join(tasksRoot, taskEntry.name),
            message: `Запись задачи должна быть обычным directory: ${taskEntry.name}`,
            expected: "directory",
            actual: taskEntry.isSymbolicLink() ? "symbolic link" : "другой тип",
            next: "Восстанови досье задачи в локальном task registry.",
          });
        }
        const taskRoot = join(tasksRoot, taskEntry.name);
        const context = await this.harness.acquireTask(repository, taskEntry.name);
        const candidateRoot = join(taskRoot, "experiments", "candidates");
        const evidenceRoot = join(taskRoot, "experiments", "evidence");
        const [candidateMetadata, evidenceMetadata] = await Promise.all([
          optionalLstat(candidateRoot),
          optionalLstat(evidenceRoot),
        ]);
        if (
          (candidateMetadata !== null && (candidateMetadata.isSymbolicLink() || !candidateMetadata.isDirectory()))
          || (evidenceMetadata !== null && (evidenceMetadata.isSymbolicLink() || !evidenceMetadata.isDirectory()))
        ) {
          throw new CycleHarnessError({
            code: "UNSAFE_ENTRY",
            stage: "experiment_projection",
            path: taskRoot,
            message: `Experiment registry имеет неполную или небезопасную структуру: ${taskRoot}`,
            expected: "missing либо обычные candidates/ и evidence/ directories",
            actual: "неподдерживаемый тип",
            next: "Освободи небезопасный path; отсутствующий пустой registry создаётся лениво.",
          });
        }
        const hasCandidateFiles = candidateMetadata?.isDirectory()
          ? (await readdir(candidateRoot)).some((name) => name.endsWith(".json"))
          : false;
        const hasEvidenceFiles = evidenceMetadata?.isDirectory()
          ? (await readdir(evidenceRoot)).some((name) => name.endsWith(".json"))
          : false;
        if (!hasCandidateFiles && !hasEvidenceFiles) continue;
        if (hasCandidateFiles) {
          for (const name of (await readdir(candidateRoot)).filter((item) => item.endsWith(".json")).sort()) {
            candidates.push({
              record: validateCandidateRecord(
                await readJson(join(candidateRoot, name), "experiment_projection"),
                join(candidateRoot, name),
              ),
              repository,
              taskId: taskEntry.name,
            });
          }
        }
        if (hasEvidenceFiles) {
          for (const name of (await readdir(evidenceRoot)).filter((item) => item.endsWith(".json")).sort()) {
            evidence.push({
              record: validateEvidenceRecord(
                await readJson(join(evidenceRoot, name), "experiment_projection"),
                join(evidenceRoot, name),
              ),
              repository,
              taskId: taskEntry.name,
              task: context.state.task,
            });
          }
        }
      }
    }
    return { candidates, evidence };
  }

  async candidateStatus(candidateRef) {
    const loaded = await this.loadCandidate(candidateRef);
    const records = await this.collectExperimentRecords();
    const uniqueEvidence = new Map();
    const logicalRuns = new Map();
    for (const item of records.evidence) {
      const record = item.record;
      if (record.candidate_ref !== loaded.reference.candidateRef) continue;
      if (record.owner?.repository !== item.repository || record.owner?.taskId !== item.taskId) {
        throw new CycleHarnessError({
          code: "OWNERSHIP_MISMATCH",
          stage: "experiment_projection",
          path: `${item.repository}/${item.taskId}`,
          message: "Evidence record объявляет владельца, отличного от содержащего dossier.",
          expected: `${item.repository}/${item.taskId}`,
          actual: `${record.owner?.repository ?? "unknown"}/${record.owner?.taskId ?? "unknown"}`,
          next: "Удалить подложенную запись и создать evidence штатной командой текущей задачи.",
        });
      }
      if (
        record.kind === "validation"
        && (
          record.task_pool?.class !== item.task.class
          || canonicalJson(record.task_pool?.facets ?? []) !== canonicalJson(item.task.facets)
        )
      ) {
        throw new CycleHarnessError({
          code: "EVIDENCE_TASK_POOL_MISMATCH",
          stage: "experiment_projection",
          path: `${item.repository}/${item.taskId}`,
          message: "Evidence task_pool не совпадает с контрактом содержащей задачи.",
          expected: `${item.task.class}; facets=${item.task.facets.join(",")}`,
          actual: `${record.task_pool?.class ?? "unknown"}; facets=${record.task_pool?.facets?.join(",") ?? "unknown"}`,
          next: "Восстанови immutable evidence или создай новый record в корректной задаче.",
        });
      }
      const expectedIdentityDigest = sha256(canonicalJson(
        record.kind === "validation"
          ? {
              kind: record.kind,
              candidate_ref: record.candidate_ref,
              owner: record.owner,
              scenario: record.scenario,
              scenario_id: record.scenario_id,
              run_key: record.run_key,
              variant_fingerprint: record.variant_fingerprint,
              target_worktree_fingerprint: record.target_worktree_fingerprint,
              task_worktree_fingerprint: record.task_worktree_fingerprint,
            }
          : {
              kind: record.kind,
              candidate_ref: record.candidate_ref,
              owner: record.owner,
              decision_id: record.decision_id,
              evidence_set_digest: record.evidence_set_digest,
            },
      ));
      if (expectedIdentityDigest !== record.identity_digest) {
        throw new CycleHarnessError({
          code: "EVIDENCE_DIGEST_MISMATCH",
          stage: "experiment_projection",
          path: `${item.repository}/${item.taskId}`,
          message: `Evidence identity повреждена: ${record.identity_digest ?? "missing"}.`,
          expected: expectedIdentityDigest,
          actual: record.identity_digest ?? "missing",
          next: "Восстанови immutable evidence из доверенной копии.",
        });
      }
      if (
        record.kind === "validation"
        && (
          record.variant_fingerprint !== loaded.candidate.variant_fingerprint
          || record.variant?.variant_fingerprint !== loaded.candidate.variant_fingerprint
          || record.target_worktree_fingerprint !== record.variant?.target_worktree_fingerprint
          || record.target_worktree_fingerprint !== record.variant?.target_worktree?.fingerprint
          || record.task_worktree_fingerprint !== record.task_worktree?.fingerprint
          || record.variant?.target_repository !== loaded.candidate.identity.target.repository
          || record.variant?.baseline_sha !== loaded.candidate.identity.target.baseline_sha
          || canonicalJson(record.variant?.verified_paths ?? []) !== canonicalJson(
            loaded.candidate.identity.overlay.map((change) => ({
              path: change.target,
              after: change.after === null
                ? null
                : { mode: change.after.mode, sha256: change.after.sha256 },
            })),
          )
          || canonicalJson(record.variant?.target_worktree?.changed_paths ?? []) !== canonicalJson(
            loaded.candidate.identity.overlay.map((change) => change.target).sort(),
          )
          || record.evaluation?.rubric_version !== loaded.candidate.identity.rubric.version
          || record.evaluation?.rubric_digest !== loaded.candidate.identity.rubric.sha256
          || record.evaluation?.eval_version !== loaded.candidate.identity.evaluation.version
          || record.evaluation?.eval_digest !== loaded.candidate.identity.evaluation.sha256
        )
      ) {
        throw new CycleHarnessError({
          code: "EVIDENCE_VARIANT_MISMATCH",
          stage: "experiment_projection",
          path: record.identity_digest,
          message: "Evidence не связано с точным variant/rubric/evaluation кандидата.",
          expected: loaded.candidate.variant_fingerprint,
          actual: record.variant_fingerprint ?? "missing",
          next: "Повтори проверку после применения immutable overlay кандидата.",
        });
      }
      if (record.kind === "validation") {
        const runKey = validationRunKey(record);
        const duplicateRun = logicalRuns.get(runKey);
        if (duplicateRun && duplicateRun.record.identity_digest !== record.identity_digest) {
          throw new CycleHarnessError({
            code: "EVIDENCE_RUN_CONFLICT",
            stage: "experiment_projection",
            path: record.identity_digest,
            message: "Один logical run содержит несколько evidence records.",
            expected: duplicateRun.record.identity_digest,
            actual: record.identity_digest,
            next: "Восстанови единственную append-only запись exact run.",
          });
        }
        logicalRuns.set(runKey, duplicateRun ?? { ...item, record });
      }
      const duplicate = uniqueEvidence.get(record.identity_digest);
      if (duplicate && canonicalJson(duplicate.record) !== canonicalJson(record)) {
        throw new CycleHarnessError({
          code: "EVIDENCE_IDENTITY_CONFLICT",
          stage: "experiment_projection",
          path: record.identity_digest,
          message: "Одна evidence identity содержит конфликтующие результаты.",
          expected: canonicalJson(duplicate.record),
          actual: canonicalJson(record),
          next: "Восстанови единственный immutable record для exact run identity.",
        });
      }
      uniqueEvidence.set(record.identity_digest, duplicate ?? { ...item, record });
    }
    const values = [...uniqueEvidence.values()];
    const technicalEvidenceDigest = validationEvidenceSetDigest(values);
    const passed = (scenario) => values.some(
      ({ record }) => record.kind === "validation" && record.scenario === scenario && record.result === "pass",
    );
    const freshPass = values.some(({ record, task }) => {
      if (record.kind !== "validation" || record.scenario !== "fresh-task" || record.result !== "pass") return false;
      const differentTask = record.owner.repository !== loaded.reference.repository || record.owner.taskId !== loaded.reference.taskId;
      const sameClass = task.class === loaded.candidate.identity.task_class;
      const facetsMatch = loaded.candidate.identity.facets.every((facet) => task.facets.includes(facet));
      return differentTask && sameClass && facetsMatch;
    });
    const failures = values.filter(({ record }) => record.kind === "validation" && record.result === "fail");
    const rejections = values.filter(({ record }) => record.kind === "decision" && record.decision === "rejected");
    const gates = {
      replay: passed("replay"),
      regression: passed("regression"),
      negative: passed("negative"),
      fresh_task: freshPass,
      human_approval: values.some(
        ({ record }) => record.kind === "decision"
          && record.decision === "approved"
          && record.evidence_set_digest === technicalEvidenceDigest,
      ),
    };
    const terminalStatus = rejections.length ? "rejected" : failures.length ? "failed" : null;
    const ready = Object.values(gates).every(Boolean) && terminalStatus === null;
    const nextUnmetGate = terminalStatus === null
      ? Object.entries(gates).find(([, passed]) => !passed)?.[0] ?? null
      : null;
    const nextAction = terminalStatus
      ? "Создать нового кандидата с новым digest после исправления причины fail/rejected."
      : nextUnmetGate
        ? `Закрыть gate ${nextUnmetGate}.`
        : "Рассмотреть promotion в отдельной задаче канонического владельца.";
    return {
      candidate: loaded.candidate,
      gates,
      technical_evidence_digest: technicalEvidenceDigest,
      next_unmet_gate: nextUnmetGate,
      next_action: nextAction,
      evidence_count: values.length,
      evidence: values.map(({ record }) => ({
        identity: record.identity_digest,
        owner: record.owner,
        kind: record.kind,
        scenario: record.scenario ?? null,
        result: record.result ?? record.decision,
        summary: record.summary,
        references: record.evidence,
        target_worktree: record.kind === "validation"
          ? {
              fingerprint: record.variant.target_worktree.fingerprint,
              tracked_diff_sha256: record.variant.target_worktree.tracked_diff_sha256,
              changed_paths: record.variant.target_worktree.changed_paths,
            }
          : null,
        task_worktree: record.kind === "validation"
          ? {
              fingerprint: record.task_worktree.fingerprint,
              tracked_diff_sha256: record.task_worktree.tracked_diff_sha256,
              changed_paths: record.task_worktree.changed_paths,
            }
          : null,
        verification_worktree: record.kind === "validation"
          ? {
              fingerprint: record.variant.verification_worktree.fingerprint,
              tracked_diff_sha256: record.variant.verification_worktree.tracked_diff_sha256,
              changed_paths: record.variant.verification_worktree.changed_paths,
            }
          : null,
      })),
      failures: failures.map(({ record }) => record.identity_digest),
      rejections: rejections.map(({ record }) => record.identity_digest),
      status: terminalStatus ?? (ready ? "ready-for-promotion" : "collecting-evidence"),
      ready_for_promotion: ready,
    };
  }

  async listCandidates({ taskClass, facets = [] } = {}) {
    const normalizedClass = taskClass === undefined ? null : assertEnum(taskClass, "task_class", TASK_CLASSES);
    const normalizedFacetFilter = facets.length ? normalizedFacets(facets) : [];
    const records = await this.collectExperimentRecords();
    const candidates = [];
    for (const { record } of records.candidates) {
      if (normalizedClass && record.identity.task_class !== normalizedClass) continue;
      if (normalizedFacetFilter.some((facet) => !record.identity.facets.includes(facet))) continue;
      candidates.push(await this.candidateStatus(record.candidate_ref));
    }
    return candidates;
  }
}
