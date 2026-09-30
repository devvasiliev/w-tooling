import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CycleHarness,
  CycleHarnessError,
  transitionTaskStatus,
} from "./cycle-harness-lib.mjs";
import { runCycleCli } from "./cycle-harness.mjs";
import { refreshIntegrity } from "./cycle-harness/safe-files.mjs";

const execFile = promisify(execFileCallback);

function advancingClock() {
  let offset = 0;
  return () => new Date(Date.UTC(2026, 7, 25, 10, 0, offset++));
}

function controllableClock(initial) {
  let value = new Date(initial);
  return {
    clock: () => new Date(value),
    set: (next) => { value = new Date(next); },
  };
}

async function git(repositoryRoot, args) {
  return execFile("git", args, { cwd: repositoryRoot, encoding: "utf8" });
}

async function createRepository(workspaceRoot, name) {
  const repositoryRoot = join(workspaceRoot, name);
  await mkdir(join(repositoryRoot, "src"), { recursive: true });
  await writeFile(join(repositoryRoot, "src", "app.txt"), "baseline\n");
  await git(repositoryRoot, ["init", "--initial-branch=master"]);
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, [
    "-c",
    "user.name=Cycle Test",
    "-c",
    "user.email=cycle@example.test",
    "commit",
    "-m",
    "baseline",
  ]);
  return repositoryRoot;
}

function taskInput(repository, taskId, overrides = {}) {
  return {
    repository,
    taskId,
    title: `Задача ${taskId}`,
    taskClass: "tooling",
    facets: ["agent-workflow", "memory"],
    qualityCriteria: ["Результат воспроизводится человеком"],
    scope: ["Task dossier"],
    nonGoals: ["Автоматическое изменение harness"],
    checks: ["node --test"],
    provenance: "observed",
    ...overrides,
  };
}

async function rejectsCycleError(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CycleHarnessError);
    assert.equal(error.code, expected.code);
    assert.equal(error.stage, expected.stage);
    if (expected.path !== undefined) assert.equal(error.path, expected.path);
    return true;
  });
}

async function directorySnapshot(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const snapshot = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(prefix, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await directorySnapshot(root, child));
    } else if (entry.isFile()) {
      const metadata = await lstat(join(root, child));
      snapshot[relative(root, join(root, child))] = {
        content: (await readFile(join(root, child))).toString("base64"),
        mode: metadata.mode & 0o777,
      };
    } else {
      snapshot[relative(root, join(root, child))] = { type: "other" };
    }
  }
  return snapshot;
}

