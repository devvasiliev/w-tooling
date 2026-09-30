import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { loadProject } from "./project-config.mjs";
import {
  assertEnum,
  assertString,
  assertTaskId,
  canonicalJson,
  CycleHarnessError,
  DOSSIER_ROOT,
  durationOrNull,
  escapesRoot,
  EVENT_TYPES,
  EXPERIMENT_SCENARIOS,
  HANDOFF_RESULTS,
  normalizedFacets,
  normalizedStrings,
  nowIso,
  pathForDisplay,
  preflightEventMutation,
  prettyJson,
  PROVENANCE_VALUES,
  SCHEMA_VERSION,
  sha256,
  TASK_CLASSES,
  timestampForFile,
  transitionTaskStatus,
  USER_EVENT_TYPES,
  validateEventRecord,
  validateStateRecord,
} from "./cycle-harness/core.mjs";
import {
  assertSafeTree,
  atomicWrite,
  ensureDirectoryChain,
  immutableWrite,
  optionalLstat,
  readJson,
  refreshIntegrity,
  validateDirectory,
  validateExistingPathChain,
  verifyIntegrity,
} from "./cycle-harness/safe-files.mjs";
import {
  calculateMetrics,
  renderCheckpoint,
  renderContract,
  renderCurrent,
  renderEmptyReview,
  renderEvent,
  renderInitialJournal,
  renderReview,
  readTaskEvents,
  validateTaskLedger,
} from "./cycle-harness/dossier.mjs";
import {
  captureWorktreeSnapshot,
  compareWorktreeSnapshots,
} from "./cycle-harness/worktree.mjs";
import { CycleExperimentService } from "./cycle-harness/experiments.mjs";

const execFile = promisify(execFileCallback);

export { CycleHarnessError, transitionTaskStatus } from "./cycle-harness/core.mjs";

/**
 * Узкий публичный фасад cycle harness.
 *
 * Инварианты:
 * - одна задача принадлежит одному зарегистрированному direct-child repository;
 * - mutable summary обновляется только под task lock и после integrity check;
 * - события, checkpoints, candidates и evidence записываются append-only;
 * - resume сравнивает Git/worktree state, а не состояние контекста чата;
 * - promotion harness никогда не выполняется этим API автоматически.
 *
 * Пользовательские точки входа: init/add/checkpoint/resume/review и пять
 * experiment-команд. Остальные методы — адаптеры модулей и не являются CLI API.
 */
export class CycleHarness {
  constructor({ workspaceRoot, repositories, clock = () => new Date() }) {
    if (!repositories) {
      const project = loadProject();
      workspaceRoot ??= project.workspace;
      repositories = project.repositories;
    }
    this.workspaceRoot = resolve(assertString(workspaceRoot, "workspaceRoot"));
    this.repositoryPaths = new Map(repositories.map(entry => typeof entry === "string" ? [entry, entry] : [entry.name, entry.path]));
    this.repositories = Object.freeze([...this.repositoryPaths.keys()].map(name => assertString(name, "repository")));
    this.repositorySet = new Set(this.repositories);
    this.clock = clock;
    this.experimentService = new CycleExperimentService(this);
  }

