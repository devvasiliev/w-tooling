import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ALLOWED_CHILD_TYPES,
  CALLOUT_ICON,
  MASTER_SPEC_MARKER,
  PAGE_ICONS,
  RELEASE_PROCESS_V1,
  SIZE_STORAGE,
  STATUS_FLOW,
  TASK_TYPE_STORAGE,
  NotionClient,
  TaskNotionError,
  assertBusinessRequirementIndependent,
  assertOpenSpecBusinessLinkage,
  assertTaskTitleWithoutTaskCode,
  assertOpenSpecLinkage,
  assertAllowedTaskRelation,
  assertStoryBusinessScope,
  blockText,
  buildBusinessHierarchySnapshot,
  buildReleaseHistoryBusinessTemplate,
  buildReleaseRelationPlan,
  buildReleaseStoryTemplate,
  releaseHistoryViewBody,
  releaseIncomingViewBody,
  buildStatusUpdatePlan,
  buildTaskTemplate,
  backfillReleaseProcessV1,
  calculateParentStatus,
  createBusinessRequirement,
  createTaskItem,
  discoverBusinessSchema,
  discoverSchema,
  estimateTaskSize,
  estimateManualCodeLines,
  isSizeExcludedChange,
  finalizeStoryBusiness,
  formatReleaseDateRu,
  formatReleaseTitleRu,
  inspectBacklogWorkspace,
  inspectBusinessRequirements,
  inspectWorkspace,
  isOpenSpecOwner,
  isExactTaskMatch,
  loadConfig,
  loadOpenSpecDocuments,
  masterSection,
  missingBlockSuffix,
  markdownInlineToRichText,
  markdownToBlocks,
  openSpecDocumentTitle,
  publishManagedDocumentGroups,
  publishManagedDocuments,
  publishManagedSpec,
  publishPlanningTask,
  queryAllPages,
  randomPageIcon,
  redactSecret,
  refreshTaskContents,
  releasedAncestor,
  removeManagedDocuments,
  releaseTask,
  resolveStoredOption,
  resolveTaskPriority,
  selectTaskPage,
  updateMasterSpecification,
  updateTaskStatus,
  verifyStoryReady,
} from "./notion-workflow-lib.mjs";
import { runCli } from "./notion-workflow.mjs";
import {
  BRANCH_ADJECTIVES,
  BRANCH_NOUNS,
  assertBranchCodeAvailable,
  assertBranchTaskType,
  generateBranchName,
  parseBranchArguments,
} from "./task-branch-name.mjs";

const schema = {
  titleName: "Задача",
  idName: "ID",
  statusName: "Статус",
  statusType: "status",
  parentName: "Родитель",
  typeName: "Тип",
  priorityName: "Приоритет",
  sizeName: "Размер",
  technicalDebtName: "Технический долг",
  releaseDateName: "Дата релиза",
  releaseName: "Релиз",
  releaseBugName: "Баг релиза",
  incomingReleaseTasksName: "Входящие задачи",
  releaseProcessName: "Релиз-процесс",
};

const page = ({
  id,
  title,
  code = "W-97",
  parent = [],
  status = "Бэклог",
  type = "",
  priority = "high",
  size = "Normal",
  releaseDate = "",
  releases = [],
  discoveredReleases = [],
  technicalDebt = false,
  releaseProcess = "",
}) => {
  const match = code.match(/^([A-Z]+)-(\d+)$/u);
  return {
    object: "page",
    id,
    properties: {
      ID: {
        unique_id: match
          ? { prefix: match[1], number: Number(match[2]) }
          : null,
      },
      Задача: { title: [{ plain_text: title }] },
      Статус: { status: { name: status } },
      Родитель: { relation: parent.map((parentId) => ({ id: parentId })) },
      Тип: { select: type ? { name: type } : null },
      Приоритет: { select: priority ? { name: priority } : null },
      Размер: { select: size ? { name: size } : null },
      "Технический долг": { checkbox: technicalDebt },
      "Дата релиза": { date: releaseDate ? { start: releaseDate } : null },
      Релиз: { relation: releases.map((releaseId) => ({ id: releaseId })) },
      "Баг релиза": {
        relation: discoveredReleases.map((releaseId) => ({ id: releaseId })),
      },
      "Входящие задачи": { relation: [] },
      "Релиз-процесс": {
        select: releaseProcess ? { name: releaseProcess } : null,
      },
    },
  };
};