test("ведёт human-readable dossier, различает worktree drift и собственную целостность", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-cycle-dossier-"));
  try {
    const repositoryRoot = await createRepository(workspaceRoot, "repo-a");
    const harness = new CycleHarness({
      workspaceRoot,
      repositories: ["repo-a"],
      clock: advancingClock(),
    });
    const initialized = await harness.initTask(taskInput("repo-a", "W-101", {
      provenance: "reconstructed",
    }));
    assert.match(await readFile(join(initialized.taskRoot, "contract.md"), "utf8"), /Что считается хорошо выполненной задачей/u);
    assert.match(await readFile(join(initialized.taskRoot, "journal.md"), "utf8"), /Сырые чаты, chain-of-thought, секреты/u);

    await harness.checkpointTask({
      repository: "repo-a",
      taskId: "W-101",
      stage: "Проектирование",
      expected: "Получить проверяемую модель",
      actual: "Модель зафиксирована",
      next: "Проверить реализацию",
      rollback: "Удалить экспериментальный кандидат",
      cleanup: "Удалить временный manifest",
      provenance: "reconstructed",
    });
    const cleanResume = await harness.resumeTask({ repository: "repo-a", taskId: "W-101" });
    assert.equal(cleanResume.drift, false);
    assert.deepEqual(cleanResume.worktree.changed_paths, []);

    await writeFile(join(repositoryRoot, "src", "app.txt"), "changed\n");
    const changedResume = await harness.resumeTask({ repository: "repo-a", taskId: "W-101" });
    assert.equal(changedResume.drift, true);
    assert.deepEqual(changedResume.worktree.changed_paths, ["src/app.txt"]);
    assert.deepEqual(changedResume.divergence.added, ["src/app.txt"]);

    await harness.checkpointTask({
      repository: "repo-a",
      taskId: "W-101",
      stage: "Грязное рабочее дерево",
      expected: "Локализовать повторную правку уже изменённого файла",
      actual: "src/app.txt уже изменён относительно HEAD",
      next: "Изменить тот же файл повторно",
    });
    await writeFile(join(repositoryRoot, "src", "app.txt"), "changed again\n");
    const dirtyFileResume = await harness.resumeTask({ repository: "repo-a", taskId: "W-101" });
    assert.equal(dirtyFileResume.drift, true);
    assert.deepEqual(dirtyFileResume.divergence.changed, ["src/app.txt"]);
    assert.deepEqual(dirtyFileResume.divergence.added, []);

    await harness.checkpointTask({
      repository: "repo-a",
      taskId: "W-101",
      stage: "Перед сменой ветки",
      expected: "Обнаружить branch divergence при том же HEAD",
      actual: "Зафиксирована ветка master",
      next: "Переключиться на другую ветку от того же commit",
    });
    await git(repositoryRoot, ["switch", "-c", "alternate"]);
    const branchResume = await harness.resumeTask({ repository: "repo-a", taskId: "W-101" });
    assert.equal(branchResume.drift, true);
    assert.equal(branchResume.divergence.branch_changed, true);
    assert.equal(branchResume.divergence.head_changed, false);
    assert.deepEqual(branchResume.divergence.changed, []);

    await harness.addTaskEvent({
      repository: "repo-a",
      taskId: "W-101",
      type: "failure",
      summary: "Реальный контур вернул ошибку",
      phase: "Проверка",
      expected: "Успешный запуск",
      actual: "Typed failure",
      durationMinutes: 7.08,
    });
    await harness.addTaskEvent({
      repository: "repo-a",
      taskId: "W-101",
      type: "human-correction",
      summary: "Человек уточнил slash-контракт",
      phase: "Проверка",
      provenance: "reconstructed",
    });
    await harness.addTaskEvent({
      repository: "repo-a",
      taskId: "W-101",
      type: "phase-finish",
      summary: "Проектирование завершено",
      phase: "Проектирование",
      durationMinutes: 12.09,
    });
    await harness.addTaskEvent({
      repository: "repo-a",
      taskId: "W-101",
      type: "handoff",
      summary: "Первая проверка результата",
      phase: "Приёмка",
      result: "rejected",
    });
    const review = await harness.reviewTask({
      repository: "repo-a",
      taskId: "W-101",
      outcome: "accepted",
      summary: "Нужна проверка на следующей задаче",
      worked: ["Checkpoints восстановили контекст"],
      failed: ["Первый handoff отклонён"],
      hypotheses: ["Явный rubric уменьшит число правок"],
      nextActions: ["Проверить кандидата на W-102"],
    });
    assert.equal(review.metrics.failures, 1);
    assert.equal(review.metrics.human_corrections, 1);
    assert.equal(review.metrics.handoff_attempts, 1);
    assert.equal(review.metrics.accepted_handoffs, 0);
    assert.equal(review.metrics.measured_minutes, 19.17);
    assert.equal(review.state.status, "reviewed");
    assert.match(review.review, /Событий без измерения: 6/u);
    assert.match(review.review, /Измеренное время: 19\.17 мин\./u);
    assert.match(await readFile(join(initialized.taskRoot, "journal.md"), "utf8"), /Длительность: не измерено/u);

    const resumedAfterReview = await harness.addTaskEvent({
      repository: "repo-a",
      taskId: "W-101",
      type: "human-correction",
      summary: "После review потребовалось уточнение",
      phase: "Повторная работа",
    });
    assert.equal(resumedAfterReview.state.status, "active");
    assert.throws(
      () => transitionTaskStatus("unknown", "event"),
      (error) => error instanceof CycleHarnessError && error.code === "INVALID_STATE_TRANSITION",
    );

    await writeFile(join(initialized.taskRoot, "journal.md"), "manual tamper\n");
    await rejectsCycleError(
      harness.resumeTask({ repository: "repo-a", taskId: "W-101" }),
      { code: "DOSSIER_INTEGRITY_MISMATCH", stage: "integrity_check" },
    );

    const second = await harness.initTask(taskInput("repo-a", "W-102"));
    await writeFile(join(second.taskRoot, "integrity.json"), "{invalid json\n");
    await rejectsCycleError(
      harness.resumeTask({ repository: "repo-a", taskId: "W-102" }),
      { code: "INVALID_JSON", stage: "integrity_load", path: join(second.taskRoot, "integrity.json") },
    );

    const third = await harness.initTask(taskInput("repo-a", "W-103"));
    const statePath = join(third.taskRoot, "state.json");
    const invalidState = JSON.parse(await readFile(statePath, "utf8"));
    invalidState.current.worktree.changed_paths = ["../escape"];
    invalidState.current.worktree.path_states = [];
    await writeFile(statePath, `${JSON.stringify(invalidState, null, 2)}\n`);
    await refreshIntegrity(third.taskRoot);
    await rejectsCycleError(
      harness.resumeTask({ repository: "repo-a", taskId: "W-103" }),
      { code: "INVALID_SCHEMA", stage: "schema_validation" },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("продолжает досье без первого checkpoint после clean checkout", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-cycle-clean-checkout-"));
  try {
    await createRepository(workspaceRoot, "repo-a");
    const harness = new CycleHarness({
      workspaceRoot,
      repositories: ["repo-a"],
      clock: advancingClock(),
    });
    const initialized = await harness.initTask(taskInput("repo-a", "W-111"));
    const checkpointRoot = join(initialized.taskRoot, "checkpoints");

    await rm(checkpointRoot, { recursive: true });
    const resumed = await harness.resumeTask({ repository: "repo-a", taskId: "W-111" });
    assert.equal(resumed.current_checkpoint, null);

    const checkpoint = await harness.checkpointTask({
      repository: "repo-a",
      taskId: "W-111",
      stage: "Первый checkpoint после clone",
      expected: "Восстановить отсутствующий пустой registry",
      actual: "Clean checkout не содержит пустой Git-каталог",
      next: "Продолжить задачу",
    });
    assert.equal((await lstat(checkpointRoot)).isDirectory(), true);
    assert.equal((await lstat(checkpoint.checkpointPath)).isFile(), true);

    await rm(checkpointRoot, { recursive: true });
    await refreshIntegrity(initialized.taskRoot);
    await rejectsCycleError(
      harness.resumeTask({ repository: "repo-a", taskId: "W-111" }),
      {
        code: "DOSSIER_STATE_MISMATCH",
        stage: "dossier_validation",
        path: checkpointRoot,
      },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("фиксирует file-directory refactor в обе стороны", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-cycle-directory-"));
  try {
    const repositoryRoot = await createRepository(workspaceRoot, "repo-a");
    const harness = new CycleHarness({
      workspaceRoot,
      repositories: ["repo-a"],
      clock: advancingClock(),
    });
    await harness.initTask(taskInput("repo-a", "W-110", { taskClass: "refactor" }));
    const refactorPath = join(repositoryRoot, "src", "app.txt");
    await rm(refactorPath, { force: true });
    await mkdir(refactorPath);
    await writeFile(join(refactorPath, "child.txt"), "directory form\n");

    const fileToDirectory = await harness.checkpointTask({
      repository: "repo-a",
      taskId: "W-110",
      stage: "File to directory",
      expected: "Сохранить обычную структурную замену",
      actual: "Tracked file заменён directory с новым child",
      next: "Проверить обратное преобразование",
    });
    const directoryStates = new Map(
      fileToDirectory.worktree.path_states.map((item) => [item.path, item.working]),
    );
    assert.deepEqual(directoryStates.get("src/app.txt"), { type: "directory" });
    assert.equal(directoryStates.get("src/app.txt/child.txt")?.type, "file");

    await git(repositoryRoot, ["add", "-A", "--", "src"]);
    await git(repositoryRoot, [
      "-c",
      "user.name=Cycle Test",
      "-c",
      "user.email=cycle@example.test",
      "commit",
      "-m",
      "directory baseline",
    ]);
    await rm(refactorPath, { recursive: true, force: true });
    await writeFile(refactorPath, "file form\n");

    const directoryToFile = await harness.checkpointTask({
      repository: "repo-a",
      taskId: "W-110",
      stage: "Directory to file",
      expected: "Сохранить обратную структурную замену",
      actual: "Tracked child удалён, parent path стал file",
      next: "Продолжить refactor",
    });
    const fileStates = new Map(
      directoryToFile.worktree.path_states.map((item) => [item.path, item.working]),
    );
    assert.equal(fileStates.get("src/app.txt")?.type, "file");
    assert.deepEqual(fileStates.get("src/app.txt/child.txt"), { type: "missing" });
    assert.equal((await harness.resumeTask({ repository: "repo-a", taskId: "W-110" })).drift, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("failed worktree preflight не оставляет partial review, candidate или decision", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-cycle-preflight-"));
  try {
    const repositoryRoot = await createRepository(workspaceRoot, "repo-a");
    const harness = new CycleHarness({
      workspaceRoot,
      repositories: ["repo-a"],
      clock: advancingClock(),
    });
    const initialized = await harness.initTask(taskInput("repo-a", "W-120"));
    const assets = join(repositoryRoot, "candidate-assets");
    await mkdir(assets);
    await writeFile(join(assets, "app-after.txt"), "candidate behavior\n");
    await writeFile(join(assets, "rubric.md"), "# Rubric\n");
    await writeFile(join(assets, "evaluation.md"), "# Evaluation\n");
    const manifest = {
      title: "Preflight-safe candidate",
      hypothesis: "Failed snapshot не оставляет partial artifacts",
      target_repository: "repo-a",
      changes: [{
        layer: "tooling",
        operation: "replace",
        target: "src/app.txt",
        content_path: "candidate-assets/app-after.txt",
        summary: "Меняет тестовый файл",
      }],
      rubric: { version: "rubric-1", path: "candidate-assets/rubric.md" },
      evaluation: { version: "eval-1", path: "candidate-assets/evaluation.md" },
      quality_criteria: ["Dossier остаётся byte-identical при отказе"],
      regression_scenarios: ["Snapshot failure"],
      negative_scenarios: ["Partial write"],
    };
    const originalSnapshot = harness.worktreeSnapshot.bind(harness);
    const rejectOnSnapshot = async (operation) => {
      const before = await directorySnapshot(initialized.taskRoot);
      harness.worktreeSnapshot = async () => {
        throw new CycleHarnessError({
          code: "GIT_COMMAND_FAILED",
          stage: "worktree_snapshot",
          path: repositoryRoot,
          message: "Injected worktree failure",
          expected: "snapshot",
          actual: "injected failure",
          next: "Повторить после восстановления worktree.",
        });
      };
      try {
        await rejectsCycleError(operation(), {
          code: "GIT_COMMAND_FAILED",
          stage: "worktree_snapshot",
        });
      } finally {
        harness.worktreeSnapshot = originalSnapshot;
      }
      assert.deepEqual(await directorySnapshot(initialized.taskRoot), before);
    };

    await rejectOnSnapshot(() => harness.reviewTask({
      repository: "repo-a",
      taskId: "W-120",
      outcome: "partial",
      summary: "Не должен сохраниться",
    }));
    await rejectOnSnapshot(() => harness.createCandidate({
      repository: "repo-a",
      taskId: "W-120",
      manifest,
    }));
    const created = await harness.createCandidate({
      repository: "repo-a",
      taskId: "W-120",
      manifest,
    });
    await rejectOnSnapshot(() => harness.recordDecision({
      repository: "repo-a",
      taskId: "W-120",
      candidateRef: created.candidate.candidate_ref,
      decisionId: "rejected-preflight",
      decision: "rejected",
      summary: "Не должен сохраниться",
    }));
    assert.equal((await harness.resumeTask({ repository: "repo-a", taskId: "W-120" })).drift, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("обновляет current worktree и снимает blocker только отдельным событием", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-cycle-blocker-"));
  try {
    const repositoryRoot = await createRepository(workspaceRoot, "repo-a");
    const harness = new CycleHarness({
      workspaceRoot,
      repositories: ["repo-a"],
      clock: advancingClock(),
    });
    const initialized = await harness.initTask(taskInput("repo-a", "W-150"));
    await writeFile(join(repositoryRoot, "src", "app.txt"), "blocked change\n");

    const blocked = await harness.addTaskEvent({
      repository: "repo-a",
      taskId: "W-150",
      type: "blocker",
      summary: "Реальный UI-host недоступен",
      phase: "Приёмка",
      expected: "Выбрать skill из slash-списка",
      actual: "Host не вернул UI-каталог",
      impact: "Обязательная приёмка остановлена",
      next: "Открыть свежий Desktop host",
      blocker: "Нужен свежий host со slash-каталогом",
      rollback: "Оставить skill неактивным",
      cleanup: "Закрыть временную TUI-сессию",
      evidence: ["logs/host-probe.txt"],
    });
    assert.equal(blocked.state.current.blocker, "Нужен свежий host со slash-каталогом");
    assert.deepEqual(blocked.state.current.worktree.changed_paths, ["src/app.txt"]);
    const currentAfterBlock = await readFile(join(initialized.taskRoot, "current.md"), "utf8");
    assert.match(currentAfterBlock, /Нужен свежий host со slash-каталогом/u);
    assert.match(currentAfterBlock, /`src\/app\.txt`/u);
    const journal = await readFile(join(initialized.taskRoot, "journal.md"), "utf8");
    assert.match(journal, /- Блокер: Нужен свежий host/u);
    assert.match(journal, /- Rollback: Оставить skill неактивным/u);
    assert.match(journal, /- Cleanup: Закрыть временную TUI-сессию/u);
    assert.match(journal, /- Evidence: logs\/host-probe\.txt/u);

    const beforeInvalidBlocker = await directorySnapshot(initialized.taskRoot);
    await rejectsCycleError(
      harness.addTaskEvent({
        repository: "repo-a",
        taskId: "W-150",
        type: "blocker",
        summary: "Причина не передана",
      }),
      { code: "BLOCKER_REASON_REQUIRED", stage: "event_preflight" },
    );
    assert.deepEqual(await directorySnapshot(initialized.taskRoot), beforeInvalidBlocker);
    await rejectsCycleError(
      harness.addTaskEvent({
        repository: "repo-a",
        taskId: "W-150",
        type: "blocker",
        summary: "Новая причина не должна заменить старую",
        blocker: "Другой blocker",
      }),
      { code: "ACTIVE_BLOCKER_EXISTS", stage: "event_preflight" },
    );
    assert.deepEqual(await directorySnapshot(initialized.taskRoot), beforeInvalidBlocker);

    const inheritedCheckpoint = await harness.checkpointTask({
      repository: "repo-a",
      taskId: "W-150",
      stage: "Проверка effective state",
      expected: "Checkpoint наследует active blocker, rollback и cleanup",
      actual: "Параметры повторно не переданы",
      next: "Открыть свежий Desktop host",
    });
    const inheritedCheckpointText = await readFile(inheritedCheckpoint.checkpointPath, "utf8");
    assert.match(inheritedCheckpointText, /Нужен свежий host со slash-каталогом/u);
    assert.match(inheritedCheckpointText, /Оставить skill неактивным/u);
    assert.match(inheritedCheckpointText, /Закрыть временную TUI-сессию/u);

    const unrelated = await harness.addTaskEvent({
      repository: "repo-a",
      taskId: "W-150",
      type: "milestone",
      summary: "Подготовлены локальные проверки",
    });
    assert.equal(unrelated.state.current.blocker, "Нужен свежий host со slash-каталогом");

    const blockedReview = await harness.reviewTask({
      repository: "repo-a",
      taskId: "W-150",
      outcome: "partial",
      summary: "Приёмка ещё заблокирована",
      nextActions: ["Будущий эксперимент не является immediate step"],
    });
    assert.equal(blockedReview.state.current.next, "Открыть свежий Desktop host");

    const resolved = await harness.addTaskEvent({
      repository: "repo-a",
      taskId: "W-150",
      type: "blocker-resolved",
      summary: "Skill выбран в свежем slash-каталоге",
      actual: "Запуск дошёл до штатного task resume",
    });
    assert.equal(resolved.state.current.blocker, "");
    assert.match(await readFile(join(initialized.taskRoot, "current.md"), "utf8"), /## Блокер\n\nнет/u);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("мигрирует legacy blocker lifecycle и версионирует contract amendments", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-cycle-amendment-"));
  try {
    await createRepository(workspaceRoot, "repo-a");
    const harness = new CycleHarness({
      workspaceRoot,
      repositories: ["repo-a"],
      clock: advancingClock(),
    });
    const initialized = await harness.initTask(taskInput("repo-a", "W-155"));
    const statePath = join(initialized.taskRoot, "state.json");
    const legacyState = JSON.parse(await readFile(statePath, "utf8"));
    delete legacyState.migrations;
    await writeFile(statePath, `${JSON.stringify(legacyState, null, 2)}\n`);
    await refreshIntegrity(initialized.taskRoot);

    const migrated = await harness.migrateBlockerLifecycle({
      repository: "repo-a",
      taskId: "W-155",
    });
    assert.equal(migrated.state.migrations.blocker_lifecycle_strict_from, 3);
    await rejectsCycleError(
      harness.migrateBlockerLifecycle({ repository: "repo-a", taskId: "W-155" }),
      { code: "MIGRATION_ALREADY_APPLIED", stage: "dossier_migration" },
    );

    const amended = await harness.amendTaskContract({
      repository: "repo-a",
      taskId: "W-155",
      summary: "Добавлены persona acceptance criteria",
      facets: ["persona-agents"],
      qualityCriteria: ["Product reviewer проверяет бизнес-требования продуктовой фичи"],
      scope: ["Три read-only persona-агента в зарегистрированных checkout"],
      checks: ["TOML profiles parse with tomllib"],
    });
    assert.equal(amended.amendment.revision, 2);
    assert.equal(amended.state.contract_revision, 2);
    assert.deepEqual(amended.state.task.facets, ["agent-workflow", "memory", "persona-agents"]);
    const contract = await readFile(join(initialized.taskRoot, "contract.md"), "utf8");
    assert.match(contract, /Ревизия контракта: 2/u);
    assert.match(contract, /Product reviewer проверяет бизнес-требования/u);
    assert.match(contract, /Три read-only persona-агента/u);
    const journal = await readFile(join(initialized.taskRoot, "journal.md"), "utf8");
    assert.match(journal, /Добавлено в quality_criteria: Product reviewer проверяет/u);
    const legacyAdditionOnlyEvent = JSON.parse(await readFile(amended.eventPath, "utf8"));
    delete legacyAdditionOnlyEvent.contract_amendment.removals;
    await writeFile(amended.eventPath, `${JSON.stringify(legacyAdditionOnlyEvent, null, 2)}\n`);
    await refreshIntegrity(initialized.taskRoot);
    assert.equal(
      Object.hasOwn(
        JSON.parse(await readFile(amended.eventPath, "utf8")).contract_amendment,
        "removals",
      ),
      false,
    );
    await harness.resumeTask({ repository: "repo-a", taskId: "W-155" });

    const replaced = await harness.amendTaskContract({
      repository: "repo-a",
      taskId: "W-155",
      summary: "Убраны отменённые требования и добавлен актуальный контракт",
      qualityCriteria: ["Пользователь проверяет актуальный результат"],
      scope: ["Актуальный persona workflow"],
      removeFacets: ["memory"],
      removeQualityCriteria: [
        "Результат воспроизводится человеком",
        "Product reviewer проверяет бизнес-требования продуктовой фичи",
      ],
      removeScope: ["Task dossier"],
    });
    assert.equal(replaced.amendment.revision, 3);
    assert.deepEqual(replaced.amendment.removals.facets, [{ value: "memory", index: 1 }]);
    assert.deepEqual(replaced.amendment.removals.quality_criteria, [
      { value: "Результат воспроизводится человеком", index: 0 },
      { value: "Product reviewer проверяет бизнес-требования продуктовой фичи", index: 1 },
    ]);
    assert.deepEqual(replaced.state.task.facets, ["agent-workflow", "persona-agents"]);
    assert.deepEqual(replaced.state.task.quality_criteria, ["Пользователь проверяет актуальный результат"]);
    assert.deepEqual(replaced.state.task.scope, [
      "Три read-only persona-агента в зарегистрированных checkout",
      "Актуальный persona workflow",
    ]);
    const replacedContract = await readFile(join(initialized.taskRoot, "contract.md"), "utf8");
    assert.doesNotMatch(replacedContract, /Product reviewer проверяет бизнес-требования/u);
    assert.match(replacedContract, /Пользователь проверяет актуальный результат/u);
    const replacedJournal = await readFile(join(initialized.taskRoot, "journal.md"), "utf8");
    assert.match(replacedJournal, /Удалено из quality_criteria: Результат воспроизводится человеком; Product reviewer проверяет/u);
    await harness.resumeTask({ repository: "repo-a", taskId: "W-155" });

    const beforeDuplicate = await directorySnapshot(initialized.taskRoot);
    await rejectsCycleError(
      harness.amendTaskContract({
        repository: "repo-a",
        taskId: "W-155",
        summary: "Повтор существующего критерия",
        qualityCriteria: ["Пользователь проверяет актуальный результат"],
      }),
      { code: "CONTRACT_ITEM_EXISTS", stage: "contract_amendment", path: "task.quality_criteria" },
    );
    assert.deepEqual(await directorySnapshot(initialized.taskRoot), beforeDuplicate);

    await rejectsCycleError(
      harness.amendTaskContract({
        repository: "repo-a",
        taskId: "W-155",
        summary: "Удаление отсутствующего пункта",
        removeQualityCriteria: ["Отсутствующий критерий"],
      }),
      { code: "CONTRACT_ITEM_MISSING", stage: "contract_amendment", path: "task.quality_criteria" },
    );
    await rejectsCycleError(
      harness.amendTaskContract({
        repository: "repo-a",
        taskId: "W-155",
        summary: "Противоречивый delta",
        qualityCriteria: ["Пользователь проверяет актуальный результат"],
        removeQualityCriteria: ["Пользователь проверяет актуальный результат"],
      }),
      { code: "CONTRACT_ITEM_CONFLICT", stage: "contract_amendment", path: "task.quality_criteria" },
    );
    await rejectsCycleError(
      harness.amendTaskContract({
        repository: "repo-a",
        taskId: "W-155",
        summary: "Удаление последнего обязательного критерия",
        removeQualityCriteria: ["Пользователь проверяет актуальный результат"],
      }),
      { code: "CONTRACT_REQUIRED_ITEMS_EMPTY", stage: "contract_amendment", path: "task.quality_criteria" },
    );
    assert.deepEqual(await directorySnapshot(initialized.taskRoot), beforeDuplicate);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("отклоняет обратный clock до записи любого mutation-артефакта", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-cycle-clock-"));
  try {
    const repositoryRoot = await createRepository(workspaceRoot, "repo-a");
    const controlled = controllableClock("2026-08-25T10:00:00.000Z");
    const harness = new CycleHarness({
      workspaceRoot,
      repositories: ["repo-a"],
      clock: controlled.clock,
    });
    const initialized = await harness.initTask(taskInput("repo-a", "W-160"));
    const assets = join(repositoryRoot, "candidate-assets");
    await mkdir(assets);
    await writeFile(join(assets, "app-after.txt"), "candidate behavior\n");
    await writeFile(join(assets, "rubric.md"), "# Rubric\n");
    await writeFile(join(assets, "evaluation.md"), "# Evaluation\n");
    const manifest = {
      title: "Clock-safe candidate",
      hypothesis: "Mutation не повреждает dossier при откате часов",
      target_repository: "repo-a",
      changes: [{
        layer: "tooling",
        operation: "replace",
        target: "src/app.txt",
        content_path: "candidate-assets/app-after.txt",
        summary: "Меняет тестовый файл",
      }],
      rubric: { version: "rubric-1", path: "candidate-assets/rubric.md" },
      evaluation: { version: "eval-1", path: "candidate-assets/evaluation.md" },
      quality_criteria: ["Dossier остаётся читаемым"],
      regression_scenarios: ["Forward clock"],
      negative_scenarios: ["Backward clock"],
    };

    controlled.set("2026-08-25T09:59:00.000Z");
    const beforeRejectedCandidate = await directorySnapshot(initialized.taskRoot);
    await rejectsCycleError(
      harness.createCandidate({ repository: "repo-a", taskId: "W-160", manifest }),
      { code: "EVENT_TIME_REGRESSION", stage: "event_preflight" },
    );
    assert.deepEqual(await directorySnapshot(initialized.taskRoot), beforeRejectedCandidate);

    controlled.set("2026-08-25T10:01:00.000Z");
    const created = await harness.createCandidate({
      repository: "repo-a",
      taskId: "W-160",
      manifest,
    });
    await rm(assets, { recursive: true, force: true });
    controlled.set("2026-08-25T10:02:00.000Z");
    await harness.checkpointTask({
      repository: "repo-a",
      taskId: "W-160",
      stage: "Task-only baseline",
      expected: "Зафиксировать task checkout до candidate overlay",
      actual: "Временные candidate assets удалены",
      next: "Применить immutable overlay",
    });
    await writeFile(join(repositoryRoot, "src", "app.txt"), "candidate behavior\n");
    controlled.set("2026-08-25T09:59:00.000Z");
    const frozen = await directorySnapshot(initialized.taskRoot);
    const mutations = [
      () => harness.addTaskEvent({
        repository: "repo-a",
        taskId: "W-160",
        type: "milestone",
        summary: "Не должен записаться",
      }),
      () => harness.checkpointTask({
        repository: "repo-a",
        taskId: "W-160",
        stage: "Не должен записаться",
        expected: "Монотонное время",
        actual: "Часы откачены назад",
        next: "Исправить clock",
      }),
      () => harness.reviewTask({
        repository: "repo-a",
        taskId: "W-160",
        outcome: "partial",
        summary: "Не должен записаться",
      }),
      () => harness.recordEvidence({
        repository: "repo-a",
        taskId: "W-160",
        candidateRef: created.candidate.candidate_ref,
        scenario: "replay",
        scenarioId: "backward-clock",
        runKey: "attempt-1",
        result: "pass",
        summary: "Не должен записаться",
      }),
      () => harness.recordDecision({
        repository: "repo-a",
        taskId: "W-160",
        candidateRef: created.candidate.candidate_ref,
        decisionId: "backward-clock-rejection",
        decision: "rejected",
        summary: "Не должен записаться",
      }),
    ];
    for (const mutation of mutations) {
      await rejectsCycleError(mutation(), {
        code: "EVENT_TIME_REGRESSION",
        stage: "event_preflight",
      });
      assert.deepEqual(await directorySnapshot(initialized.taskRoot), frozen);
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("агрегирует immutable candidate и локальные evidence двух W без чужой записи", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-cycle-experiment-"));
  try {
    await createRepository(workspaceRoot, "repo-a");
    await createRepository(workspaceRoot, "repo-b");
    const harness = new CycleHarness({
      workspaceRoot,
      repositories: ["repo-a", "repo-b"],
      clock: advancingClock(),
    });
    await harness.initTask(taskInput("repo-a", "W-201"));
    await harness.initTask(taskInput("repo-b", "W-202"));
    await harness.initTask(taskInput("repo-b", "W-203", {
      taskClass: "refactor",
      facets: ["code-structure"],
    }));
    for (const [repository, taskId] of [["repo-a", "W-201"], ["repo-b", "W-202"], ["repo-b", "W-203"]]) {
      await rm(join(workspaceRoot, repository, ".project", "task-runs", taskId, "experiments"), {
        recursive: true,
        force: true,
      });
    }
    assert.deepEqual(await harness.listCandidates(), []);

    const candidateAssets = join(workspaceRoot, "repo-a", "candidate-assets");
    await mkdir(candidateAssets);
    await writeFile(join(candidateAssets, "app-after.txt"), "candidate behavior\n");
    await writeFile(join(candidateAssets, "rubric.md"), "# Rubric v1\n\n- Handoff accepted\n");
    await writeFile(join(candidateAssets, "evaluation.md"), "# Eval v1\n\nRun replay, regression, negative and fresh-task.\n");

    const manifest = {
      title: "Явный checkpoint перед handoff",
      hypothesis: "Checkpoint уменьшит число повторных попыток",
      target_repository: "repo-a",
      changes: [
        {
          layer: "skills",
          operation: "replace",
          target: "src/app.txt",
          content_path: "candidate-assets/app-after.txt",
          summary: "Перед handoff требовать checkpoint с evidence",
        },
      ],
      rubric: { version: "rubric-1", path: "candidate-assets/rubric.md" },
      evaluation: { version: "eval-1", path: "candidate-assets/evaluation.md" },
      quality_criteria: ["Handoff принят без исправлений"],
      regression_scenarios: ["Обычная tooling-задача"],
      negative_scenarios: ["Разовая задача без общего пула"],
    };
    const created = await harness.createCandidate({
      repository: "repo-a",
      taskId: "W-201",
      manifest,
    });
    const candidateRef = created.candidate.candidate_ref;
    assert.equal(created.candidate.identity.target.repository, "repo-a");
    assert.equal(created.candidate.identity.overlay[0].before.sha256.length, 64);
    assert.equal(created.candidate.identity.overlay[0].after.sha256.length, 64);
    assert.notEqual(
      created.candidate.identity.overlay[0].before.sha256,
      created.candidate.identity.overlay[0].after.sha256,
    );
    assert.equal(created.candidate.identity.rubric.sha256.length, 64);
    assert.equal(created.candidate.identity.evaluation.sha256.length, 64);
    assert.equal(created.candidate.variant_fingerprint.length, 64);

    const earlyDecisionDossier = join(workspaceRoot, "repo-b", ".project", "task-runs", "W-202");
    const beforeEarlyApproval = await directorySnapshot(earlyDecisionDossier);
    await rejectsCycleError(
      harness.recordDecision({
        repository: "repo-b",
        taskId: "W-202",
        candidateRef,
        decisionId: "premature-approval",
        decision: "approved",
        summary: "Технические gates ещё не показаны человеку",
      }),
      { code: "APPROVAL_GATES_INCOMPLETE", stage: "human_approval", path: candidateRef },
    );
    assert.deepEqual(await directorySnapshot(earlyDecisionDossier), beforeEarlyApproval);

    await rm(candidateAssets, { recursive: true, force: true });
    await harness.checkpointTask({
      repository: "repo-a",
      taskId: "W-201",
      stage: "Task-only baseline",
      expected: "Отделить состояние задачи от candidate overlay",
      actual: "Временные candidate assets удалены, target соответствует baseline",
      next: "Применить immutable overlay",
    });
    await rejectsCycleError(
      harness.recordEvidence({
        repository: "repo-a",
        taskId: "W-201",
        candidateRef,
        scenario: "replay",
        scenarioId: "not-applied",
        runKey: "baseline-0",
        result: "pass",
        summary: "Overlay ещё не применён",
      }),
      { code: "CANDIDATE_OVERLAY_MISMATCH", stage: "variant_verification" },
    );
    await writeFile(join(workspaceRoot, "repo-a", "src", "app.txt"), "candidate behavior\n");
    await writeFile(join(workspaceRoot, "repo-a", "src", "unexpected.txt"), "confounder\n");
    await rejectsCycleError(
      harness.recordEvidence({
        repository: "repo-a",
        taskId: "W-201",
        candidateRef,
        scenario: "replay",
        scenarioId: "confounded-worktree",
        runKey: "baseline-confounded",
        result: "pass",
        summary: "Изменение после task checkpoint не должно закрыть gate",
      }),
      { code: "CANDIDATE_TARGET_CONFOUNDER", stage: "variant_verification" },
    );
    await rm(join(workspaceRoot, "repo-a", "src", "unexpected.txt"), { force: true });

    for (const scenario of ["replay", "regression", "negative"]) {
      const recorded = await harness.recordEvidence({
        repository: "repo-a",
        taskId: "W-201",
        candidateRef,
        scenario,
        scenarioId: `${scenario}-scenario`,
        runKey: "baseline-1",
        result: "pass",
        summary: `${scenario} пройден`,
        evidence: [`tests/${scenario}`],
      });
      assert.equal(recorded.evidence.target_worktree_fingerprint.length, 64);
      assert.equal(
        recorded.evidence.target_worktree_fingerprint,
        recorded.evidence.variant.target_worktree_fingerprint,
      );
      assert.deepEqual(recorded.evidence.variant.target_worktree.changed_paths, ["src/app.txt"]);
      assert.equal(
        recorded.evidence.variant.target_worktree.tracked_diff_sha256.length,
        64,
      );
      assert.deepEqual(recorded.evidence.task_worktree.changed_paths, []);
    }

    const sourceDossier = join(workspaceRoot, "repo-a", ".project", "task-runs", "W-201");
    const sourceBeforeFreshTask = await directorySnapshot(sourceDossier);
    const fresh = {
      repository: "repo-b",
      taskId: "W-202",
      candidateRef,
      scenario: "fresh-task",
      scenarioId: "next-tooling-task",
      runKey: "repo-b-head-1",
      result: "pass",
      summary: "Следующая задача выполнена с первой попытки",
      evidence: ["W-202/review.md"],
    };
    await harness.recordEvidence(fresh);
    assert.deepEqual(await directorySnapshot(sourceDossier), sourceBeforeFreshTask);

    const approved = await harness.recordDecision({
      repository: "repo-b",
      taskId: "W-202",
      candidateRef,
      decisionId: "human-review-1",
      decision: "approved",
      summary: "Человек подтвердил качество результата",
      evidence: ["W-202/handoff"],
    });
    assert.deepEqual(await directorySnapshot(sourceDossier), sourceBeforeFreshTask);

    const status = await harness.candidateStatus(candidateRef);
    assert.deepEqual(status.gates, {
      replay: true,
      regression: true,
      negative: true,
      fresh_task: true,
      human_approval: true,
    });
    assert.equal(status.ready_for_promotion, true);
    assert.equal(status.status, "ready-for-promotion");
    assert.equal(status.next_unmet_gate, null);
    assert.equal(status.evidence.length, 5);
    assert.equal(approved.decision.evidence_set_digest, status.technical_evidence_digest);
    assert.equal((await harness.listCandidates({ taskClass: "tooling", facets: ["memory"] })).length, 1);
    assert.equal((await harness.listCandidates({ taskClass: "refactor" })).length, 0);
    let humanList = "";
    await runCycleCli(
      ["experiment", "list", "--class", "tooling", "--facet", "memory"],
      {
        workspaceRoot,
        repositories: ["repo-a", "repo-b"],
        stdout: { write: (value) => { humanList += value; } },
      },
    );
    assert.match(humanList, /Название: Явный checkpoint перед handoff/u);
    assert.match(humanList, /Гипотеза: Checkpoint уменьшит число повторных попыток/u);
    assert.match(humanList, /Target: repo-a@[a-f0-9]{40}/u);
    assert.match(humanList, /Следующий gate: все gates закрыты/u);
    assert.match(humanList, /Evidence:/u);
    assert.match(humanList, /refs: tests\/replay/u);
    assert.match(humanList, /target diff [a-f0-9]{64}: src\/app\.txt/u);
    assert.match(humanList, /task diff [a-f0-9]{64}:/u);
    assert.match(humanList, /checkout diff [a-f0-9]{64}: src\/app\.txt/u);

    await harness.recordEvidence({
      repository: "repo-a",
      taskId: "W-201",
      candidateRef,
      scenario: "replay",
      scenarioId: "late-replay",
      runKey: "baseline-2",
      result: "pass",
      summary: "После approval добавлен новый technical evidence",
      evidence: ["tests/late-replay"],
    });
    const staleApproval = await harness.candidateStatus(candidateRef);
    assert.equal(staleApproval.gates.human_approval, false);
    assert.equal(staleApproval.ready_for_promotion, false);
    assert.notEqual(staleApproval.technical_evidence_digest, approved.decision.evidence_set_digest);
    await harness.recordDecision({
      repository: "repo-b",
      taskId: "W-202",
      candidateRef,
      decisionId: "human-review-2",
      decision: "approved",
      summary: "Человек просмотрел дополненный evidence-set",
    });
    assert.equal((await harness.candidateStatus(candidateRef)).ready_for_promotion, true);

    await harness.recordEvidence({
      repository: "repo-a",
      taskId: "W-201",
      candidateRef,
      scenario: "replay",
      scenarioId: "late-failure",
      runKey: "baseline-3",
      result: "fail",
      summary: "Поздний fail делает candidate terminal",
    });
    const failedStatus = await harness.candidateStatus(candidateRef);
    assert.equal(failedStatus.status, "failed");
    assert.equal(failedStatus.ready_for_promotion, false);
    assert.equal(failedStatus.next_unmet_gate, null);
    assert.match(failedStatus.next_action, /Создать нового кандидата с новым digest/u);
    let failedHumanStatus = "";
    await runCycleCli(
      ["experiment", "status", candidateRef],
      {
        workspaceRoot,
        repositories: ["repo-a", "repo-b"],
        stdout: { write: (value) => { failedHumanStatus += value; } },
      },
    );
    assert.match(failedHumanStatus, /Статус: failed/u);
    assert.match(failedHumanStatus, /Следующий gate: не применим: кандидат terminal/u);
    assert.match(failedHumanStatus, /Следующий шаг: Создать нового кандидата с новым digest/u);

    await writeFile(join(workspaceRoot, "repo-b", "src", "app.txt"), "changed after run\n");
    await rejectsCycleError(harness.recordEvidence(fresh), {
      code: "DUPLICATE_EVIDENCE",
      stage: "immutable_write",
    });
    await rejectsCycleError(
      harness.recordEvidence({
        ...fresh,
        dossierRepository: "repo-a",
        dossierTaskId: "W-201",
        scenarioId: "illegal-cross-owner",
      }),
      { code: "OWNERSHIP_MISMATCH", stage: "experiment_write", path: "repo-a/W-201" },
    );
    await rejectsCycleError(
      harness.recordEvidence({
        ...fresh,
        taskId: "W-203",
        scenarioId: "wrong-pool",
        runKey: "wrong-pool-1",
      }),
      { code: "TASK_POOL_MISMATCH", stage: "experiment_validation", path: "repo-b/W-203" },
    );
    await mkdir(candidateAssets);
    await writeFile(join(candidateAssets, "app-after.txt"), "candidate behavior\n");
    await writeFile(join(candidateAssets, "rubric.md"), "# Rubric v1\n\n- Handoff accepted\n");
    await writeFile(join(candidateAssets, "evaluation.md"), "# Eval v1\n\nRun replay, regression, negative and fresh-task.\n");
    const terminalCandidate = await harness.createCandidate({
      repository: "repo-a",
      taskId: "W-201",
      manifest: { ...manifest, title: "Явный checkpoint — terminal rejection" },
    });
    const terminalRef = terminalCandidate.candidate.candidate_ref;
    await rm(candidateAssets, { recursive: true, force: true });
    for (const scenario of ["replay", "regression", "negative"]) {
      await harness.recordEvidence({
        repository: "repo-a",
        taskId: "W-201",
        candidateRef: terminalRef,
        scenario,
        scenarioId: `terminal-${scenario}`,
        runKey: "terminal-1",
        result: "pass",
        summary: `${scenario} пройден до человеческого отказа`,
      });
    }
    await harness.recordEvidence({
      repository: "repo-b",
      taskId: "W-202",
      candidateRef: terminalRef,
      scenario: "fresh-task",
      scenarioId: "terminal-fresh-task",
      runKey: "terminal-1",
      result: "pass",
      summary: "Fresh task пройдена до человеческого отказа",
    });
    await harness.recordDecision({
      repository: "repo-b",
      taskId: "W-202",
      candidateRef: terminalRef,
      decisionId: "terminal-human-rejection",
      decision: "rejected",
      summary: "Человек отклонил кандидата после всех technical gates",
    });
    const rejectedStatus = await harness.candidateStatus(terminalRef);
    assert.equal(rejectedStatus.status, "rejected");
    assert.equal(rejectedStatus.next_unmet_gate, null);
    assert.match(rejectedStatus.next_action, /Создать нового кандидата с новым digest/u);
    let rejectedHumanStatus = "";
    await runCycleCli(
      ["experiment", "status", terminalRef],
      {
        workspaceRoot,
        repositories: ["repo-a", "repo-b"],
        stdout: { write: (value) => { rejectedHumanStatus += value; } },
      },
    );
    assert.match(rejectedHumanStatus, /Статус: rejected/u);
    assert.match(rejectedHumanStatus, /Следующий шаг: Создать нового кандидата с новым digest/u);

    await mkdir(candidateAssets);
    await writeFile(join(candidateAssets, "app-after.txt"), "candidate behavior\n");
    await writeFile(join(candidateAssets, "rubric.md"), "# Rubric v1\n\n- Handoff accepted\n");
    await writeFile(join(candidateAssets, "evaluation.md"), "# Eval v1\n\nRun replay, regression, negative and fresh-task.\n");
    const externalManifestRoot = join(workspaceRoot, "external-manifests");
    await mkdir(externalManifestRoot);
    await writeFile(
      join(externalManifestRoot, "candidate.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const linkedManifestRoot = join(workspaceRoot, "repo-a", "linked-manifests");
    await symlink(externalManifestRoot, linkedManifestRoot, "dir");
    await rejectsCycleError(
      harness.createCandidate({
        repository: "repo-a",
        taskId: "W-201",
        manifestPath: "linked-manifests/candidate.json",
      }),
      { code: "SYMLINK_PATH", stage: "candidate_load", path: linkedManifestRoot },
    );
    await rejectsCycleError(
      harness.createCandidate({
        repository: "repo-a",
        taskId: "W-201",
        manifest,
        baselineSha: "deadbeef",
      }),
      { code: "INVALID_BASELINE", stage: "candidate_baseline" },
    );
    await rejectsCycleError(
      harness.createCandidate({
        repository: "repo-a",
        taskId: "W-201",
        manifest: { ...manifest, ignored_field: true },
      }),
      { code: "INVALID_CANDIDATE", stage: "candidate_validation", path: "candidate" },
    );
    const renamedCandidate = await harness.createCandidate({
      repository: "repo-a",
      taskId: "W-201",
      manifest: { ...manifest, title: "Явный checkpoint перед handoff — вариант 2" },
    });
    assert.notEqual(renamedCandidate.candidate.candidate_ref, candidateRef);
    await rejectsCycleError(
      harness.createCandidate({ repository: "repo-a", taskId: "W-201", manifest }),
      { code: "IMMUTABLE_CANDIDATE", stage: "immutable_write" },
    );
    await rejectsCycleError(
      runCycleCli(
        ["experiment", "status", candidateRef, "--class", "tooling"],
        { workspaceRoot },
      ),
      { code: "UNUSED_OPTION", stage: "cli_parse", path: "--class" },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("проверяет fresh-task в том же репозитории через раздельные task и target snapshots", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-cycle-same-repo-"));
  try {
    const repositoryRoot = await createRepository(workspaceRoot, "repo-a");
    const harness = new CycleHarness({
      workspaceRoot,
      repositories: ["repo-a"],
      clock: advancingClock(),
    });
    const source = await harness.initTask(taskInput("repo-a", "W-260"));
    const assets = join(repositoryRoot, "candidate-assets");
    await mkdir(assets);
    await writeFile(join(assets, "app-after.txt"), "candidate behavior\n");
    await writeFile(join(assets, "rubric.md"), "# Rubric\n");
    await writeFile(join(assets, "evaluation.md"), "# Evaluation\n");
    const manifest = {
      title: "Same-repository fresh task",
      hypothesis: "Task changes и overlay можно доказательно разделить",
      target_repository: "repo-a",
      changes: [{
        layer: "skills",
        operation: "replace",
        target: "src/app.txt",
        content_path: "candidate-assets/app-after.txt",
        summary: "Меняет harness path",
      }],
      rubric: { version: "rubric-1", path: "candidate-assets/rubric.md" },
      evaluation: { version: "eval-1", path: "candidate-assets/evaluation.md" },
      quality_criteria: ["Fresh task воспроизводима"],
      regression_scenarios: ["Same repository"],
      negative_scenarios: ["Unexpected third path"],
    };
    const candidate = await harness.createCandidate({
      repository: "repo-a",
      taskId: "W-260",
      manifest,
    });
    await rm(assets, { recursive: true, force: true });

    await writeFile(join(repositoryRoot, "src", "task.txt"), "fresh task implementation\n");
    const fresh = await harness.initTask(taskInput("repo-a", "W-261"));
    await harness.checkpointTask({
      repository: "repo-a",
      taskId: "W-261",
      stage: "Task-only baseline",
      expected: "Зафиксировать изменения fresh task без candidate overlay",
      actual: "Изменён только src/task.txt",
      next: "Применить immutable overlay",
    });
    await writeFile(join(repositoryRoot, "src", "app.txt"), "candidate behavior\n");

    const sourceBefore = await directorySnapshot(source.taskRoot);
    const recorded = await harness.recordEvidence({
      repository: "repo-a",
      taskId: "W-261",
      candidateRef: candidate.candidate.candidate_ref,
      scenario: "fresh-task",
      scenarioId: "same-repository-task",
      runKey: "same-repo-1",
      result: "pass",
      summary: "Fresh task выполнена с task-only изменением",
    });
    assert.deepEqual(recorded.evidence.variant.target_worktree.changed_paths, ["src/app.txt"]);
    assert.deepEqual(recorded.evidence.task_worktree.changed_paths, ["src/task.txt"]);
    assert.deepEqual(
      recorded.evidence.variant.verification_worktree.changed_paths,
      ["src/app.txt", "src/task.txt"],
    );
    assert.deepEqual(await directorySnapshot(source.taskRoot), sourceBefore);
    assert.equal((await harness.resumeTask({ repository: "repo-a", taskId: "W-261" })).drift, false);

    await writeFile(join(repositoryRoot, "src", "unexpected.txt"), "confounder\n");
    const freshBeforeRejected = await directorySnapshot(fresh.taskRoot);
    await rejectsCycleError(
      harness.recordEvidence({
        repository: "repo-a",
        taskId: "W-261",
        candidateRef: candidate.candidate.candidate_ref,
        scenario: "fresh-task",
        scenarioId: "same-repository-confounder",
        runKey: "same-repo-2",
        result: "pass",
        summary: "Третий path не должен попасть в run",
      }),
      { code: "CANDIDATE_TARGET_CONFOUNDER", stage: "variant_verification" },
    );
    assert.deepEqual(await directorySnapshot(fresh.taskRoot), freshBeforeRejected);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("отклоняет symlink в managed task path до записи и сохраняет внешние данные", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-cycle-symlink-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "task-cycle-external-"));
  try {
    const repositoryRoot = await createRepository(workspaceRoot, "repo-a");
    await mkdir(join(repositoryRoot, ".project"));
    await writeFile(join(externalRoot, "sentinel.txt"), "must survive\n");
    await symlink(externalRoot, join(repositoryRoot, ".project", "task-runs"), "dir");
    const harness = new CycleHarness({
      workspaceRoot,
      repositories: ["repo-a"],
      clock: advancingClock(),
    });
    await rejectsCycleError(harness.initTask(taskInput("repo-a", "W-301")), {
      code: "SYMLINK_PATH",
      stage: "path_validation",
      path: join(repositoryRoot, ".project", "task-runs"),
    });
    assert.equal(await readFile(join(externalRoot, "sentinel.txt"), "utf8"), "must survive\n");
    assert.equal((await lstat(join(repositoryRoot, ".project", "task-runs"))).isSymbolicLink(), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});