  async git(repositoryRoot, args, stage = "git") {
    try {
      return await execFile("git", args, {
        cwd: repositoryRoot,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      throw new CycleHarnessError({
        code: "GIT_COMMAND_FAILED",
        stage,
        path: repositoryRoot,
        message: `Git-команда завершилась ошибкой: git ${args.join(" ")}`,
        expected: "exit code 0",
        actual: error?.stderr?.toString("utf8").trim() || error.message,
        next: "Исправь состояние репозитория и повтори ту же команду.",
        details: { args },
      });
    }
  }

  async resolveRepository(repository) {
    const name = assertString(repository, "repository");
    if (!this.repositorySet.has(name)) {
      throw new CycleHarnessError({
        code: "UNKNOWN_REPOSITORY",
        stage: "repository_validation",
        path: name,
        message: `Репозиторий не зарегистрирован в workspace: ${name}`,
        expected: this.repositories.join(", "),
        actual: name,
        next: "Выбери зарегистрированный репозиторий-владелец задачи.",
      });
    }
    await validateDirectory(this.workspaceRoot, "workspace_validation", "Workspace root");
    const repositoryRoot = resolve(this.workspaceRoot, this.repositoryPaths.get(name));
    if (escapesRoot(this.workspaceRoot, repositoryRoot)) {
      throw new CycleHarnessError({
        code: "PATH_OUTSIDE_ROOT",
        stage: "repository_validation",
        path: repositoryRoot,
        message: `Репозиторий выходит за пределы workspace: ${repositoryRoot}`,
        expected: this.workspaceRoot,
        actual: repositoryRoot,
        next: "Исправь реестр workspace.",
      });
    }
    await validateDirectory(repositoryRoot, "repository_validation", `Repository ${name}`);
    const [workspaceReal, repositoryReal] = await Promise.all([
      realpath(this.workspaceRoot),
      realpath(repositoryRoot),
    ]);
    if (escapesRoot(workspaceReal, repositoryReal)) {
      throw new CycleHarnessError({
        code: "PATH_RESOLVES_OUTSIDE_ROOT",
        stage: "repository_validation",
        path: repositoryRoot,
        message: `Репозиторий разрешается за пределы workspace: ${repositoryRoot}`,
        expected: workspaceReal,
        actual: repositoryReal,
        next: "Замени ссылку обычным direct-child checkout.",
      });
    }
    const { stdout } = await this.git(repositoryRoot, ["rev-parse", "--show-toplevel"], "repository_validation");
    const gitRoot = resolve(stdout.toString("utf8").trim());
    if (gitRoot !== repositoryReal) {
      throw new CycleHarnessError({
        code: "NOT_DIRECT_GIT_REPOSITORY",
        stage: "repository_validation",
        path: repositoryRoot,
        message: `Task owner должен быть корнем direct-child Git-репозитория: ${repositoryRoot}`,
        expected: repositoryReal,
        actual: gitRoot,
        next: "Выбери корневой checkout зарегистрированного репозитория.",
      });
    }
    return { name, root: repositoryRoot };
  }

  taskDirectory(repositoryRoot, taskId) {
    return join(repositoryRoot, DOSSIER_ROOT, assertTaskId(taskId));
  }

  async worktreeSnapshot(repositoryRoot, { includePaths = null } = {}) {
    return captureWorktreeSnapshot({
      repositoryRoot,
      git: this.git.bind(this),
      includePaths,
    });
  }

  async acquireTask(repository, taskId, { verify = true } = {}) {
    const owner = await this.resolveRepository(repository);
    const code = assertTaskId(taskId);
    const taskRoot = this.taskDirectory(owner.root, code);
    await validateExistingPathChain(owner.root, taskRoot, {
      stage: "task_load",
      finalType: "directory",
      label: `Dossier ${code}`,
    });
    await assertSafeTree(taskRoot);
    const integrity = verify ? await verifyIntegrity(taskRoot) : null;
    const state = validateStateRecord(
      await readJson(join(taskRoot, "state.json"), "state_load"),
      join(taskRoot, "state.json"),
    );
    if (state?.task?.repository !== owner.name || state?.task?.taskId !== code) {
      throw new CycleHarnessError({
        code: "OWNERSHIP_MISMATCH",
        stage: "task_load",
        path: taskRoot,
        message: `Досье не принадлежит ${owner.name}/${code}.`,
        expected: `${owner.name}/${code}`,
        actual: `${state?.task?.repository ?? "unknown"}/${state?.task?.taskId ?? "unknown"}`,
        next: "Используй досье его фактического владельца.",
      });
    }
    if (verify) await validateTaskLedger(taskRoot, state);
    return { owner, taskId: code, taskRoot, state, integrity };
  }

  async withMutation(repository, taskId, callback) {
    const context = await this.acquireTask(repository, taskId, { verify: false });
    const lockPath = join(context.taskRoot, ".cycle.lock");
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
    } catch (error) {
      await handle?.close();
      if (error?.code === "EEXIST") {
        throw new CycleHarnessError({
          code: "TASK_LOCKED",
          stage: "task_lock",
          path: lockPath,
          message: `Досье уже изменяется другим процессом: ${context.taskId}.`,
          expected: "свободный lock",
          actual: "lock существует",
          next: "Дождись завершения процесса; stale lock удаляй только после проверки PID.",
        });
      }
      throw error;
    }
    await handle.close();
    try {
      await verifyIntegrity(context.taskRoot);
      context.state = validateStateRecord(
        await readJson(join(context.taskRoot, "state.json"), "state_load"),
        join(context.taskRoot, "state.json"),
      );
      await validateTaskLedger(context.taskRoot, context.state);
      const result = await callback(context);
      const integrity = await refreshIntegrity(context.taskRoot);
      return { ...result, integrity };
    } finally {
      await unlink(lockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  buildEvent(state, input, typeOverride) {
    const type = assertEnum(
      typeOverride ?? input.type,
      "type",
      typeOverride ? EVENT_TYPES : USER_EVENT_TYPES,
    );
    const result = input.result ?? "";
    if (type === "handoff") {
      assertEnum(result, "result", HANDOFF_RESULTS);
    }
    const event = {
      schema_version: SCHEMA_VERSION,
      sequence: state.sequence + 1,
      occurred_at: nowIso(this.clock),
      type,
      summary: assertString(input.summary, "summary"),
      phase: input.phase ? assertString(input.phase, "phase") : state.current.phase,
      provenance: assertEnum(input.provenance ?? "observed", "provenance", PROVENANCE_VALUES),
      duration_minutes: durationOrNull(input.durationMinutes),
      expected: input.expected ? assertString(input.expected, "expected") : "",
      actual: input.actual ? assertString(input.actual, "actual") : "",
      impact: input.impact ? assertString(input.impact, "impact") : "",
      result: result ? assertString(result, "result") : "",
      next: input.next ? assertString(input.next, "next") : "",
      blocker: input.blocker ? assertString(input.blocker, "blocker") : "",
      rollback: input.rollback ? assertString(input.rollback, "rollback") : "",
      cleanup: input.cleanup ? assertString(input.cleanup, "cleanup") : "",
      evidence: normalizedStrings(input.evidence, "evidence"),
      ...(input.contractAmendment ? { contract_amendment: input.contractAmendment } : {}),
    };
    preflightEventMutation(state, event);
    return event;
  }

  async prepareEventMutation(context, event, currentPatch = {}, statePatch = {}) {
    const eventName = `${String(event.sequence).padStart(4, "0")}-${event.type}.json`;
    const eventPath = join(context.taskRoot, "events", eventName);
    const nextStatus = preflightEventMutation(context.state, event, eventPath);
    const effectivePatch = Object.hasOwn(currentPatch, "worktree")
      ? currentPatch
      : { ...currentPatch, worktree: await this.worktreeSnapshot(context.owner.root) };
    const nextBlocker = event.type === "blocker-resolved"
      ? ""
      : event.blocker || context.state.current.blocker;
    const nextState = {
      ...context.state,
      ...statePatch,
      sequence: event.sequence,
      updated_at: event.occurred_at,
      last_event: pathForDisplay(relative(context.taskRoot, eventPath)),
      status: nextStatus,
      current: {
        ...context.state.current,
        phase: event.phase || context.state.current.phase,
        last_summary: event.summary,
        expected: event.expected || context.state.current.expected,
        actual: event.actual || context.state.current.actual,
        next: event.next || context.state.current.next,
        blocker: nextBlocker,
        rollback: event.rollback || context.state.current.rollback,
        cleanup: event.cleanup || context.state.current.cleanup,
        ...effectivePatch,
      },
    };
    validateStateRecord(nextState, join(context.taskRoot, "state.json"));
    const journalPath = join(context.taskRoot, "journal.md");
    const journal = await readFile(journalPath, "utf8");
    return {
      event,
      eventPath,
      nextState,
      eventContent: prettyJson(event),
      journalPath,
      journalContent: `${journal.trimEnd()}\n\n${renderEvent(event)}`,
      statePath: join(context.taskRoot, "state.json"),
      stateContent: prettyJson(nextState),
      currentPath: join(context.taskRoot, "current.md"),
      currentContent: renderCurrent(nextState),
      contractPath: join(context.taskRoot, "contract.md"),
      contractContent: Object.hasOwn(statePatch, "task") || Object.hasOwn(statePatch, "contract_revision")
        ? renderContract(nextState)
        : null,
    };
  }

  async commitPreparedEventMutation(context, prepared) {
    await immutableWrite(prepared.eventPath, prepared.eventContent);
    await atomicWrite(prepared.journalPath, prepared.journalContent);
    context.state = prepared.nextState;
    await atomicWrite(prepared.statePath, prepared.stateContent);
    await atomicWrite(prepared.currentPath, prepared.currentContent);
    if (prepared.contractContent !== null) {
      await atomicWrite(prepared.contractPath, prepared.contractContent);
    }
    const { event, eventPath } = prepared;
    return { event, eventPath };
  }

  async appendEventMutation(context, event, currentPatch = {}, statePatch = {}) {
    const prepared = await this.prepareEventMutation(context, event, currentPatch, statePatch);
    return this.commitPreparedEventMutation(context, prepared);
  }

  async initTask({ repository, taskId, title, taskClass, facets, qualityCriteria, scope = [], nonGoals = [], checks = [], provenance = "observed" }) {
    const owner = await this.resolveRepository(repository);
    const code = assertTaskId(taskId);
    const normalizedClass = assertEnum(taskClass, "task_class", TASK_CLASSES);
    const normalizedProvenance = assertEnum(provenance, "provenance", PROVENANCE_VALUES);
    const taskRoot = this.taskDirectory(owner.root, code);
    if ((await optionalLstat(taskRoot)) !== null) {
      throw new CycleHarnessError({
        code: "TASK_EXISTS",
        stage: "task_init",
        path: taskRoot,
        message: `Досье ${code} уже существует.`,
        expected: "отсутствующий task directory",
        actual: "directory уже существует",
        next: "Используй task resume или другой код задачи.",
      });
    }
    const parent = dirname(taskRoot);
    await ensureDirectoryChain(owner.root, parent);
    const stagedRoot = join(parent, `.tmp-${code}-${randomUUID()}`);
    const createdAt = nowIso(this.clock);
    const worktree = await this.worktreeSnapshot(owner.root);
    const state = {
      schema_version: SCHEMA_VERSION,
      task: {
        repository: owner.name,
        taskId: code,
        title: assertString(title, "title"),
        class: normalizedClass,
        facets: normalizedFacets(facets),
        quality_criteria: normalizedStrings(qualityCriteria, "quality_criteria", { required: true }),
        scope: normalizedStrings(scope, "scope"),
        non_goals: normalizedStrings(nonGoals, "non_goals"),
        checks: normalizedStrings(checks, "checks"),
        provenance: normalizedProvenance,
      },
      status: "active",
      contract_revision: 1,
      migrations: { blocker_lifecycle_strict_from: 1 },
      created_at: createdAt,
      updated_at: createdAt,
      sequence: 1,
      checkpoint_sequence: 0,
      current_checkpoint: null,
      last_event: "events/0001-initialization.json",
      current: {
        phase: "Инициализация",
        last_summary: "Создано досье задачи",
        expected: "Зафиксировать контракт качества и воспроизводимую точку продолжения.",
        actual: normalizedProvenance === "reconstructed"
          ? "Начальный контекст восстановлен ретроспективно; неизвестные длительности не измерены."
          : "Начальный контракт зафиксирован до выполнения задачи.",
        next: "Зафиксировать первый значимый этап или checkpoint.",
        blocker: "",
        rollback: "Удалить новое досье, если код задачи или владелец выбраны ошибочно.",
        cleanup: "Не требуется.",
        worktree,
      },
    };
    const initialEvent = {
      schema_version: SCHEMA_VERSION,
      sequence: 1,
      occurred_at: createdAt,
      type: "initialization",
      summary: "Создано досье задачи",
      phase: "Инициализация",
      provenance: normalizedProvenance,
      duration_minutes: null,
      expected: state.current.expected,
      actual: state.current.actual,
      impact: "Появилась независимая от контекста чата точка восстановления.",
      result: "",
      next: state.current.next,
      blocker: "",
      rollback: state.current.rollback,
      cleanup: state.current.cleanup,
      evidence: [],
    };
    validateStateRecord(state, join(stagedRoot, "state.json"));
    validateEventRecord(initialEvent, join(stagedRoot, "events", "0001-initialization.json"));
    try {
      await mkdir(stagedRoot, { mode: 0o700 });
      await Promise.all([
        mkdir(join(stagedRoot, "events")),
        mkdir(join(stagedRoot, "checkpoints")),
        mkdir(join(stagedRoot, "experiments", "candidates"), { recursive: true }),
        mkdir(join(stagedRoot, "experiments", "evidence"), { recursive: true }),
      ]);
      await Promise.all([
        atomicWrite(join(stagedRoot, "contract.md"), renderContract(state)),
        atomicWrite(join(stagedRoot, "current.md"), renderCurrent(state)),
        atomicWrite(join(stagedRoot, "journal.md"), renderInitialJournal(initialEvent)),
        atomicWrite(join(stagedRoot, "review.md"), renderEmptyReview(code)),
        atomicWrite(join(stagedRoot, "state.json"), prettyJson(state)),
        immutableWrite(join(stagedRoot, "events", "0001-initialization.json"), prettyJson(initialEvent)),
      ]);
      const integrity = await refreshIntegrity(stagedRoot);
      await rename(stagedRoot, taskRoot);
      return { repository: owner.name, taskId: code, taskRoot, state, integrity };
    } catch (error) {
      await rm(stagedRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async addTaskEvent({ repository, taskId, ...input }) {
    return this.withMutation(repository, taskId, async (context) => {
      const event = this.buildEvent(context.state, input);
      const result = await this.appendEventMutation(context, event);
      return { ...result, state: context.state };
    });
  }

  async checkpointTask({ repository, taskId, stage, expected, actual, next, blocker = "", rollback = "", cleanup = "", evidence = [], provenance = "observed", durationMinutes }) {
    return this.withMutation(repository, taskId, async (context) => {
      const worktree = await this.worktreeSnapshot(context.owner.root);
      const checkpointNumber = context.state.checkpoint_sequence + 1;
      const effectiveBlocker = blocker || context.state.current.blocker;
      const effectiveRollback = rollback || context.state.current.rollback;
      const effectiveCleanup = cleanup || context.state.current.cleanup;
      const event = this.buildEvent(
        context.state,
        {
          summary: `Checkpoint ${checkpointNumber}: ${assertString(stage, "stage")}`,
          phase: stage,
          expected,
          actual,
          next,
          blocker: effectiveBlocker,
          rollback: effectiveRollback,
          cleanup: effectiveCleanup,
          evidence,
          provenance,
          durationMinutes,
        },
        "checkpoint",
      );
      const checkpointName = `${String(checkpointNumber).padStart(4, "0")}-${timestampForFile(event.occurred_at)}.md`;
      const checkpointPath = join(context.taskRoot, "checkpoints", checkpointName);
      const statePatch = {
        checkpoint_sequence: checkpointNumber,
        current_checkpoint: pathForDisplay(relative(context.taskRoot, checkpointPath)),
      };
      const prepared = await this.prepareEventMutation(context, event, { worktree }, statePatch);
      await ensureDirectoryChain(context.taskRoot, dirname(checkpointPath));
      await immutableWrite(
        checkpointPath,
        renderCheckpoint({ checkpointNumber, state: context.state, event, worktree }),
      );
      const result = await this.commitPreparedEventMutation(context, prepared);
      return { ...result, checkpointPath, worktree, state: context.state };
    });
  }

  async resumeTask({ repository, taskId }) {
    const context = await this.acquireTask(repository, taskId);
    const worktree = await this.worktreeSnapshot(context.owner.root);
    const checkpoint = context.state.current.worktree;
    const divergence = compareWorktreeSnapshots(checkpoint, worktree);
    return {
      repository: context.owner.name,
      taskId: context.taskId,
      current: context.state.current,
      current_checkpoint: context.state.current_checkpoint,
      integrity: context.integrity,
      worktree,
      drift: checkpoint && divergence.fingerprint_comparable
        ? checkpoint.fingerprint !== worktree.fingerprint
        : null,
      divergence,
      current_markdown: await readFile(join(context.taskRoot, "current.md"), "utf8"),
    };
  }

  async reviewTask({ repository, taskId, outcome, summary, worked = [], failed = [], hypotheses = [], nextActions = [] }) {
    const normalizedOutcome = assertEnum(outcome, "outcome", new Set(["accepted", "partial", "rejected"]));
    return this.withMutation(repository, taskId, async (context) => {
      const events = await readTaskEvents(context.taskRoot);
      const metrics = calculateMetrics(events);
      const normalizedSummary = assertString(summary, "summary");
      const normalizedWorked = normalizedStrings(worked, "worked");
      const normalizedFailed = normalizedStrings(failed, "failed");
      const normalizedHypotheses = normalizedStrings(hypotheses, "hypotheses");
      const normalizedNextActions = normalizedStrings(nextActions, "next_actions");
      const event = this.buildEvent(
        context.state,
        {
          summary: `Выполнен разбор: ${normalizedSummary}`,
          phase: "Ретроспектива",
          result: normalizedOutcome,
          next: context.state.current.blocker
            ? context.state.current.next
            : normalizedNextActions[0] ?? "Решение о следующем эксперименте принимает человек.",
          evidence: ["review.md"],
        },
        "review",
      );
      const review = renderReview({
        state: context.state,
        outcome: normalizedOutcome,
        summary: normalizedSummary,
        worked: normalizedWorked,
        failed: normalizedFailed,
        hypotheses: normalizedHypotheses,
        nextActions: normalizedNextActions,
        metrics,
        reviewedAt: event.occurred_at,
      });
      const worktree = await this.worktreeSnapshot(context.owner.root);
      const prepared = await this.prepareEventMutation(context, event, { worktree });
      await atomicWrite(join(context.taskRoot, "review.md"), review);
      await this.commitPreparedEventMutation(context, prepared);
      return { review, metrics, state: context.state };
    });
  }

  async migrateBlockerLifecycle({ repository, taskId }) {
    return this.withMutation(repository, taskId, async (context) => {
      if (context.state.migrations?.blocker_lifecycle_strict_from !== undefined) {
        throw new CycleHarnessError({
          code: "MIGRATION_ALREADY_APPLIED",
          stage: "dossier_migration",
          path: join(context.taskRoot, "state.json"),
          message: "Строгая blocker state machine уже включена для этого dossier.",
          expected: "legacy dossier без blocker lifecycle marker",
          actual: String(context.state.migrations.blocker_lifecycle_strict_from),
          next: "Продолжай обычными blocker/blocker-resolved событиями.",
        });
      }
      const event = this.buildEvent(
        context.state,
        {
          summary: "Зафиксирована граница строгой blocker state machine",
          phase: "Миграция досье",
          expected: "Исторические события сохраняются, новые blocker нельзя заменять без явного resolution",
          actual: `Legacy lifecycle разрешён только до sequence ${context.state.sequence}`,
          impact: "Ledger воспроизводит исторический blocker, а все следующие события проверяются строго",
          result: "blocker-lifecycle-v1",
          next: context.state.current.next,
          evidence: ["state.json#migrations.blocker_lifecycle_strict_from"],
        },
        "migration",
      );
      const migrations = {
        ...(context.state.migrations ?? {}),
        blocker_lifecycle_strict_from: event.sequence + 1,
      };
      const result = await this.appendEventMutation(context, event, {}, { migrations });
      return { ...result, state: context.state };
    });
  }

  async amendTaskContract({
    repository,
    taskId,
    summary,
    facets = [],
    qualityCriteria = [],
    scope = [],
    nonGoals = [],
    checks = [],
    removeFacets = [],
    removeQualityCriteria = [],
    removeScope = [],
    removeNonGoals = [],
    removeChecks = [],
    provenance = "observed",
  }) {
    return this.withMutation(repository, taskId, async (context) => {
      const additions = {
        facets: facets.length ? normalizedFacets(facets) : [],
        quality_criteria: normalizedStrings(qualityCriteria, "quality_criteria"),
        scope: normalizedStrings(scope, "scope"),
        non_goals: normalizedStrings(nonGoals, "non_goals"),
        checks: normalizedStrings(checks, "checks"),
      };
      const removalValues = {
        facets: removeFacets.length ? normalizedFacets(removeFacets) : [],
        quality_criteria: normalizedStrings(removeQualityCriteria, "remove_quality_criteria"),
        scope: normalizedStrings(removeScope, "remove_scope"),
        non_goals: normalizedStrings(removeNonGoals, "remove_non_goals"),
        checks: normalizedStrings(removeChecks, "remove_checks"),
      };
      const isEmptyDelta = [additions, removalValues].every((delta) =>
        Object.values(delta).every((values) => values.length === 0));
      if (isEmptyDelta) {
        throw new CycleHarnessError({
          code: "EMPTY_CONTRACT_AMENDMENT",
          stage: "contract_amendment",
          path: join(context.taskRoot, "contract.md"),
          message: "Contract amendment не содержит изменений.",
          expected: "хотя бы одно точное добавление или удаление",
          actual: "0 добавлений; 0 удалений",
          next: "Передай точный delta контракта.",
        });
      }
      for (const [field, values] of Object.entries(additions)) {
        const conflicts = values.filter((value) => removalValues[field].includes(value));
        if (conflicts.length) {
          throw new CycleHarnessError({
            code: "CONTRACT_ITEM_CONFLICT",
            stage: "contract_amendment",
            path: `task.${field}`,
            message: `Один amendment одновременно добавляет и удаляет элементы: ${conflicts.join("; ")}.`,
            expected: "непересекающиеся additions и removals",
            actual: conflicts.join("; "),
            next: "Оставь для каждого значения только одну операцию.",
          });
        }
        const duplicates = values.filter((value) => context.state.task[field].includes(value));
        if (duplicates.length) {
          throw new CycleHarnessError({
            code: "CONTRACT_ITEM_EXISTS",
            stage: "contract_amendment",
            path: `task.${field}`,
            message: `Contract amendment повторяет существующие элементы: ${duplicates.join("; ")}.`,
            expected: "только новые immutable additions",
            actual: duplicates.join("; "),
            next: "Удали дублирующиеся значения из amendment.",
          });
        }
        const missing = removalValues[field].filter((value) => !context.state.task[field].includes(value));
        if (missing.length) {
          throw new CycleHarnessError({
            code: "CONTRACT_ITEM_MISSING",
            stage: "contract_amendment",
            path: `task.${field}`,
            message: `Contract amendment удаляет отсутствующие элементы: ${missing.join("; ")}.`,
            expected: "точные значения из текущего effective contract",
            actual: missing.join("; "),
            next: "Скопируй удаляемый пункт из текущего contract.md без перефразирования.",
          });
        }
      }
      const removals = Object.fromEntries(
        Object.entries(removalValues).map(([field, values]) => [
          field,
          values
            .map((value) => ({ value, index: context.state.task[field].indexOf(value) }))
            .sort((left, right) => left.index - right.index),
        ]),
      );
      const nextTask = {
        ...context.state.task,
        facets: [
          ...context.state.task.facets.filter((value) => !removalValues.facets.includes(value)),
          ...additions.facets,
        ].sort(),
        quality_criteria: [
          ...context.state.task.quality_criteria.filter((value) => !removalValues.quality_criteria.includes(value)),
          ...additions.quality_criteria,
        ],
        scope: [
          ...context.state.task.scope.filter((value) => !removalValues.scope.includes(value)),
          ...additions.scope,
        ],
        non_goals: [
          ...context.state.task.non_goals.filter((value) => !removalValues.non_goals.includes(value)),
          ...additions.non_goals,
        ],
        checks: [
          ...context.state.task.checks.filter((value) => !removalValues.checks.includes(value)),
          ...additions.checks,
        ],
      };
      for (const field of ["facets", "quality_criteria"]) {
        if (nextTask[field].length === 0) {
          throw new CycleHarnessError({
            code: "CONTRACT_REQUIRED_ITEMS_EMPTY",
            stage: "contract_amendment",
            path: `task.${field}`,
            message: `Contract amendment удаляет все обязательные элементы ${field}.`,
            expected: "хотя бы один effective item",
            actual: "0 элементов",
            next: "Сохрани или добавь хотя бы один актуальный пункт.",
          });
        }
      }
      const revision = (context.state.contract_revision ?? 1) + 1;
      const amendment = {
        revision,
        before_digest: sha256(canonicalJson(context.state.task)),
        after_digest: sha256(canonicalJson(nextTask)),
        additions,
        removals,
      };
      const event = this.buildEvent(
        context.state,
        {
          summary: `Contract amendment ${revision}: ${assertString(summary, "summary")}`,
          phase: "Уточнение контракта",
          expected: "Human contract и machine state получают один immutable exact delta",
          actual: Object.keys(additions)
            .map((field) => {
              const added = additions[field].length;
              const removed = removals[field].length;
              return added || removed ? `${field}: +${added}/-${removed}` : "";
            })
            .filter(Boolean)
            .join("; "),
          impact: "Следующие resume/review используют актуальный effective acceptance contract",
          next: context.state.current.next,
          provenance,
          evidence: ["contract.md", "state.json#task"],
          contractAmendment: amendment,
        },
        "contract-amendment",
      );
      const result = await this.appendEventMutation(
        context,
        event,
        {},
        { task: nextTask, contract_revision: revision },
      );
      return { ...result, amendment, state: context.state };
    });
  }
  async createCandidate(input) {
    return this.experimentService.createCandidate(input);
  }

  async recordEvidence(input) {
    return this.experimentService.recordEvidence(input);
  }

  async recordDecision(input) {
    return this.experimentService.recordDecision(input);
  }

  async candidateStatus(candidateRef) {
    return this.experimentService.candidateStatus(candidateRef);
  }

  async listCandidates(filters = {}) {
    return this.experimentService.listCandidates(filters);
  }
}

export const cycleHarnessConstants = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  taskClasses: Object.freeze([...TASK_CLASSES]),
  eventTypes: Object.freeze([...EVENT_TYPES]),
  experimentScenarios: Object.freeze([...EXPERIMENT_SCENARIOS]),
});