test("конфигурация загружается из файла, окружение имеет приоритет, токен маскируется", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-notion-"));
  const path = join(directory, "notion.env");
  await writeFile(
    path,
    "NOTION_TOKEN=file-token\nNOTION_BACKLOG_DATABASE_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    { mode: 0o600 },
  );
  try {
    const config = await loadConfig({
      configPath: path,
      env: { NOTION_TOKEN: "env-token" },
    });
    assert.equal(config.token, "env-token");
    assert.equal(config.databaseId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(config.businessDatabaseId, "");
    assert.equal(config.insecureFileMode, false);
    assert.equal(
      redactSecret("Bearer env-token env-token", config.token),
      "Bearer [REDACTED] [REDACTED]",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("имя ветки использует уникальный код задачи и словари 100 на 100", () => {
  assert.equal(BRANCH_ADJECTIVES.length, 100);
  assert.equal(BRANCH_NOUNS.length, 100);
  assert.equal(new Set(BRANCH_ADJECTIVES).size, 100);
  assert.equal(new Set(BRANCH_NOUNS).size, 100);
  const samples = [0, 0.999999];
  assert.equal(
    generateBranchName({ type: "story", code: "W-39", random: () => samples.shift() }),
    "story/w-39-agile-thunder",
  );
  assert.throws(
    () => assertBranchCodeAvailable("W-39", ["origin/story/w-39-grim-boll"]),
    /уже используется/u,
  );
  assert.equal(
    generateBranchName({ type: "bug", code: "W-98", random: () => 0 }),
    "bugfix/w-98-agile-anchor",
  );
  assert.equal(assertBranchTaskType("story", "История"), true);
  assert.equal(assertBranchTaskType("bug", "Баг"), true);
  assert.throws(
    () => assertBranchTaskType("story", "Задача"),
    { code: "BRANCH_TASK_TYPE_MISMATCH" },
  );
  assert.deepEqual(parseBranchArguments(["W-39", "story"]), {
    code: "W-39",
    type: "story",
  });
});

test("размер учитывает только вручную написанный код", () => {
  const changes = [
    { path: "src/service.ts", lines: 180 },
    { path: "pnpm-lock.yaml", lines: 900 },
    { path: "src/__snapshots__/service.snap", lines: 300 },
    { path: "prisma/migrations/20260814_change/migration.sql", lines: 80 },
    { path: "src/api.generated.ts", lines: 1200, generated: true },
    { path: "src/reformatted.ts", lines: 500, formattingOnly: true },
  ];
  assert.equal(estimateManualCodeLines(changes), 180);
  assert.equal(estimateTaskSize(estimateManualCodeLines(changes)), "Маленький");
  assert.equal(isSizeExcludedChange({ path: "Cargo.lock" }), true);
  assert.equal(isSizeExcludedChange({ path: "src/manual.ts" }), false);
});

test("doctor обнаруживает обязательные свойства и проверяет статусы", () => {
  const properties = {
    Задача: { type: "title" },
    ID: { type: "unique_id" },
    Статус: {
      type: "status",
      status: { options: STATUS_FLOW.map((name) => ({ name })) },
    },
    Приоритет: { type: "select", select: { options: [{ name: "Высокий" }] } },
    Размер: { type: "select", select: { options: [{ name: "M" }] } },
    "Технический долг": { type: "checkbox", checkbox: {} },
    Тип: { type: "select", select: { options: [{ name: "Epic" }] } },
    Родитель: { type: "relation" },
    "Дата релиза": { type: "date", date: {} },
    Релиз: { type: "relation" },
    "Баг релиза": { type: "relation" },
    "Входящие задачи": { type: "relation" },
    "Релиз-процесс": {
      type: "select",
      select: { options: ["legacy", RELEASE_PROCESS_V1].map((name) => ({ name })) },
    },
  };
  assert.deepEqual(
    discoverSchema(
      { properties },
      { parentProperty: "Родитель" },
      { requireTyped: true },
    ),
    {
      titleName: "Задача",
      idName: "ID",
      statusName: "Статус",
      statusType: "status",
      parentName: "Родитель",
      typeName: "Тип",
      priorityName: "Приоритет",
      sizeName: "Размер",
      technicalDebtName: "Технический долг",
      releaseDateName: "Дата релиза",
      releaseName: "Релиз",
      releaseBugName: "Баг релиза",
      incomingReleaseTasksName: "Входящие задачи",
      releaseProcessName: "Релиз-процесс",
      typeOptions: ["Epic"],
      priorityOptions: ["Высокий"],
      sizeOptions: ["M"],
      releaseProcessOptions: ["legacy", RELEASE_PROCESS_V1],
      missingTaskTypes: ["История", "Задача", "Подзадача", "Баг"],
      missingPriorities: ["critical", "high", "medium", "low"],
      missingSizes: ["Маленький", "Обычный", "Крупный", "Огромный"],
      missingReleaseProcesses: [],
      statusOptions: STATUS_FLOW,
      missingStatuses: [],
    },
  );
  assert.throws(
    () => discoverSchema({ properties: { Задача: { type: "title" } } }),
    (error) => error.code === "SCHEMA_PROPERTY_AMBIGUOUS",
  );
});

test("doctor требует каждый статус полного жизненного цикла", async () => {
  for (const missingStatus of STATUS_FLOW) {
    const metadata = {
      object: "data_source",
      id: "source",
      properties: {
        Задача: { type: "title" },
        ID: { type: "unique_id" },
        Статус: {
          type: "status",
          status: {
            options: STATUS_FLOW.filter(
              (status) => status !== missingStatus,
            ).map((name) => ({ name })),
          },
        },
        Родитель: { type: "relation" },
      },
    };
    const client = {
      request: async (path) => {
        assert.equal(path, "/data_sources/source");
        return metadata;
      },
    };

    await assert.rejects(
      inspectBacklogWorkspace(client, {
        databaseId: "source",
        parentProperty: "Родитель",
      }),
      (error) =>
        error.code === "STATUSES_MISSING" &&
        error.message.includes(missingStatus),
      missingStatus,
    );
  }
});

test("поиск проходит все страницы и совпадает только с точным кодом задачи", async () => {
  const requests = [];
  const client = {
    async request(path, options) {
      requests.push([path, options]);
      if (requests.length === 1)
        return {
          results: [page({ id: "1", title: "Другая задача", code: "W-970" })],
          has_more: true,
          next_cursor: "next",
        };
      return {
        results: [page({ id: "2", title: "Интеграция CI с Notion" })],
        has_more: false,
      };
    },
  };
  const pages = await queryAllPages(client, "source");
  assert.equal(pages.length, 2);
  assert.equal(requests[1][1].body.start_cursor, "next");
  assert.equal(isExactTaskMatch("W-970", "W-97"), false);
  assert.equal(isExactTaskMatch("W-97", "W-97"), true);
});

test("единственный sub-item выбирается по ID, родитель не выбирается", () => {
  const parent = page({
    id: "parent",
    title: "W-97 в заголовке",
    code: "W-96",
  });
  const child = page({
    id: "child",
    title: "Дочерняя задача",
    parent: ["parent"],
  });
  const selected = selectTaskPage([parent, child], schema, "W-97");
  assert.equal(selected.page.id, "child");
  assert.equal(selected.isChild, true);
});

test("неоднозначные совпадения запрещают выбор", () => {
  const children = [
    page({ id: "one", title: "W-97 one", parent: ["p"] }),
    page({ id: "two", title: "W-97 two", parent: ["p"] }),
  ];
  assert.throws(
    () => selectTaskPage(children, schema, "W-97"),
    (error) => error.code === "TASK_AMBIGUOUS",
  );
});

test("статус родителя рассчитывается по прямым дочерним задачам", () => {
  const cases = [
    ["Бэклог", ["Бэклог", "Аналитика"], "Аналитика"],
    ["Аналитика", ["Бэклог", "Дизайн"], "Дизайн"],
    ["Дизайн", ["Бэклог", "Тестирование"], "Разработка"],
    ["Разработка", ["Разработка", "Тестирование"], "Разработка"],
    ["Разработка", ["Тестирование", "Закрыто"], "Тестирование"],
    ["Тестирование", ["Ожидание релиза", "Закрыто"], "Ожидание релиза"],
    ["Тестирование", ["Разработка", "Ожидание релиза"], "Тестирование"],
    ["Ожидание релиза", ["Тестирование", "Закрыто"], "Тестирование"],
    ["Ожидание релиза", ["Дизайн", "Закрыто"], "Разработка"],
    ["Закрыто", ["Бэклог"], "Закрыто"],
  ];

  for (const [currentStatus, childStatuses, expected] of cases) {
    assert.equal(
      calculateParentStatus(currentStatus, childStatuses),
      expected,
      `${currentStatus}: ${childStatuses.join(", ")}`,
    );
  }
});

test("план доходит до корня через родителя без изменения статуса", () => {
  const pages = [
    page({
      id: "root",
      title: "Группа без кода задачи",
      code: "",
      status: "Дизайн",
    }),
    page({
      id: "root-sibling",
      title: "Соседняя задача верхнего уровня",
      code: "",
      parent: ["root"],
      status: "Тестирование",
    }),
    page({
      id: "middle",
      title: "Промежуточная группа",
      code: "",
      parent: ["root"],
      status: "Разработка",
    }),
    page({
      id: "child",
      title: "Целевая задача",
      parent: ["middle"],
      status: "Разработка",
    }),
    page({
      id: "child-sibling",
      title: "Соседняя задача",
      code: "",
      parent: ["middle"],
      status: "Тестирование",
    }),
  ];

  const plan = buildStatusUpdatePlan(pages, schema, "child", "Разработка");
  assert.deepEqual(
    plan.updates.map(({ pageId, previousStatus, targetStatus }) => ({
      pageId,
      previousStatus,
      targetStatus,
    })),
    [
      {
        pageId: "root",
        previousStatus: "Дизайн",
        targetStatus: "Разработка",
      },
    ],
  );
  assert.equal(plan.selectedChanged, false);
  assert.deepEqual(
    plan.parentUpdates.map(({ pageId }) => pageId),
    ["root"],
  );
});

test("некорректная иерархия блокирует все записи", () => {
  const cases = [
    {
      pages: [page({ id: "child", title: "Задача", parent: ["missing"] })],
      code: "PARENT_NOT_FOUND",
    },
    {
      pages: [
        page({ id: "one", title: "Группа 1", code: "" }),
        page({ id: "two", title: "Группа 2", code: "" }),
        page({
          id: "child",
          title: "Задача",
          parent: ["one", "two"],
        }),
      ],
      code: "MULTIPLE_PARENTS",
    },
    {
      pages: [
        page({
          id: "parent",
          title: "Группа",
          code: "",
          parent: ["child"],
        }),
        page({ id: "child", title: "Задача", parent: ["parent"] }),
      ],
      code: "PARENT_CYCLE",
    },
    {
      pages: [
        page({ id: "parent", title: "Группа", code: "" }),
        page({ id: "child", title: "Задача", parent: ["parent"] }),
        page({
          id: "sibling",
          title: "Соседняя задача",
          code: "",
          parent: ["parent"],
          status: "Неизвестно",
        }),
      ],
      code: "UNKNOWN_STATUS",
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => buildStatusUpdatePlan(fixture.pages, schema, "child", "Разработка"),
      (error) => error.code === fixture.code,
      fixture.code,
    );
  }
});

test("смена статуса идемпотентна и пишет только выбранную страницу", async () => {
  const writes = [];
  const config = { databaseId: "source", parentProperty: "Родитель" };
  const metadata = {
    object: "data_source",
    id: "source",
    properties: {
      Задача: { type: "title" },
      ID: { type: "unique_id" },
      Статус: {
        type: "status",
        status: { options: STATUS_FLOW.map((name) => ({ name })) },
      },
      Родитель: { type: "relation" },
    },
  };
  const child = page({
    id: "child",
    title: "W-97 child",
    status: "Аналитика",
  });
  const client = {
    async request(path, options = {}) {
      if (path === "/data_sources/source") return metadata;
      if (path === "/data_sources/source/query") return { results: [child] };
      writes.push([path, options]);
      return {};
    },
  };
  const noop = await updateTaskStatus(client, config, "W-97", "Аналитика");
  assert.equal(noop.changed, false);
  const changed = await updateTaskStatus(
    client,
    config,
    "W-97",
    "Разработка",
  );
  assert.equal(changed.changed, true);
  assert.deepEqual(
    writes.map(([path]) => path),
    ["/pages/child"],
  );
  await assert.rejects(
    updateTaskStatus(client, config, "W-97", "Ожидание релиза", {
      approved: true,
    }),
    (error) => error.code === "ACCEPTANCE_STATUS_REQUIRED",
  );
  child.properties.Статус.status.name = "Тестирование";
  await assert.rejects(
    updateTaskStatus(client, config, "W-97", "Релиз"),
    (error) => error.code === "INVALID_STATUS",
  );
  await assert.rejects(
    updateTaskStatus(client, config, "W-97", "Ожидание релиза"),
    (error) => error.code === "APPROVAL_REQUIRED",
  );
  const releaseReady = await updateTaskStatus(
    client,
    config,
    "W-97",
    "Ожидание релиза",
    { approved: true },
  );
  assert.equal(releaseReady.changed, true);
  assert.equal(writes.at(-1)[0], "/pages/child");
});

test("повторный запуск продолжает цепочку через уже обновлённую задачу", async () => {
  const pages = [
    page({ id: "root", title: "Корневая группа", code: "", status: "Дизайн" }),
    page({
      id: "root-sibling",
      title: "Соседняя задача верхнего уровня",
      code: "",
      parent: ["root"],
      status: "Тестирование",
    }),
    page({
      id: "middle",
      title: "Промежуточная группа",
      code: "",
      parent: ["root"],
      status: "Разработка",
    }),
    page({
      id: "child",
      title: "Целевая задача",
      parent: ["middle"],
      status: "Аналитика",
    }),
    page({
      id: "child-sibling",
      title: "Соседняя задача",
      code: "",
      parent: ["middle"],
      status: "Тестирование",
    }),
  ];
  const attempts = [];
  let failRootOnce = true;
  const metadata = {
    object: "data_source",
    id: "source",
    properties: {
      Задача: { type: "title" },
      ID: { type: "unique_id" },
      Статус: {
        type: "status",
        status: { options: STATUS_FLOW.map((name) => ({ name })) },
      },
      Родитель: { type: "relation" },
    },
  };
  const client = {
    async request(path, options = {}) {
      if (path === "/data_sources/source") return metadata;
      if (path === "/data_sources/source/query") return { results: pages };
      const pageId = path.replace("/pages/", "");
      const targetStatus = options.body.properties.Статус.status.name;
      attempts.push(pageId);
      if (pageId === "root" && failRootOnce) {
        failRootOnce = false;
        throw new TaskNotionError("NOTION_TIMEOUT", "Временный сбой", {
          external: true,
        });
      }
      const targetPage = pages.find((item) => item.id === pageId);
      targetPage.properties.Статус.status.name = targetStatus;
      return {};
    },
  };

  await assert.rejects(
    updateTaskStatus(
      client,
      { databaseId: "source", parentProperty: "Родитель" },
      "W-97",
      "Разработка",
    ),
    (error) => error.code === "NOTION_TIMEOUT",
  );
  const result = await updateTaskStatus(
    client,
    { databaseId: "source", parentProperty: "Родитель" },
    "W-97",
    "Разработка",
  );

  assert.deepEqual(attempts, ["child", "root", "root"]);
  assert.equal(result.changed, false);
  assert.deepEqual(
    result.parentUpdates.map(({ pageId }) => pageId),
    ["root"],
  );
});

test("release обновляет родителей без публикации документов в них и восстанавливается после сбоя", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-release-"));
  const specs = join(root, "specs", "notion");
  await mkdir(specs, { recursive: true });
  await Promise.all([
    writeFile(join(root, ".openspec.yaml"), "schema: spec-driven\n"),
    writeFile(join(root, "proposal.md"), "Task: W-97\n\n## Почему\nТест.\n"),
    writeFile(join(specs, "spec.md"), "## ADDED Requirements\n"),
  ]);

  const pages = [
    page({
      id: "parent",
      title: "Группа без кода задачи",
      code: "",
      status: "Тестирование",
    }),
    page({
      id: "child",
      title: "Целевая задача",
      parent: ["parent"],
      status: "Тестирование",
      type: "Epic",
      technicalDebt: true,
    }),
  ];
  const metadata = {
    object: "data_source",
    id: "source",
    properties: {
      Задача: { type: "title" },
      ID: { type: "unique_id" },
      Статус: {
        type: "status",
        status: { options: STATUS_FLOW.map((name) => ({ name })) },
      },
      Родитель: { type: "relation" },
      Тип: {
        type: "select",
        select: { options: Object.values(TASK_TYPE_STORAGE).map((values) => ({ name: values.at(-1) })) },
      },
      "Технический долг": { type: "checkbox", checkbox: {} },
    },
  };
  const pageWrites = [];
  const blockWrites = [];
  let failParentOnce = true;
  let toggleNumber = 0;
  const client = {
    async request(path, options = {}) {
      if (path === "/data_sources/source") return metadata;
      if (path === "/data_sources/source/query") return { results: pages };
      if (path.startsWith("/blocks/child/children?")) {
        return { results: [], has_more: false };
      }
      if (path === "/blocks/child/children") {
        blockWrites.push(path);
        toggleNumber += 1;
        return { results: [{ id: `toggle-${toggleNumber}` }] };
      }
      if (path.startsWith("/blocks/toggle-")) {
        blockWrites.push(path);
        return {};
      }
      if (path.startsWith("/pages/")) {
        const pageId = path.replace("/pages/", "");
        const targetStatus = options.body.properties.Статус.status.name;
        pageWrites.push(pageId);
        if (pageId === "parent" && failParentOnce) {
          failParentOnce = false;
          throw new TaskNotionError("NOTION_TIMEOUT", "Временный сбой", {
            external: true,
          });
        }
        pages.find((item) => item.id === pageId).properties.Статус.status.name =
          targetStatus;
        return {};
      }
      assert.fail(`Неожиданный запрос: ${path}`);
    },
  };
  const config = { databaseId: "source", parentProperty: "Родитель" };
  const specPath = join(specs, "spec.md");

  try {
    await assert.rejects(
      releaseTask(client, config, "W-97", {
        approved: true,
        specPath,
      }),
      (error) => error.code === "NOTION_TIMEOUT",
    );
    const result = await releaseTask(client, config, "W-97", {
      approved: true,
      specPath,
    });

    assert.deepEqual(pageWrites, ["child", "parent", "parent"]);
    assert.equal(result.statusChanged, false);
    assert.deepEqual(
      result.parentUpdates.map(({ pageId }) => pageId),
      ["parent"],
    );
    assert.ok(blockWrites.length > 0);
    assert.ok(blockWrites.every((path) => !path.includes("parent")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release требует подтверждение и существующий непустой spec до записи", async () => {
  const client = { request: async () => assert.fail("запись недопустима") };
  await assert.rejects(
    releaseTask(client, {}, "W-97", {}),
    (error) => error.code === "APPROVAL_REQUIRED",
  );
  await assert.rejects(
    releaseTask(client, {}, "W-97", { approved: true }),
    (error) => error.code === "SPEC_PATH_REQUIRED",
  );
});

test("бизнес-финализация истории требует явную приёмку", async () => {
  const client = { request: async () => assert.fail("запись недопустима") };
  await assert.rejects(
    finalizeStoryBusiness(client, {}, "W-97", {
      businessChanged: false,
      technicalRequirements: ["capability/requirement"],
    }),
    (error) => error.code === "APPROVAL_REQUIRED",
  );
});

test("управляемый spec-блок заменяется, остальные блоки не удаляются", async () => {
  const calls = [];
  const existing = {
    id: "managed",
    type: "toggle",
    toggle: { rich_text: [{ plain_text: "Спецификация реализации · W-97" }] },
  };
  const client = {
    async request(path, options = {}) {
      calls.push([path, options]);
      if (path.startsWith("/blocks/page/children?")) {
        return {
          results: [{ id: "user", type: "paragraph" }, existing],
          has_more: false,
        };
      }
      if (path === "/blocks/page/children") {
        return { results: [{ ...existing, id: "new-managed" }] };
      }
      return {};
    },
  };
  const result = await publishManagedSpec(client, "page", "W-97", "# Готово");
  assert.equal(result.replaced, true);
  assert.ok(
    calls.some(
      ([path, options]) =>
        path === "/blocks/managed" && options.method === "DELETE",
    ),
  );
  assert.ok(!calls.some(([path]) => path === "/blocks/user"));
  assert.ok(calls.some(([path]) => path === "/blocks/new-managed/children"));
});

test("Markdown и длинный код разбиваются по лимитам Notion", () => {
  const blocks = markdownToBlocks(
    `## Заголовок\n\n${"a".repeat(4001)}\n\n\`\`\`\n${"b".repeat(4001)}\n\`\`\``,
  );
  assert.ok(blocks.length >= 6);
  for (const item of blocks) {
    const values = item[item.type].rich_text;
    assert.ok(values.every((value) => value.text.content.length <= 2000));
  }
});

test("Markdown преобразуется в нативное форматирование без видимых маркеров", () => {
  const blocks = markdownToBlocks(
    "#### Scenario: Проверка\n\n- **WHEN** используется `код` и [ссылка](https://example.com)\n- [x] **THEN** готово",
  );
  assert.equal(blocks[0].type, "heading_3");
  assert.equal(
    blocks[0].heading_3.rich_text[0].text.content,
    "Scenario: Проверка",
  );
  const bullet = blocks[1].bulleted_list_item.rich_text;
  assert.equal(bullet[0].text.content, "WHEN");
  assert.equal(bullet[0].annotations.bold, true);
  assert.equal(bullet[2].text.content, "код");
  assert.equal(bullet[2].annotations.code, true);
  assert.equal(bullet[4].text.content, "ссылка");
  assert.equal(bullet[4].text.link.url, "https://example.com");
  assert.equal(blocks[2].type, "to_do");
  assert.equal(blocks[2].to_do.checked, true);
  const visible = blocks
    .flatMap((item) => item[item.type].rich_text || [])
    .map((item) => item.text.content)
    .join("");
  assert.doesNotMatch(visible, /\*\*|####|`|\]\(/u);
  assert.equal(
    markdownInlineToRichText("*курсив*")[0].annotations.italic,
    true,
  );
});

test("release собирает все Markdown-артефакты OpenSpec change", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-openspec-"));
  const specs = join(root, "specs", "one");
  await mkdir(specs, { recursive: true });
  await Promise.all([
    writeFile(join(root, ".openspec.yaml"), "schema: spec-driven\n"),
    writeFile(join(root, "proposal.md"), "# Proposal\n"),
    writeFile(join(root, "design.md"), "# Design\n"),
    writeFile(join(root, "tasks.md"), "- [ ] Task\n"),
    writeFile(join(specs, "spec.md"), "## ADDED Requirements\n"),
  ]);
  try {
    const documents = await loadOpenSpecDocuments(join(specs, "spec.md"));
    assert.deepEqual(
      documents.map((document) => document.label),
      ["proposal.md", "design.md", "tasks.md", "specs/one/spec.md"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenSpec-документы публикуются отдельными dropdown с русскими названиями", async () => {
  const calls = [];
  const legacy = {
    id: "legacy",
    type: "toggle",
    toggle: { rich_text: [{ plain_text: "Спецификация реализации · W-97" }] },
  };
  const client = {
    async request(path, options = {}) {
      calls.push([path, options]);
      if (path.startsWith("/blocks/page/children?")) {
        return {
          results: [{ id: "user", type: "paragraph" }, legacy],
          has_more: false,
        };
      }
      if (path === "/blocks/page/children") {
        const toggle = options.body.children[0];
        return { results: [{ ...toggle, id: `toggle-${calls.length}` }] };
      }
      return {};
    },
  };
  const documents = [
    { label: "proposal.md", markdown: "# Почему" },
    { label: "design.md", markdown: "# Решение" },
    { label: "tasks.md", markdown: "- [x] Готово" },
    {
      label: "specs/notion/spec.md",
      markdown: "### Requirement: Жизненный цикл задач Notion",
    },
  ];
  const result = await publishManagedDocuments(
    client,
    "page",
    "W-97",
    documents,
  );
  assert.equal(result.documents, 4);
  assert.equal(result.replaced, true);
  assert.ok(calls.some(([path]) => path === "/blocks/legacy"));
  assert.ok(!calls.some(([path]) => path === "/blocks/user"));
  const titles = calls
    .filter(([path]) => path === "/blocks/page/children")
    .map(
      ([, options]) =>
        options.body.children[0].toggle.rich_text[0].text.content,
    );
  assert.deepEqual(titles, [
    "Предложения",
    "Дизайн архитектуры",
    "Задачи",
    "Спецификация · Жизненный цикл задач Notion",
  ]);
  assert.equal(
    openSpecDocumentTitle(documents[3]),
    "Спецификация · Жизненный цикл задач Notion",
  );
});

test("repo-local OpenSpec публикуются одним набором по репозиториям", async () => {
  const calls = [];
  let sequence = 0;
  const client = {
    async request(path, options = {}) {
      calls.push([path, options]);
      if (path.startsWith("/blocks/page/children?")) {
        return { results: [], has_more: false };
      }
      const first = options.body?.children?.[0];
      if (options.method === "PATCH" && first?.type === "toggle") {
        sequence += 1;
        return { results: [{ ...first, id: `toggle-${sequence}` }] };
      }
      return { results: [] };
    },
  };
  const documents = (requirement) => [
    { label: "proposal.md", markdown: "# Почему" },
    { label: "design.md", markdown: "# Решение" },
    { label: "tasks.md", markdown: "- [x] Готово" },
    {
      label: `specs/${requirement}/spec.md`,
      markdown: `### Requirement: ${requirement}`,
    },
  ];

  const result = await publishManagedDocumentGroups(
    client,
    "page",
    "W-321",
    [
      { owner: "identity-service", documents: documents("Контракт идентификации") },
      { owner: "catalog-service", documents: documents("Контракт каталога") },
    ],
  );

  assert.equal(result.groups, 2);
  assert.equal(result.documents, 8);
  const createdTitles = calls
    .filter(([, options]) => options.body?.children?.[0]?.type === "toggle")
    .map(([, options]) =>
      options.body.children[0].toggle.rich_text[0].text.content,
    );
  assert.deepEqual(createdTitles, [
    "OpenSpec · identity-service",
    "Предложения",
    "Дизайн архитектуры",
    "Задачи",
    "Спецификация · Контракт идентификации",
    "OpenSpec · catalog-service",
    "Предложения",
    "Дизайн архитектуры",
    "Задачи",
    "Спецификация · Контракт каталога",
  ]);
});

test("HTTP-клиент повторяет временную ошибку и не раскрывает токен", async () => {
  let attempt = 0;
  const client = new NotionClient({
    token: "secret-token",
    retries: 1,
    fetchImpl: async () => {
      attempt += 1;
      return {
        ok: false,
        status: attempt === 1 ? 503 : 401,
        text: async () =>
          JSON.stringify({ message: "Bearer secret-token rejected" }),
      };
    },
  });
  await assert.rejects(
    client.request("/test"),
    (error) =>
      error.code === "NOTION_HTTP_401" &&
      !error.message.includes("secret-token"),
  );
  assert.equal(attempt, 2);
});

test("CLI выводит переходы родителей и соблюдает strict для ошибки иерархии", async () => {
  const makeStream = () => {
    let value = "";
    return {
      stream: {
        write: (chunk) => {
          value += chunk;
        },
      },
      value: () => value,
    };
  };
  const env = {
    NOTION_TOKEN: "token",
    NOTION_BACKLOG_DATABASE_ID: "source",
    NOTION_PARENT_PROPERTY: "Родитель",
  };
  const metadata = {
    object: "data_source",
    id: "source",
    properties: {
      Задача: { type: "title" },
      ID: { type: "unique_id" },
      Статус: {
        type: "status",
        status: { options: STATUS_FLOW.map((name) => ({ name })) },
      },
      Родитель: { type: "relation" },
    },
  };
  const pages = [
    page({ id: "parent", title: "Группа", code: "", status: "Бэклог" }),
    page({ id: "child", title: "Целевая задача", parent: ["parent"] }),
  ];
  const clientFactory = () => ({
    async request(path, options = {}) {
      if (path === "/data_sources/source") return metadata;
      if (path === "/data_sources/source/query") return { results: pages };
      const pageId = path.replace("/pages/", "");
      pages.find((item) => item.id === pageId).properties.Статус.status.name =
        options.body.properties.Статус.status.name;
      return {};
    },
  });
  const successOutput = makeStream();
  assert.equal(
    await runCli(["status", "W-97", "Аналитика", "--strict"], {
      env,
      clientFactory,
      stdout: successOutput.stream,
      stderr: makeStream().stream,
    }),
    0,
  );
  assert.match(
    successOutput.value(),
    /Родительская задача «Группа»: «Бэклог» → «Аналитика»/u,
  );

  let writes = 0;
  const brokenClientFactory = () => ({
    async request(path) {
      if (path === "/data_sources/source") return metadata;
      if (path === "/data_sources/source/query") {
        return {
          results: [
            page({
              id: "child",
              title: "Целевая задача",
              parent: ["missing"],
            }),
          ],
        };
      }
      writes += 1;
      return {};
    },
  });
  const bestEffortError = makeStream();
  assert.equal(
    await runCli(["status", "W-97", "Аналитика"], {
      env,
      clientFactory: brokenClientFactory,
      stdout: makeStream().stream,
      stderr: bestEffortError.stream,
    }),
    0,
  );
  assert.match(bestEffortError.value(), /Работа продолжается/u);
  const strictError = makeStream();
  assert.equal(
    await runCli(["status", "W-97", "Аналитика", "--strict"], {
      env,
      clientFactory: brokenClientFactory,
      stdout: makeStream().stream,
      stderr: strictError.stream,
    }),
    1,
  );
  assert.match(strictError.value(), /Родительская страница missing/u);
  assert.equal(writes, 0);
});

test("best-effort не блокирует внешний сбой, strict возвращает ошибку", async () => {
  const makeStream = () => {
    let value = "";
    return {
      stream: {
        write: (chunk) => {
          value += chunk;
        },
      },
      value: () => value,
    };
  };
  const env = {
    NOTION_TOKEN: "token",
    NOTION_BACKLOG_DATABASE_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const clientFactory = () => ({
    request: async () => {
      throw new TaskNotionError("NOTION_TIMEOUT", "Notion не ответил вовремя", {
        external: true,
      });
    },
  });
  const normalError = makeStream();
  assert.equal(
    await runCli(["doctor"], {
      env,
      clientFactory,
      stderr: normalError.stream,
      stdout: makeStream().stream,
    }),
    0,
  );
  assert.match(normalError.value(), /Работа продолжается/u);
  const strictError = makeStream();
  assert.equal(
    await runCli(["doctor", "--strict"], {
      env,
      clientFactory,
      stderr: strictError.stream,
      stdout: makeStream().stream,
    }),
    1,
  );
  assert.doesNotMatch(strictError.value(), /доступен/u);
});

const backlogMetadata = (id = "backlog") => ({
  object: "data_source",
  id,
  properties: {
    Задача: { type: "title" },
    ID: { type: "unique_id" },
    Статус: {
      type: "status",
      status: { options: STATUS_FLOW.map((name) => ({ name })) },
    },
    "Parent item": { type: "relation" },
    "Sub-item": { type: "relation" },
    Тип: {
      type: "select",
      select: {
        options: ["Epic", "Story", "Task", "Subtask", "Bug"].map((name) => ({ name })),
      },
    },
    Приоритет: {
      type: "select",
      select: { options: ["critical", "high", "medium", "low"].map((name) => ({ name })) },
    },
    Размер: {
      type: "select",
      select: { options: ["Small", "Normal", "Large", "Huge"].map((name) => ({ name })) },
    },
    "Технический долг": { type: "checkbox", checkbox: {} },
    "Дата релиза": { type: "date", date: {} },
    Релиз: { type: "relation" },
    "Баг релиза": { type: "relation" },
    "Входящие задачи": { type: "relation" },
    "Релиз-процесс": {
      type: "select",
      select: { options: ["legacy", RELEASE_PROCESS_V1].map((name) => ({ name })) },
    },
  },
});

const businessMetadata = (id = "business") => ({
  object: "data_source",
  id,
  properties: {
    Требование: { type: "title" },
    "Parent item": { type: "relation" },
    "Sub-item": { type: "relation" },
  },
});

const businessPage = ({ id, title, parent = [], children = [] }) => ({
  object: "page",
  id,
  icon: { type: "emoji", emoji: "🔎" },
  properties: {
    Требование: { title: [{ plain_text: title }] },
    "Parent item": { relation: parent.map((parentId) => ({ id: parentId })) },
    "Sub-item": { relation: children.map((childId) => ({ id: childId })) },
  },
});

const notionParagraph = (id, text) => ({
  object: "block",
  id,
  type: "paragraph",
  paragraph: { rich_text: [{ plain_text: text }] },
  has_children: false,
});

const notionToggle = (id, text) => ({
  object: "block",
  id,
  type: "toggle",
  toggle: { rich_text: [{ plain_text: text }] },
  has_children: true,
});

test("конфигурация и doctor поддерживают две независимые базы", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-notion-two-db-"));
  const path = join(directory, "notion.env");
  await writeFile(
    path,
    [
      "NOTION_TOKEN=secret",
      "NOTION_BACKLOG_DATABASE_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "NOTION_BUSINESS_REQUIREMENTS_DATABASE_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "NOTION_TYPE_PROPERTY=Тип",
      "NOTION_RELEASE_PROCESS_PROPERTY=Релиз-процесс",
    ].join("\n"),
    { mode: 0o600 },
  );
  try {
    const config = await loadConfig({ configPath: path, env: {}, requireBusiness: true });
    assert.equal(config.businessDatabaseId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(config.typeProperty, "Тип");
    assert.equal(config.releaseProcessProperty, "Релиз-процесс");
    const client = {
      async request(requestPath) {
        if (requestPath === "/data_sources/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
          return backlogMetadata("backlog-source");
        if (requestPath === "/data_sources/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
          return businessMetadata("business-source");
        assert.fail(`Неожиданный запрос: ${requestPath}`);
      },
    };
    const result = await inspectWorkspace(client, config);
    assert.equal(result.schema.typeName, "Тип");
    assert.equal(result.schema.releaseProcessName, "Релиз-процесс");
    assert.equal(result.businessSchema.subItemName, "Sub-item");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("типы, размеры и шаблоны W следуют закрытому контракту", () => {
  assert.deepEqual(ALLOWED_CHILD_TYPES.Эпик, ["История", "Баг"]);
  assert.deepEqual(randomPageIcon(() => 0), {
    type: "emoji",
    emoji: PAGE_ICONS[0],
  });
  assert.equal(assertTaskTitleWithoutTaskCode("Тестовая задача процесса"), true);
  assert.throws(
    () => assertTaskTitleWithoutTaskCode("W-269 · Тестовая задача процесса"),
    (error) => error.code === "TASK_TITLE_W_CODE_FORBIDDEN",
  );
  assert.equal(assertAllowedTaskRelation("История", "Задача"), true);
  assert.throws(
    () => assertAllowedTaskRelation("Эпик", "Задача"),
    (error) => error.code === "TASK_RELATION_INVALID",
  );
  assert.throws(
    () => assertAllowedTaskRelation("Баг", "Подзадача"),
    (error) => error.code === "TASK_RELATION_INVALID",
  );
  assert.deepEqual(
    [200, 201, 1000, 1001, 5000, 5001].map(estimateTaskSize),
    ["Маленький", "Обычный", "Обычный", "Крупный", "Крупный", "Огромный"],
  );
  assert.equal(resolveStoredOption(["Epic"], "Эпик", TASK_TYPE_STORAGE), "Epic");
  assert.equal(resolveStoredOption(["Large"], "Крупный", SIZE_STORAGE), "Large");

  const story = buildTaskTemplate({
    type: "История",
    description: "Текущее поведение смешано с соседним модулем.\n\nНовый модуль должен владеть поведением самостоятельно.",
    businessRequirementIds: ["business"],
    steps: ["Выделить самостоятельного владельца"],
    checks: ["Пользовательский сценарий проходит через нового владельца"],
  });
  const relationCallout = story.find((item) => item.type === "callout");
  assert.ok(relationCallout);
  assert.equal(relationCallout.callout.icon.emoji, CALLOUT_ICON);
  assert.ok(
    story.every((item) => !item[item.type]?.rich_text?.some(
      (text) => text.text?.content?.startsWith("openspec/"),
    )),
  );
  const task = buildTaskTemplate({
    type: "Задача",
    description: "Реализовать ограниченный этап тестовой истории.",
    storyId: "story",
    steps: ["Реализовать этап"],
    expectedResults: ["Этап готов к самостоятельной проверке"],
    checks: ["Запустить реальный сценарий"],
  });
  assert.equal(
    task[0].paragraph.rich_text[0].text.content,
    "Реализовать ограниченный этап тестовой истории.",
  );
  assert.equal(blockText(task[1]), "Поведение описано в .");
  assert.equal(task[1].paragraph.rich_text[1].mention.page.id, "story");
  for (const label of ["Шаги задачи", "Ожидаемый результат", "Проверка"]) {
    assert.ok(task.some((item) => blockText(item) === label));
  }
  assert.equal(task.filter((item) => item.type === "to_do").length, 3);
  const bug = buildTaskTemplate({
    type: "Баг",
    description: "Кнопка не сохраняет значение.",
    parentId: "task",
    expectedResult: "Значение сохранено.",
    actualResult: "Форма остаётся открытой.",
  });
  assert.equal(bug[0].type, "paragraph");
  assert.equal(bug.some((item) => item.type === "callout"), false);
  const visible = bug
    .flatMap((item) => item[item.type]?.rich_text || [])
    .map((item) => item.text?.content || item.plain_text || "")
    .join(" ");
  assert.match(visible, /ОР/u);
  assert.match(visible, /ФР/u);
  for (const label of ["Описание дефекта:", "ОР:", "ФР:", "Приложения:"]) {
    const item = bug.find((block) => blockText(block) === label);
    assert.equal(item.paragraph.rich_text[0].annotations.bold, true);
  }
  assert.match(visible, /Приложения/u);
  const topLevelBug = buildTaskTemplate({
    type: "Баг",
    description: "Ошибка есть в установленной версии.",
    discoveredReleaseId: "release",
    expectedResult: "Ошибка отсутствует.",
    actualResult: "Ошибка воспроизводится.",
  });
  assert.equal(blockText(topLevelBug[0]), "Обнаружен: ");
  assert.equal(topLevelBug[0].callout.icon.emoji, CALLOUT_ICON);
  assert.equal(
    topLevelBug[0].callout.rich_text[1].mention.page.id,
    "release",
  );
});

test("история релиза содержит только changes без статической таблицы и спецификаций", () => {
  const blocks = buildReleaseStoryTemplate({
    releaseDate: "2026-08-14",
    changes: ["Добавлен журнал ошибок AI-запросов"],
    currentYear: 2026,
  });
  assert.equal(blockText(blocks[0]), "Дата релиза — 14 августа");
  assert.equal(blocks[0].callout.icon.emoji, CALLOUT_ICON);
  assert.equal(blockText(blocks[1]), "Изменения");
  assert.equal(blockText(blocks[2]), "Добавлен журнал ошибок AI-запросов");
  assert.equal(blocks.at(-1).type, "divider");
  assert.equal(
    formatReleaseDateRu("2026-08-14", { currentYear: 2026 }),
    "14 августа",
  );
  assert.equal(
    formatReleaseDateRu("2025-08-14", { currentYear: 2026 }),
    "14 августа 2025",
  );
  assert.equal(formatReleaseTitleRu("2026-11-14"), "Релиз от 14 ноября 2026");
  assert.throws(
    () => formatReleaseDateRu("2026-02-30"),
    (error) => error.code === "RELEASE_DATE_INVALID",
  );
  assert.equal(blocks.some((item) => item.type === "table"), false);
  assert.equal(blocks.some((item) => item.type === "toggle"), false);
});

test("повторное создание достраивает только непрерывный хвост шаблона", () => {
  const expected = buildTaskTemplate({
    type: "Подзадача",
    description: "Проверить ограниченный этап.",
    parentId: "task",
    steps: ["Первый шаг", "Второй шаг"],
    expectedResults: ["Ограниченный этап подтверждён"],
  });
  assert.deepEqual(missingBlockSuffix(expected.slice(0, 2), expected), expected.slice(2));
  assert.deepEqual(missingBlockSuffix(expected, expected), []);
  assert.throws(
    () => missingBlockSuffix([expected[0], expected[2]], expected),
    (error) => error.code === "CREATE_CONTENT_CONFLICT",
  );
});

test("массовое обновление карточек сохраняет OpenSpec и проверяет полный охват", async () => {
  const epic = page({
    id: "refresh-epic",
    title: "Архитектурная миграция",
    code: "W-287",
    type: "Epic",
    technicalDebt: true,
  });
  const story = page({
    id: "refresh-story",
    title: "Старая история",
    code: "W-321",
    type: "Story",
    parent: ["refresh-epic"],
    status: "Разработка",
  });
  const task = page({
    id: "refresh-task",
    title: "Старая задача",
    code: "W-352",
    type: "Task",
    parent: ["refresh-story"],
    status: "Закрыто",
  });
  const bug = page({
    id: "refresh-bug",
    title: "Внутренний дефект",
    code: "W-399",
    type: "Bug",
    parent: ["refresh-task"],
  });
  for (const item of [epic, story, task, bug]) {
    item.properties["Parent item"] = item.properties.Родитель;
    delete item.properties.Родитель;
  }
  const managedSpec = notionToggle("managed-spec", "OpenSpec · catalog-service");
  const blocks = new Map([
    ["refresh-story", [notionParagraph("old-story", "Старое описание"), managedSpec]],
    ["refresh-task", [notionParagraph("old-task", "Старая задача")]],
  ]);
  const calls = [];
  let sequence = 0;
  const client = {
    async request(requestPath, options = {}) {
      calls.push([requestPath, options]);
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query") {
        return { results: [epic, story, task, bug], has_more: false };
      }
      const readMatch = requestPath.match(/^\/blocks\/([^/]+)\/children\?/u);
      if (readMatch) {
        return { results: blocks.get(readMatch[1]) || [], has_more: false };
      }
      const appendMatch = requestPath.match(/^\/blocks\/([^/]+)\/children$/u);
      if (appendMatch && options.method === "PATCH") {
        const created = options.body.children.map((item) => ({
          ...item,
          id: `refreshed-${sequence += 1}`,
        }));
        const current = blocks.get(appendMatch[1]) || [];
        const anchorIndex = current.findIndex(
          (item) => item.id === options.body.position.after_block.id,
        );
        current.splice(anchorIndex + 1, 0, ...created);
        blocks.set(appendMatch[1], current);
        return { results: created };
      }
      if (requestPath.startsWith("/blocks/") && options.method === "DELETE") {
        return {};
      }
      if (requestPath === "/pages/refresh-story" && options.method === "PATCH") {
        return {};
      }
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  const manifest = {
    items: [
      {
        code: "W-321",
        title: "Актуальная история",
        description: "История объясняет самостоятельный результат.",
        steps: ["Выполнить дочернюю задачу"],
        checks: ["Результат подтверждён"],
      },
      {
        code: "W-352",
        description: "Задача описывает один этап.",
        steps: ["Выполнить этап"],
        expectedResults: ["Этап завершён"],
        checks: ["Проверка воспроизводится"],
      },
    ],
  };

  const dryRun = await refreshTaskContents(
    client,
    { databaseId: "backlog" },
    "W-287",
    { dryRun: true, manifest },
  );
  assert.deepEqual(dryRun, { updated: 2, renamed: 1, dryRun: true });
  assert.equal(calls.some(([, options]) => options.method === "PATCH"), false);
  assert.equal(calls.some(([, options]) => options.method === "DELETE"), false);
  calls.length = 0;

  const result = await refreshTaskContents(
    client,
    { databaseId: "backlog" },
    "W-287",
    { approved: true, manifest },
  );
  assert.deepEqual(result, { updated: 2, renamed: 1, dryRun: false });
  assert.ok(!calls.some(([path]) => path === "/blocks/managed-spec"));
  assert.ok(calls.some(([path]) => path === "/blocks/old-story"));
  assert.ok(calls.some(([path]) => path === "/blocks/old-task"));
  const storyAppend = calls.find(
    ([path, options]) =>
      path === "/blocks/refresh-story/children" && options.method === "PATCH",
  );
  assert.deepEqual(storyAppend[1].body.position, {
    type: "after_block",
    after_block: { id: "old-story" },
  });
  const taskAppend = calls.find(
    ([path, options]) =>
      path === "/blocks/refresh-task/children" && options.method === "PATCH",
  );
  assert.equal(
    taskAppend[1].body.children.find((item) => item.type === "to_do").to_do.checked,
    true,
  );

  await assert.rejects(
    refreshTaskContents(
      client,
      { databaseId: "backlog" },
      "W-287",
      { approved: true, manifest: { items: manifest.items.slice(0, 1) } },
    ),
    (error) => error.code === "CONTENT_MANIFEST_SCOPE_MISMATCH",
  );
});

test("у release-эпика и release-истории нет приоритета", () => {
  assert.deepEqual(
    resolveTaskPriority({ type: "Эпик", releaseHistory: true }),
    { priority: "", source: "not-applicable" },
  );
  assert.deepEqual(
    resolveTaskPriority({ type: "История", releaseHistory: true }),
    { priority: "", source: "not-applicable" },
  );
  assert.throws(
    () =>
      resolveTaskPriority({
        type: "История",
        releaseHistory: true,
        priorityOverride: "high",
      }),
    (error) => error.code === "RELEASE_PRIORITY_FORBIDDEN",
  );
});

test("бизнес-сущность истории релизов не получает статическое описание или индекс", () => {
  assert.deepEqual(buildReleaseHistoryBusinessTemplate(), []);
  const history = releaseHistoryViewBody("backlog", schema);
  assert.deepEqual(history.filter, {
    property: "Дата релиза",
    date: { is_not_empty: true },
  });
  assert.deepEqual(
    history.configuration.properties.map((item) => item.property_id),
    ["Задача", "Дата релиза"],
  );
  const incoming = releaseIncomingViewBody("backlog", schema, "release");
  assert.deepEqual(incoming.filter, {
    property: "Релиз",
    relation: { contains: "release" },
  });
  assert.deepEqual(
    incoming.configuration.properties.map((item) => item.property_id),
    ["ID", "Задача", "Статус"],
  );
});

test("состав релиза сворачивает задачи до эпика и не дублирует прямой баг истории", () => {
  const release = page({
    id: "release",
    title: "Релиз от 14 августа 2026",
    code: "W-281",
    type: "Story",
    priority: "",
    releaseDate: "2026-08-14",
  });
  const epic = page({
    id: "epic",
    title: "Готовый эпик",
    code: "W-80",
    type: "Epic",
    status: "Закрыто",
    releases: ["previous-release"],
  });
  const story = page({
    id: "story",
    title: "Готовая история",
    code: "W-81",
    parent: ["epic"],
    type: "Story",
    status: "Закрыто",
  });
  const task = page({
    id: "task",
    title: "Готовая задача",
    code: "W-82",
    parent: ["story"],
    type: "Task",
    status: "Закрыто",
  });
  const directBug = page({
    id: "direct-bug",
    title: "Баг истории",
    code: "W-83",
    parent: ["story"],
    type: "Bug",
    status: "Закрыто",
    size: "",
  });
  const separateBug = page({
    id: "separate-bug",
    title: "Баг задачи",
    code: "W-84",
    parent: ["task"],
    type: "Bug",
    status: "Закрыто",
    size: "",
  });
  const plan = buildReleaseRelationPlan(
    [release, epic, story, task, directBug, separateBug],
    schema,
    release,
    ["W-82", "W-83", "W-84", "W-82"],
  );
  assert.deepEqual(plan.selected.map((item) => [item.code, item.type]), [
    ["W-80", "Эпик"],
    ["W-84", "Баг"],
  ]);
  assert.deepEqual(plan.updates, [
    { pageId: "epic", targetIds: ["previous-release", "release"] },
    { pageId: "separate-bug", targetIds: ["release"] },
  ]);
});

test("незакрытый эпик отображает закрытую историю, а незакрытая история блокирует релиз", () => {
  const release = page({
    id: "release",
    title: "Релиз от 14 августа 2026",
    code: "W-281",
    type: "Story",
    priority: "",
    releaseDate: "2026-08-14",
  });
  const epic = page({ id: "epic", title: "Эпик", code: "W-80", type: "Epic", status: "Разработка" });
  const story = page({ id: "story", title: "История", code: "W-81", parent: ["epic"], type: "Story", status: "Закрыто" });
  const task = page({ id: "task", title: "Задача", code: "W-82", parent: ["story"], type: "Task", status: "Закрыто" });
  const plan = buildReleaseRelationPlan([release, epic, story, task], schema, release, ["W-82"]);
  assert.deepEqual(plan.selected.map((item) => item.code), ["W-81"]);

  story.properties.Статус.status.name = "Ожидание релиза";
  assert.throws(
    () => buildReleaseRelationPlan([release, epic, story, task], schema, release, ["W-82"]),
    (error) => error.code === "RELEASE_UNCLOSED_STORY",
  );
});

test("открытый вложенный баг блокирует выпуск истории и эпика", () => {
  const release = page({
    id: "release",
    title: "Релиз от 14 августа 2026",
    code: "W-281",
    type: "Story",
    priority: "",
    releaseDate: "2026-08-14",
  });
  const epic = page({ id: "epic", title: "Эпик", code: "W-80", type: "Epic", status: "Закрыто" });
  const story = page({ id: "story", title: "История", code: "W-81", parent: ["epic"], type: "Story", status: "Закрыто" });
  const task = page({ id: "task", title: "Задача", code: "W-82", parent: ["story"], type: "Task", status: "Закрыто" });
  const bug = page({ id: "bug", title: "Баг", code: "W-83", parent: ["task"], type: "Bug", status: "Тестирование", size: "" });
  assert.throws(
    () => buildReleaseRelationPlan([release, epic, story, task, bug], schema, release, ["W-82"]),
    (error) => error.code === "RELEASE_OPEN_SUBITEM_BUG" && /W-83/u.test(error.message),
  );

  bug.properties.Родитель.relation = [];
  bug.properties["Баг релиза"].relation = [{ id: "release" }];
  const plan = buildReleaseRelationPlan([release, epic, story, task, bug], schema, release, ["W-82"]);
  assert.deepEqual(plan.selected.map((item) => item.code), ["W-80"]);
});

test("подзадача не может быть самостоятельным коммитом релиза", () => {
  const release = page({ id: "release", title: "Релиз", code: "W-281", type: "Story", priority: "", releaseDate: "2026-08-14" });
  const task = page({ id: "task", title: "Задача", code: "W-82", type: "Task", status: "Закрыто" });
  const subtask = page({ id: "subtask", title: "Подзадача", code: "W-83", parent: ["task"], type: "Subtask", status: "Закрыто" });
  assert.throws(
    () => buildReleaseRelationPlan([release, task, subtask], schema, release, ["W-83"]),
    (error) => error.code === "RELEASE_SUBTASK_COMMIT_FORBIDDEN",
  );
});

test("коммит истории и незакрытой задачи не могут формировать релиз", () => {
  const release = page({ id: "release", title: "Релиз", code: "W-281", type: "Story", priority: "", releaseDate: "2026-08-14" });
  const story = page({ id: "story", title: "История", code: "W-81", type: "Story", status: "Закрыто" });
  const task = page({ id: "task", title: "Задача", code: "W-82", parent: ["story"], type: "Task", status: "Тестирование" });
  assert.throws(
    () => buildReleaseRelationPlan([release, story, task], schema, release, ["W-81"]),
    (error) => error.code === "RELEASE_STORY_COMMIT_FORBIDDEN",
  );
  assert.throws(
    () => buildReleaseRelationPlan([release, story, task], schema, release, ["W-82"]),
    (error) => error.code === "RELEASE_UNCLOSED_TASK",
  );
});

test("баг не меняет родителей и не участвует в свёртке соседей", () => {
  const typedSchema = { ...schema, typeName: "Тип" };
  const pages = [
    page({ id: "epic", title: "Эпик", code: "", status: "Аналитика", type: "Epic" }),
    page({ id: "story", title: "История", code: "", parent: ["epic"], status: "Аналитика", type: "Story" }),
    page({ id: "task", title: "Задача", parent: ["story"], status: "Разработка", type: "Task" }),
    page({ id: "bug", title: "Баг", code: "W-97", parent: ["story"], status: "Бэклог", type: "Bug", size: "" }),
  ];
  const bugPlan = buildStatusUpdatePlan(pages, typedSchema, "bug", "Тестирование");
  assert.deepEqual(bugPlan.updates.map((item) => item.pageId), ["bug"]);
  const taskPlan = buildStatusUpdatePlan(pages, typedSchema, "task", "Тестирование");
  assert.deepEqual(taskPlan.updates.map((item) => item.pageId), ["task", "story", "epic"]);

  const onlyBug = [
    page({ id: "parent", title: "Родитель", code: "", status: "Аналитика", type: "Story" }),
    page({ id: "bug", title: "Баг", parent: ["parent"], status: "Бэклог", type: "Bug", size: "" }),
  ];
  const onlyBugPlan = buildStatusUpdatePlan(onlyBug, typedSchema, "bug", "Разработка");
  assert.deepEqual(onlyBugPlan.parentUpdates, []);
});

test("открытый вложенный баг не меняет статус родителя, но блокирует ожидание релиза", () => {
  const pages = [
    page({ id: "story", title: "История", code: "W-81", status: "Тестирование", type: "Story" }),
    page({ id: "task", title: "Задача", code: "W-82", parent: ["story"], status: "Тестирование", type: "Task" }),
    page({ id: "bug", title: "Баг", code: "W-83", parent: ["task"], status: "Тестирование", type: "Bug", size: "" }),
  ];
  assert.throws(
    () => buildStatusUpdatePlan(pages, schema, "story", "Ожидание релиза"),
    (error) => error.code === "RELEASE_OPEN_SUBITEM_BUG",
  );
  const bugPlan = buildStatusUpdatePlan(pages, schema, "bug", "Разработка");
  assert.deepEqual(bugPlan.parentUpdates, []);
});

test("снимок бизнес-требований проверяет два уровня и master fingerprint", async () => {
  const root = businessPage({ id: "root", title: "Модуль", children: ["child"] });
  const child = businessPage({ id: "child", title: "Подписка", parent: ["root"] });
  const rootBlocks = [
    notionParagraph("description", "Бизнес-проблема."),
    { object: "block", id: "divider", type: "divider", divider: {}, has_children: false },
    notionParagraph("marker", MASTER_SPEC_MARKER),
    notionParagraph("master", "Подписка работает после оплаты."),
  ];
  const childBlocks = [notionParagraph("child-description", "Управление подпиской.")];
  const writes = [];
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/business") return businessMetadata();
      if (requestPath === "/data_sources/business/query")
        return { results: [root, child], has_more: false };
      if (requestPath.startsWith("/blocks/root/children?"))
        return { results: rootBlocks, has_more: false };
      if (requestPath.startsWith("/blocks/child/children?"))
        return { results: childBlocks, has_more: false };
      if (requestPath === "/blocks/master" && options.method === "DELETE") {
        writes.push([requestPath, options]);
        rootBlocks.pop();
        return {};
      }
      if (requestPath === "/blocks/marker" && options.method === "PATCH") {
        writes.push([requestPath, options]);
        return {};
      }
      if (requestPath === "/blocks/root/children") {
        writes.push([requestPath, options]);
        return { results: [] };
      }
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  const config = { businessDatabaseId: "business", businessParentProperty: "Parent item" };
  const snapshot = await inspectBusinessRequirements(client, config);
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.items[0].master.text, "Подписка работает после оплаты.");
  assert.equal(snapshot.items[1].parentId, "root");
  const currentFingerprint = snapshot.items[0].master.fingerprint;
  await assert.rejects(
    updateMasterSpecification(client, config, "root", {
      markdown: "Новое правило.",
      expectedFingerprint: "stale",
    }),
    (error) => error.code === "MASTER_FINGERPRINT_CONFLICT",
  );
  assert.equal(writes.length, 0);
  await updateMasterSpecification(client, config, "root", {
    markdown: "Новое правило.",
    expectedFingerprint: currentFingerprint,
  });
  assert.ok(writes.some(([requestPath]) => requestPath === "/blocks/master"));

  assert.throws(
    () =>
      buildBusinessHierarchySnapshot(
        [root, child, businessPage({ id: "third", title: "Третий", parent: ["child"] })],
        { titleName: "Требование", parentName: "Parent item" },
      ),
    (error) => error.code === "BUSINESS_HIERARCHY_TOO_DEEP",
  );
  assert.throws(
    () => masterSection([notionParagraph("one", MASTER_SPEC_MARKER), notionParagraph("two", MASTER_SPEC_MARKER)]),
    (error) => error.code === "MASTER_MARKER_AMBIGUOUS",
  );
});

test("создание задачи наследует приоритет эпика, вычисляет размер и не дублирует страницу", async () => {
  const localSchema = discoverSchema(backlogMetadata(), {}, { requireTyped: true });
  const pages = [
    page({ id: "epic", title: "Эпик", code: "W-1", type: "Epic", priority: "high", size: "Large" }),
    page({ id: "story", title: "История", code: "W-2", parent: ["epic"], type: "Story", priority: "high", size: "Normal" }),
  ].map((item) => {
    item.properties["Parent item"] = item.properties.Родитель;
    delete item.properties.Родитель;
    return item;
  });
  let createdBlocks = [];
  const writes = [];
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query")
        return { results: pages, has_more: false };
      if (requestPath === "/pages") {
        writes.push([requestPath, options]);
        createdBlocks = options.body.children.map((item, index) => ({
          ...item,
          id: `created-block-${index}`,
          has_children: false,
        }));
        const created = {
          object: "page",
          id: "created-task",
          properties: {
            ...options.body.properties,
            ID: { unique_id: { prefix: "W", number: 3 } },
          },
        };
        pages.push(created);
        return created;
      }
      if (requestPath.startsWith("/blocks/created-task/children?"))
        return { results: createdBlocks, has_more: false };
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  const config = { databaseId: "backlog" };
  const input = {
    type: "Задача",
    title: "Собрать API",
    description: "Реализовать согласованный этап истории.",
    parentCode: "W-2",
    estimatedCodeLines: 1001,
    steps: ["Собрать API"],
    expectedResults: ["API готов к проверке"],
  };
  const first = await createTaskItem(client, config, input);
  assert.equal(first.priority, "high");
  assert.equal(first.prioritySource, "epic");
  assert.equal(first.size, "Крупный");
  const properties = writes[0][1].body.properties;
  assert.equal(writes[0][1].body.icon.type, "emoji");
  assert.ok(PAGE_ICONS.includes(writes[0][1].body.icon.emoji));
  assert.equal(properties[localSchema.typeName].select.name, "Task");
  assert.equal(properties[localSchema.sizeName].select.name, "Large");
  assert.equal(
    properties[localSchema.releaseProcessName].select.name,
    RELEASE_PROCESS_V1,
  );
  const second = await createTaskItem(client, config, input);
  assert.equal(second.resumed, true);
  assert.equal(writes.length, 1);
});

test("повторное создание восстанавливает release-процесс v1", async () => {
  const pages = [
    page({
      id: "epic",
      title: "Эпик",
      code: "W-1",
      type: "Epic",
      priority: "high",
      releaseProcess: RELEASE_PROCESS_V1,
    }),
    page({
      id: "story",
      title: "История",
      code: "W-2",
      parent: ["epic"],
      type: "Story",
      priority: "high",
      releaseProcess: RELEASE_PROCESS_V1,
    }),
    page({
      id: "task",
      title: "Собрать API",
      code: "W-3",
      parent: ["story"],
      type: "Task",
      priority: "high",
    }),
  ].map((item) => {
    item.properties["Parent item"] = item.properties.Родитель;
    delete item.properties.Родитель;
    return item;
  });
  const writes = [];
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query")
        return { results: pages, has_more: false };
      if (requestPath.startsWith("/blocks/task/children?"))
        return {
          results: buildTaskTemplate({
            type: "Задача",
            description: "Реализовать согласованный этап истории.",
            storyId: "story",
            steps: ["Собрать API"],
            expectedResults: ["API готов к проверке"],
          }).map((item, index) => ({
            ...item,
            id: `task-block-${index}`,
            has_children: false,
          })),
          has_more: false,
        };
      if (requestPath === "/pages/task") {
        writes.push(options.body);
        pages[2].properties["Релиз-процесс"] =
          options.body.properties["Релиз-процесс"];
        return pages[2];
      }
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };

  const result = await createTaskItem(client, { databaseId: "backlog" }, {
    type: "Задача",
    title: "Собрать API",
    description: "Реализовать согласованный этап истории.",
    parentCode: "W-2",
    estimatedCodeLines: 100,
    steps: ["Собрать API"],
    expectedResults: ["API готов к проверке"],
  });

  assert.equal(result.resumed, true);
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0].properties["Релиз-процесс"].select.name,
    RELEASE_PROCESS_V1,
  );
});

test("backfill release-процесса ограничен выбранной иерархией", async () => {
  const pages = [
    page({
      id: "epic",
      title: "Эпик",
      code: "W-1",
      type: "Epic",
      releaseProcess: RELEASE_PROCESS_V1,
    }),
    page({
      id: "story",
      title: "История",
      code: "W-2",
      parent: ["epic"],
      type: "Story",
    }),
    page({
      id: "task",
      title: "Задача",
      code: "W-3",
      parent: ["story"],
      type: "Task",
      releaseProcess: "legacy",
    }),
    page({
      id: "outside",
      title: "Другой эпик",
      code: "W-4",
      type: "Epic",
    }),
  ].map((item) => {
    item.properties["Parent item"] = item.properties.Родитель;
    delete item.properties.Родитель;
    return item;
  });
  const writes = [];
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query")
        return { results: pages, has_more: false };
      if (requestPath.startsWith("/pages/")) {
        writes.push([requestPath, options.body]);
        return {};
      }
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };

  await assert.rejects(
    backfillReleaseProcessV1(client, { databaseId: "backlog" }, "W-1"),
    (error) => error.code === "APPROVAL_REQUIRED",
  );
  const result = await backfillReleaseProcessV1(
    client,
    { databaseId: "backlog" },
    "W-1",
    { approved: true },
  );

  assert.deepEqual(
    {
      rootCode: result.rootCode,
      total: result.total,
      changed: result.changed,
      unchanged: result.unchanged,
    },
    { rootCode: "W-1", total: 3, changed: 2, unchanged: 1 },
  );
  assert.deepEqual(
    writes.map(([requestPath]) => requestPath).sort(),
    ["/pages/story", "/pages/task"],
  );
  assert.ok(
    writes.every(
      ([, body]) =>
        body.properties["Релиз-процесс"].select.name === RELEASE_PROCESS_V1,
    ),
  );
});

test("создание бага выбирает Parent item либо релиз обнаружения", async () => {
  const pages = [
    page({ id: "epic", title: "Эпик", code: "W-1", type: "Epic", priority: "high" }),
    page({ id: "story", title: "История", code: "W-2", parent: ["epic"], type: "Story", priority: "high" }),
    page({ id: "task", title: "Задача", code: "W-3", parent: ["story"], type: "Task", priority: "high" }),
    page({ id: "release", title: "Релиз", code: "W-4", type: "Story", priority: "", releaseDate: "2026-08-14" }),
  ].map((item) => {
    item.properties["Parent item"] = item.properties.Родитель;
    delete item.properties.Родитель;
    return item;
  });
  const writes = [];
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query")
        return { results: pages, has_more: false };
      if (requestPath === "/pages") {
        writes.push(options.body);
        return {
          object: "page",
          id: `bug-${writes.length}`,
          properties: {
            ...options.body.properties,
            ID: { unique_id: { prefix: "W", number: 4 + writes.length } },
          },
        };
      }
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  const base = {
    type: "Баг",
    description: "Ошибка воспроизводится.",
    expectedResult: "Ошибки нет.",
    actualResult: "Ошибка есть.",
    approved: true,
  };
  await assert.rejects(
    createTaskItem(client, { databaseId: "backlog" }, {
      ...base,
      approved: false,
      title: "Внутренний дефект до приёмки",
      parentCode: "W-3",
    }),
    (error) => error.code === "BUG_EXTERNAL_ACCEPTANCE_REQUIRED",
  );
  await createTaskItem(client, { databaseId: "backlog" }, {
    ...base,
    title: "Вложенный баг",
    parentCode: "W-3",
  });
  assert.deepEqual(writes[0].properties["Parent item"].relation, [{ id: "task" }]);
  assert.equal(writes[0].properties["Баг релиза"], undefined);
  assert.equal(writes[0].children.some((item) => item.type === "callout"), false);

  pages[1].properties.Релиз.relation = [{ id: "previous-release" }];
  await assert.rejects(
    createTaskItem(client, { databaseId: "backlog" }, {
      ...base,
      title: "Баг выпущенной истории",
      parentCode: "W-3",
    }),
    (error) => error.code === "BUG_RELEASED_PARENT_FORBIDDEN",
  );
  pages[1].properties.Релиз.relation = [];

  await createTaskItem(client, { databaseId: "backlog" }, {
    ...base,
    title: "Верхнеуровневый баг",
    discoveredReleaseCode: "W-4",
    priority: "high",
  });
  assert.equal(writes[1].properties["Parent item"], undefined);
  assert.deepEqual(writes[1].properties["Баг релиза"].relation, [{ id: "release" }]);
  assert.equal(blockText(writes[1].children[0]), "Обнаружен: ");

  await assert.rejects(
    createTaskItem(client, { databaseId: "backlog" }, {
      ...base,
      title: "Смешанная связь",
      parentCode: "W-3",
      discoveredReleaseCode: "W-4",
    }),
    (error) => error.code === "BUG_CONTEXT_CONFLICT",
  );
});

test("создание бизнес-требования требует актуальный полный снимок", async () => {
  const root = businessPage({ id: "root", title: "Модуль" });
  const requests = [];
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/business") return businessMetadata();
      if (requestPath === "/data_sources/business/query")
        return { results: [root], has_more: false };
      if (requestPath.startsWith("/blocks/root/children?"))
        return { results: [notionParagraph("description", "Описание")], has_more: false };
      if (requestPath === "/pages") {
        requests.push([requestPath, options]);
        return { object: "page", id: "new-business" };
      }
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  const config = { businessDatabaseId: "business" };
  const snapshot = await inspectBusinessRequirements(client, config);
  await assert.rejects(
    createBusinessRequirement(client, config, {
      title: "Новая часть",
      description: "Новая бизнес-функция.",
      parentId: "root",
      snapshotFingerprint: "stale",
    }),
    (error) => error.code === "BUSINESS_SNAPSHOT_CONFLICT",
  );
  const result = await createBusinessRequirement(client, config, {
    title: "Новая часть",
    description: "Новая бизнес-функция.",
    parentId: "root",
    snapshotFingerprint: snapshot.snapshotFingerprint,
  });
  assert.equal(result.page.id, "new-business");
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].body.icon.type, "emoji");
  assert.ok(PAGE_ICONS.includes(requests[0][1].body.icon.emoji));
});

test("команды бизнес-требований принимают UUID Notion без дефисов", async () => {
  const pageId = "22222222-2222-4222-8222-222222222222";
  const compactPageId = pageId.replaceAll("-", "");
  const root = businessPage({ id: pageId, title: "Процесс" });
  const blocks = [
    notionParagraph("description", "Описание"),
    {
      object: "block",
      id: "divider",
      type: "divider",
      divider: {},
      has_children: false,
    },
    notionParagraph("marker", MASTER_SPEC_MARKER),
    notionParagraph("master", "Старое правило."),
  ];
  const writes = [];
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/business") return businessMetadata();
      if (requestPath === "/data_sources/business/query")
        return { results: [root], has_more: false };
      if (requestPath.startsWith(`/blocks/${pageId}/children?`))
        return { results: blocks, has_more: false };
      if (requestPath === "/blocks/master" && options.method === "DELETE") {
        writes.push([requestPath, options]);
        return {};
      }
      if (requestPath === "/blocks/marker" && options.method === "PATCH") {
        writes.push([requestPath, options]);
        return {};
      }
      if (requestPath === `/blocks/${pageId}/children`) {
        writes.push([requestPath, options]);
        return { results: [] };
      }
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  const config = { businessDatabaseId: "business" };
  const snapshot = await inspectBusinessRequirements(client, config);

  const result = await updateMasterSpecification(
    client,
    config,
    compactPageId,
    {
      markdown: "Новое правило.",
      expectedFingerprint: snapshot.items[0].master.fingerprint,
    },
  );

  assert.equal(result.pageId, pageId);
  assert.ok(writes.some(([requestPath]) => requestPath === "/blocks/master"));
  const markerWrite = writes.find(
    ([requestPath]) => requestPath === "/blocks/marker",
  );
  assert.equal(
    markerWrite[1].body.paragraph.rich_text[0].annotations.bold,
    true,
  );
});

test("создание истории одинаково принимает compact и hyphenated business ID", async () => {
  const businessId = "22222222-2222-4222-8222-222222222222";
  const compactBusinessId = businessId.replaceAll("-", "");
  const epic = page({
    id: "epic",
    title: "Эпик",
    code: "W-1",
    type: "Epic",
    priority: "low",
  });
  epic.properties["Parent item"] = epic.properties.Родитель;
  delete epic.properties.Родитель;
  const business = businessPage({ id: businessId, title: "Процесс" });
  const epicBlocks = buildTaskTemplate({
    type: "Эпик",
    description: "Эпик описывает согласованный продуктовый результат.",
    businessRequirementIds: [businessId],
  }).map((block, index) => ({
    ...block,
    id: `epic-block-${index}`,
    has_children: false,
  }));
  const writes = [];
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query") {
        return { results: [epic], has_more: false };
      }
      if (requestPath === "/data_sources/business") return businessMetadata();
      if (requestPath === "/data_sources/business/query") {
        return { results: [business], has_more: false };
      }
      if (requestPath.startsWith(`/blocks/${businessId}/children?`)) {
        return {
          results: [notionParagraph("business-description", "Описание")],
          has_more: false,
        };
      }
      if (requestPath.startsWith("/blocks/epic/children?")) {
        return { results: epicBlocks, has_more: false };
      }
      if (requestPath === "/pages") {
        writes.push(options.body);
        return {
          object: "page",
          id: `story-${writes.length}`,
          properties: {
            ...options.body.properties,
            ID: { unique_id: { prefix: "W", number: writes.length + 1 } },
          },
        };
      }
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  const base = {
    type: "История",
    description: "История описывает самостоятельный продуктовый результат.",
    parentCode: "W-1",
    priority: "low",
    estimatedCodeLines: 100,
    steps: ["Реализовать результат"],
    expectedResults: ["Результат доступен пользователю"],
    checks: ["Результат проверен через пользовательский путь"],
  };

  await createTaskItem(
    client,
    { databaseId: "backlog", businessDatabaseId: "business" },
    {
      ...base,
      title: "История с compact ID",
      businessRequirementIds: [compactBusinessId],
    },
  );
  await createTaskItem(
    client,
    { databaseId: "backlog", businessDatabaseId: "business" },
    {
      ...base,
      title: "История с UUID",
      businessRequirementIds: [businessId],
    },
  );

  for (const write of writes) {
    const callout = write.children.find((block) => block.type === "callout");
    assert.equal(callout.callout.rich_text[1].mention.page.id, businessId);
  }
});

test("бизнес-требование не содержит код задачи", () => {
  assert.equal(
    assertBusinessRequirementIndependent(
      "Прозрачность процесса разработки",
      "Команда теряет контекст и не видит принятый результат.",
    ),
    true,
  );
  assert.throws(
    () =>
      assertBusinessRequirementIndependent(
        "W-269 · Тестовая бизнес-сущность",
      ),
    (error) => error.code === "BUSINESS_W_LINK_FORBIDDEN",
  );
});

test("история наследует бизнес-область эпика и требует согласования sub-item", () => {
  const hierarchy = {
    parentIdsByPageId: new Map([
      ["business", []],
      ["business-child", ["business"]],
      ["outside", []],
    ]),
  };
  assert.equal(
    assertStoryBusinessScope(["business"], ["business"], hierarchy),
    true,
  );
  assert.throws(
    () =>
      assertStoryBusinessScope(["business"], ["business-child"], hierarchy),
    (error) => error.code === "BUSINESS_SUBITEM_APPROVAL_REQUIRED",
  );
  assert.equal(
    assertStoryBusinessScope(
      ["business"],
      ["business-child"],
      hierarchy,
      { businessSubitemApproved: true },
    ),
    true,
  );
  assert.throws(
    () => assertStoryBusinessScope(["business"], ["outside"], hierarchy),
    (error) => error.code === "BUSINESS_SCOPE_MISMATCH",
  );
});

test("плановая публикация и отдельная приёмка принадлежат истории", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-plan-owner-"));
  await Promise.all([
    writeFile(join(root, ".openspec.yaml"), "schema: spec-driven\n"),
    writeFile(join(root, "proposal.md"), "Task: W-3\n"),
  ]);
  const taskPage = page({ id: "task", title: "Задача", code: "W-3", type: "Task" });
  taskPage.properties["Parent item"] = taskPage.properties.Родитель;
  delete taskPage.properties.Родитель;
  const client = {
    async request(requestPath) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query")
        return { results: [taskPage], has_more: false };
      assert.fail(`Запись недопустима: ${requestPath}`);
    },
  };
  try {
    await assert.rejects(
      publishPlanningTask(client, { databaseId: "backlog" }, "W-3", {
        changePath: root,
      }),
      (error) => error.code === "STORY_OWNER_REQUIRED",
    );
    await assert.rejects(
      verifyStoryReady(client, { databaseId: "backlog" }, "W-3"),
      (error) => error.code === "STORY_OWNER_REQUIRED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("история принимается только с конкретными OpenSpec-dropdown", async () => {
  const storyPage = page({ id: "story", title: "История", code: "W-3", type: "Story" });
  const historyPage = businessPage({ id: "history", title: "История релизов" });
  storyPage.properties["Parent item"] = storyPage.properties.Родитель;
  delete storyPage.properties.Родитель;
  let blocks = [];
  let releaseMode = false;
  const client = {
    async request(requestPath) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query")
        return { results: [storyPage], has_more: false };
      if (requestPath.startsWith("/blocks/story/children?"))
        return {
          results: releaseMode
            ? [...blocks, { id: "incoming-db", type: "child_database", child_database: { title: "Входящие задачи" }, has_children: false }]
            : blocks,
          has_more: false,
        };
      if (requestPath === "/data_sources/business") return businessMetadata();
      if (requestPath === "/data_sources/business/query")
        return { results: [historyPage], has_more: false };
      if (requestPath.startsWith("/blocks/history/children?"))
        return { results: [{ id: "history-db", type: "child_database", child_database: { title: "Релизы" }, has_children: false }], has_more: false };
      if (requestPath === "/views?database_id=incoming-db&page_size=100")
        return { results: [{ id: "incoming-view" }] };
      if (requestPath === "/views?database_id=history-db&page_size=100")
        return { results: [{ id: "history-view" }] };
      if (requestPath === "/views/incoming-view")
        return {
          id: "incoming-view",
          name: "Входящие задачи",
          data_source_id: "backlog",
          filter: { property: "Релиз", relation: { contains: "story" } },
          configuration: { properties: [
            { property_name: "ID", visible: true },
            { property_name: "Задача", visible: true },
            { property_name: "Статус", visible: true },
          ] },
        };
      if (requestPath === "/views/history-view")
        return {
          id: "history-view",
          name: "Релизы",
          data_source_id: "backlog",
          filter: { property: "Дата релиза", date: { is_not_empty: true } },
          sorts: [{ property: "Дата релиза", direction: "descending" }],
          configuration: { properties: [
            { property_name: "Задача", visible: true },
            { property_name: "Дата релиза", visible: true },
          ] },
        };
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  await assert.rejects(
    verifyStoryReady(client, { databaseId: "backlog" }, "W-3"),
    (error) => error.code === "STORY_SPECIFICATION_REQUIRED",
  );
  blocks = [
    notionToggle("proposal", "Предложения"),
    notionToggle("design", "Дизайн архитектуры"),
    notionToggle("tasks", "Задачи"),
    notionToggle("spec", "Спецификация · Контракт истории"),
  ];
  const result = await verifyStoryReady(client, { databaseId: "backlog" }, "W-3");
  assert.equal(result.page.id, "story");

  storyPage.properties["Дата релиза"] = { date: { start: "2026-08-14" } };
  storyPage.properties.Приоритет = { select: null };
  blocks = buildReleaseStoryTemplate({
    releaseDate: "2026-08-14",
    changes: ["Обновлён журнал"],
  });
  releaseMode = true;
  await assert.rejects(
    verifyStoryReady(
      client,
      { databaseId: "backlog", businessDatabaseId: "business" },
      "W-3",
    ),
    (error) => error.code === "RELEASE_TITLE_INVALID",
  );
  storyPage.properties.Задача.title[0].plain_text = "Релиз от 14 августа 2026";
  const releaseResult = await verifyStoryReady(
    client,
    { databaseId: "backlog", businessDatabaseId: "business" },
    "W-3",
  );
  assert.equal(releaseResult.releaseStory, true);
});

test("эпик W-269 не принимает плановую или итоговую OpenSpec-публикацию", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-epic-owner-"));
  const specs = join(root, "specs", "notion");
  await mkdir(specs, { recursive: true });
  await Promise.all([
    writeFile(join(root, ".openspec.yaml"), "schema: spec-driven\n"),
    writeFile(join(root, "proposal.md"), "Task: W-269\n"),
    writeFile(join(specs, "spec.md"), "### Requirement: Процесс W\n"),
  ]);
  const epic = page({
    id: "epic",
    title: "Изменение процесса работы по W",
    code: "W-269",
    type: "Epic",
  });
  epic.properties["Parent item"] = epic.properties.Родитель;
  delete epic.properties.Родитель;
  const client = {
    async request(requestPath) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query") {
        return { results: [epic], has_more: false };
      }
      assert.fail(`Запись недопустима: ${requestPath}`);
    },
  };
  try {
    await assert.rejects(
      publishPlanningTask(client, { databaseId: "backlog" }, "W-269", {
        changePath: root,
      }),
      (error) => error.code === "STORY_OWNER_REQUIRED",
    );
    await assert.rejects(
      releaseTask(client, { databaseId: "backlog" }, "W-269", {
        approved: true,
        specPath: join(specs, "spec.md"),
      }),
      (error) => error.code === "STORY_OWNER_REQUIRED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenSpec принадлежит истории или общему эпику технического долга", () => {
  assert.equal(isOpenSpecOwner("История"), true);
  assert.equal(isOpenSpecOwner("Эпик"), false);
  assert.equal(isOpenSpecOwner("Эпик", { technicalDebt: true }), true);
  assert.equal(
    isOpenSpecOwner("История", { inheritedTechnicalDebt: true }),
    true,
  );
  assert.equal(isOpenSpecOwner("Задача"), false);
  assert.equal(
    assertOpenSpecLinkage(
      [{ label: "proposal.md", markdown: "Task: W-269\n\n## Why" }],
      "W-269",
    ),
    true,
  );
  assert.throws(
    () =>
      assertOpenSpecLinkage(
        [{ label: "proposal.md", markdown: "Task: W-2690" }],
        "W-269",
      ),
    (error) => error.code === "OPENSPEC_LINKAGE_MISMATCH",
  );
  assert.equal(
    assertOpenSpecBusinessLinkage(
      [{
        label: "specs/notion/spec.md",
        markdown: "Business requirements: https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\n## ADDED Requirements",
      }],
      ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    ),
    true,
  );
  assert.throws(
    () => assertOpenSpecBusinessLinkage(
      [{ label: "specs/notion/spec.md", markdown: "## ADDED Requirements" }],
      ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ),
    (error) => error.code === "OPENSPEC_BUSINESS_LINKAGE_MISMATCH",
  );
});

test("история технического долга публикует локальный OpenSpec без бизнес-ссылки", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-tech-story-owner-"));
  const specs = join(root, "specs", "local-stack");
  await mkdir(specs, { recursive: true });
  await Promise.all([
    writeFile(join(root, ".openspec.yaml"), "schema: spec-driven\n"),
    writeFile(join(root, "proposal.md"), "Task: W-300\n\n## Why\n\nЛокальный стек.\n"),
    writeFile(join(root, "design.md"), "## Context\n\nЛокальный дизайн.\n"),
    writeFile(join(root, "tasks.md"), "## 1. Работа\n\n- [ ] 1.1 Выполнить работу\n"),
    writeFile(
      join(specs, "spec.md"),
      "## ADDED Requirements\n\n### Requirement: Локальный контракт\nСистема SHALL хранить локальный контракт.\n\n#### Scenario: Контракт доступен\n- **WHEN** История опубликована\n- **THEN** локальный контракт доступен\n",
    ),
  ]);
  const epic = page({
    id: "tech-epic",
    title: "Разделение технических контуров",
    code: "W-287",
    type: "Epic",
    technicalDebt: true,
  });
  const story = page({
    id: "tech-story",
    title: "Самостоятельный backend-дистрибутив",
    code: "W-300",
    type: "Story",
    parent: ["tech-epic"],
    status: "Аналитика",
  });
  for (const item of [epic, story]) {
    item.properties["Parent item"] = item.properties.Родитель;
    delete item.properties.Родитель;
  }
  const storyBlocks = [];
  let toggleSequence = 0;
  let businessRequests = 0;
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query") {
        return { results: [epic, story], has_more: false };
      }
      if (requestPath.startsWith("/blocks/tech-story/children?")) {
        return { results: storyBlocks, has_more: false };
      }
      if (requestPath === "/blocks/tech-story/children") {
        const toggle = {
          ...options.body.children[0],
          id: `tech-story-toggle-${toggleSequence += 1}`,
          has_children: false,
        };
        storyBlocks.push(toggle);
        return { results: [toggle] };
      }
      if (/^\/blocks\/tech-story-toggle-\d+\/children$/u.test(requestPath)) {
        return { results: [] };
      }
      if (requestPath.includes("business")) businessRequests += 1;
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  try {
    const published = await publishPlanningTask(
      client,
      { databaseId: "backlog", businessDatabaseId: "business" },
      "W-300",
      { changePath: root },
    );
    assert.equal(published.publication.documents, 4);
    const verified = await verifyStoryReady(
      client,
      { databaseId: "backlog", businessDatabaseId: "business" },
      "W-300",
    );
    assert.equal(verified.technicalDebtEpic, true);
    assert.equal(businessRequests, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("История публикует и проверяет несколько repo-local OpenSpec за один запуск", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "task-multi-plan-owner-"));
  const changeRoots = ["identity-service", "catalog-service"].map((repository) =>
    join(workspace, repository, "openspec", "changes", "w-321-integration"),
  );
  for (const [index, root] of changeRoots.entries()) {
    const specs = join(root, "specs", `contract-${index + 1}`);
    await mkdir(specs, { recursive: true });
    await Promise.all([
      writeFile(join(root, ".openspec.yaml"), "schema: spec-driven\n"),
      writeFile(join(root, "proposal.md"), "Task: W-321\n\n## Why\n\nИнтеграция.\n"),
      writeFile(join(root, "design.md"), "## Context\n\nЛокальный дизайн.\n"),
      writeFile(join(root, "tasks.md"), "## 1. Работа\n\n- [ ] 1.1 Выполнить работу\n"),
      writeFile(
        join(specs, "spec.md"),
        `## ADDED Requirements\n\n### Requirement: Контракт ${index + 1}\nСистема SHALL хранить контракт.\n`,
      ),
    ]);
  }
  const epic = page({
    id: "multi-epic",
    title: "Микросервисная архитектура",
    code: "W-287",
    type: "Epic",
    technicalDebt: true,
  });
  const story = page({
    id: "multi-story",
    title: "Интеграция сервисов",
    code: "W-321",
    type: "Story",
    parent: ["multi-epic"],
    status: "Разработка",
  });
  for (const item of [epic, story]) {
    item.properties["Parent item"] = item.properties.Родитель;
    delete item.properties.Родитель;
  }
  const childrenByParent = new Map([["multi-story", []]]);
  let sequence = 0;
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query") {
        return { results: [epic, story], has_more: false };
      }
      const readMatch = requestPath.match(/^\/blocks\/([^/]+)\/children\?/u);
      if (readMatch) {
        return {
          results: childrenByParent.get(readMatch[1]) || [],
          has_more: false,
        };
      }
      const writeMatch = requestPath.match(/^\/blocks\/([^/]+)\/children$/u);
      if (writeMatch && options.method === "PATCH") {
        const parentId = writeMatch[1];
        const created = (options.body.children || []).map((block) => ({
          ...block,
          id: block.id || `multi-toggle-${sequence += 1}`,
          has_children: block.type === "toggle",
        }));
        const current = childrenByParent.get(parentId) || [];
        current.push(...created);
        childrenByParent.set(parentId, current);
        for (const block of created) {
          if (block.type === "toggle" && !childrenByParent.has(block.id)) {
            childrenByParent.set(block.id, []);
          }
        }
        return { results: created };
      }
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  try {
    const published = await publishPlanningTask(
      client,
      { databaseId: "backlog", businessDatabaseId: "business" },
      "W-321",
      { changePaths: changeRoots },
    );
    assert.equal(published.publication.groups, 2);
    assert.deepEqual(
      childrenByParent.get("multi-story").map((item) =>
        item.toggle.rich_text[0].text.content,
      ),
      ["OpenSpec · identity-service", "OpenSpec · catalog-service"],
    );
    const verified = await verifyStoryReady(
      client,
      { databaseId: "backlog", businessDatabaseId: "business" },
      "W-321",
    );
    assert.equal(verified.technicalDebtEpic, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("эпик технического долга не требует бизнес-ссылку и владеет SDD", async () => {
  const localSchema = discoverSchema(backlogMetadata(), {}, { requireTyped: true });
  const pages = [];
  const writes = [];
  const client = {
    async request(requestPath, options = {}) {
      if (requestPath === "/data_sources/backlog") return backlogMetadata();
      if (requestPath === "/data_sources/backlog/query")
        return { results: pages, has_more: false };
      if (requestPath === "/pages") {
        writes.push(options.body);
        const created = {
          object: "page",
          id: "tech-epic",
          properties: {
            ...options.body.properties,
            ID: { unique_id: { prefix: "W", number: 300 } },
          },
        };
        pages.push(created);
        return created;
      }
      assert.fail(`Неожиданный запрос: ${requestPath}`);
    },
  };
  const result = await createTaskItem(
    client,
    { databaseId: "backlog" },
    {
      type: "Эпик",
      title: "Переход архитектурного модуля на новый стек",
      description: "Переработать архитектуру существующего модуля.",
      priority: "high",
      estimatedCodeLines: 5001,
      technicalDebt: true,
    },
  );
  assert.equal(result.type, "Эпик");
  assert.equal(
    writes[0].properties[localSchema.technicalDebtName].checkbox,
    true,
  );
  assert.equal(
    writes[0].children.some((item) => item.type === "callout"),
    false,
  );
});

test("управляемые OpenSpec-блоки удаляются без изменения тела эпика", async () => {
  const calls = [];
  const client = {
    async request(requestPath, options = {}) {
      calls.push([requestPath, options]);
      if (requestPath.startsWith("/blocks/epic/children?")) {
        return {
          results: [
            { id: "body", type: "paragraph" },
            {
              id: "proposal",
              type: "toggle",
              toggle: { rich_text: [{ plain_text: "Предложения" }] },
            },
            {
              id: "spec",
              type: "toggle",
              toggle: {
                rich_text: [{ plain_text: "Спецификация · Процесс W" }],
              },
            },
          ],
          has_more: false,
        };
      }
      return {};
    },
  };
  const result = await removeManagedDocuments(client, "epic");
  assert.deepEqual(result.blockIds, ["proposal", "spec"]);
  assert.equal(result.removed, 2);
  assert.ok(calls.some(([path]) => path === "/blocks/proposal"));
  assert.ok(calls.some(([path]) => path === "/blocks/spec"));
  assert.ok(!calls.some(([path]) => path === "/blocks/body"));
});

test("файл бага загружается только через штатный multipart Notion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-notion-upload-"));
  const path = join(directory, "bug.png");
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const calls = [];
  const client = new NotionClient({
    token: "secret-token",
    retries: 0,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return {
        ok: true,
        status: 200,
        text: async () =>
          url.endsWith("/file_uploads")
            ? JSON.stringify({ id: "upload-id" })
            : JSON.stringify({ status: "uploaded" }),
      };
    },
  });
  try {
    assert.equal(await client.uploadFile(path), "upload-id");
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1].headers["Content-Type"], "application/json");
    assert.equal(calls[1][1].headers["Content-Type"], undefined);
    assert.ok(calls[1][1].body instanceof FormData);
    assert.doesNotMatch(JSON.stringify(calls.map(([url]) => url)), /secret-token/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("неопределённый исход создания страницы и append не повторяет мутацию", async () => {
  for (const [path, method] of [["/pages", "POST"], ["/blocks/example/children", "PATCH"]]) {
    let attempts = 0;
    const client = new NotionClient({ token: "secret-token", retries: 2,
      fetchImpl: async () => { attempts++; throw new Error("connection lost"); } });
    await assert.rejects(client.request(path, { method, body: {} }), { code: "NOTION_WRITE_OUTCOME_UNKNOWN" });
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  const client = new NotionClient({ token: "secret-token", retries: 2,
    fetchImpl: async () => { attempts++; return { ok: false, status: 503, text: async () => "{}" }; } });
  await assert.rejects(client.request("/pages", { method: "POST", body: {} }), { code: "NOTION_HTTP_503" });
  assert.equal(attempts, 1);
});
test("Notion rate limit соблюдает Retry-After перед повтором", async () => {
  const delays = []; let calls = 0;
  const client = new NotionClient({ token: "test", waitImpl: async ms => delays.push(ms),
    fetchImpl: async () => ++calls === 1
      ? new Response(JSON.stringify({ message: "limited" }), { status: 429, headers: { "Retry-After": "4" } })
      : new Response(JSON.stringify({ id: "created" }), { status: 200 }) });
  assert.equal((await client.request("/pages", { method: "POST", body: {} })).id, "created");
  assert.deepEqual(delays, [4000]);
});
