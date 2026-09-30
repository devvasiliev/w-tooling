import assert from "node:assert/strict";
import test from "node:test";

import { buildSignificantFingerprint } from "./business-value/fingerprint.mjs";
import { buildManagedToggle } from "./business-value/managed-section.mjs";
import {
  blocksToMarkdown,
  prepareSource,
  readTaskSource,
  validateTaskCode,
} from "./business-value/source.mjs";

const description = (extra = "") => `
## Данные для оценки

### Проблема или текущее состояние
Пользователь теряет результат после возврата.

### Ожидаемый результат
Результат сохраняется между сессиями.

### Затрагиваемая аудитория или процесс
Сотрудники, обрабатывающие заявки.

${extra}`;

const richBlock = (type, text, children = []) => ({
  id: `${type}-${text}`,
  type,
  [type]: { rich_text: [{ plain_text: text }] },
  children,
});

test("preflight детерминированно проверяет type-specific поля", () => {
  const story = prepareSource({
    taskCode: "W-900100",
    taskType: "История",
    descriptionMarkdown: description(`### Пользовательский или бизнес-результат
Увеличить возврат к незавершённой работе.`),
  });
  assert.equal(story.status, "READY");
  assert.equal(story.modelAllowed, true);

  const missingStory = prepareSource({
    taskCode: "W-900101",
    taskType: "История",
    descriptionMarkdown: description(`### Пользовательский или бизнес-результат
неизвестно`),
  });
  assert.equal(missingStory.status, "NEEDS_INPUT");
  assert.deepEqual(missingStory.missingFields, ["Пользовательский или бизнес-результат"]);

  const technicalTask = prepareSource({
    taskCode: "W-900102",
    taskType: "Задача",
    descriptionMarkdown: description(`### Связь с продуктовым эффектом
Техническая задача`),
  });
  assert.equal(technicalTask.status, "READY");

  const bug = prepareSource({
    taskCode: "W-900103",
    taskType: "Баг",
    descriptionMarkdown: description(`### Ожидаемое поведение
Остаток обновлён.

### Фактическое поведение
Остаток устарел.

### Охват
неизвестно`),
  });
  assert.equal(bug.status, "READY_PARTIAL");
  assert.equal(bug.unknownReach, true);
});

test("каждое обязательное поле со значением «неизвестно» даёт тот же typed preflight", () => {
  const fieldsByType = {
    Эпик: ["Пользовательский или бизнес-результат"],
    История: ["Пользовательский или бизнес-результат"],
    Баг: ["Ожидаемое поведение", "Фактическое поведение"],
    Задача: ["Связь с продуктовым эффектом"],
  };
  const common = [
    "Проблема или текущее состояние",
    "Ожидаемый результат",
    "Затрагиваемая аудитория или процесс",
  ];
  let code = 900400;
  for (const [taskType, specific] of Object.entries(fieldsByType)) {
    const allFields = [...common, ...specific];
    for (const unknownField of allFields) {
      const body = ["## Данные для оценки"];
      for (const field of allFields) {
        body.push(`### ${field}`, field === unknownField ? "неизвестно" : "Содержательное значение.");
      }
      const result = prepareSource({
        taskCode: `W-${code}`,
        taskType,
        descriptionMarkdown: body.join("\n\n"),
      });
      code += 1;
      assert.equal(result.status, "NEEDS_INPUT");
      assert.deepEqual(result.missingFields, [unknownField]);
      assert.equal(result.questions.length, 1);
    }
  }
});

test("пустой раздел останавливает модель, а контекст исключается из суммы", () => {
  const result = prepareSource({
    taskCode: "W-900104",
    taskType: "Эпик",
    descriptionMarkdown: "Обычное описание",
    descendants: ["W-900105"],
    dependencies: [{ taskCode: "W-900106" }],
  });
  assert.equal(result.status, "NEEDS_INPUT");
  assert.equal(result.modelAllowed, false);
  assert.deepEqual(result.includedTaskCodes, ["W-900104"]);
  assert.deepEqual(result.excludedTaskCodes, ["W-900105", "W-900106"]);
});

test("W ввод и тип fail-closed", () => {
  assert.throws(
    () => validateTaskCode("W-10; whoami"),
    (error) => error.code === "INVALID_TASK_CODE",
  );
  assert.throws(
    () => prepareSource({ taskCode: "W-10", taskType: "Подзадача" }),
    (error) => error.code === "UNSUPPORTED_TASK_TYPE",
  );
});

test("fingerprint игнорирует lifecycle и managed BV, но замечает смысловой edit", () => {
  const managed = buildManagedToggle({
    runId: "123e4567-e89b-42d3-a456-426614174000",
    markdown: "Старый управляемый текст",
  });
  managed.children = managed.toggle.children;
  const base = {
    taskCode: "W-900107",
    taskType: "История",
    title: "Сохранение прогресса",
    descriptionMarkdown: description(`### Пользовательский или бизнес-результат
Повысить D30 retention.`),
    descriptionBlocks: [richBlock("paragraph", "Повысить D30 retention."), managed],
    properties: { Статус: "Дизайн", Приоритет: "Высокий", Команда: "Team A" },
  };
  const lifecycleEdit = {
    ...base,
    descriptionBlocks: structuredClone(base.descriptionBlocks),
    properties: { ...base.properties, Статус: "Разработка", Приоритет: "Низкий" },
  };
  lifecycleEdit.descriptionBlocks[1].children[1].paragraph.rich_text[0].text.content =
    "Новый управляемый текст";
  lifecycleEdit.descriptionBlocks[1].children[1].paragraph.rich_text[0].plain_text =
    "Новый управляемый текст";
  assert.equal(
    buildSignificantFingerprint(base),
    buildSignificantFingerprint(lifecycleEdit),
  );
  assert.notEqual(
    buildSignificantFingerprint(base),
    buildSignificantFingerprint({
      ...base,
      descriptionBlocks: [richBlock("paragraph", "Повысить регистрации."), managed],
    }),
  );
});

test("fingerprint игнорирует временный managed BV раздел текущего run", () => {
  const base = {
    taskCode: "W-900107",
    taskType: "История",
    title: "Сохранение прогресса",
    descriptionMarkdown: description(`### Пользовательский или бизнес-результат
Повысить D30 retention.`),
    descriptionBlocks: [richBlock("paragraph", "Повысить D30 retention.")],
    properties: { Команда: "Team A" },
  };
  const temporary = buildManagedToggle({
    runId: "123e4567-e89b-42d3-a456-426614174000",
    markdown: "Временный управляемый текст",
    temporary: true,
  });
  temporary.children = temporary.toggle.children;
  const withTemporarySection = {
    ...base,
    descriptionBlocks: [...base.descriptionBlocks, temporary],
  };
  assert.equal(
    buildSignificantFingerprint(base),
    buildSignificantFingerprint(withTemporarySection),
  );
});

test("пользовательский heading Бизнес-эффект остаётся значимым без marker", () => {
  const base = {
    taskCode: "W-900107",
    taskType: "История",
    title: "Сохранение прогресса",
    descriptionMarkdown: "",
    descriptionBlocks: [
      richBlock("heading_2", "Бизнес-эффект"),
      richBlock("paragraph", "Пользовательская гипотеза один."),
    ],
    properties: { Команда: "Team A" },
  };
  const edited = {
    ...base,
    descriptionBlocks: [
      richBlock("heading_2", "Бизнес-эффект"),
      richBlock("paragraph", "Пользовательская гипотеза два."),
    ],
  };
  assert.notEqual(
    buildSignificantFingerprint(base),
    buildSignificantFingerprint(edited),
  );
});

test("Notion source reader читает ровно одну карточку и превращает headings в contract", async () => {
  const blocks = [
    richBlock("heading_2", "Данные для оценки"),
    richBlock("heading_3", "Проблема или текущее состояние"),
    richBlock("paragraph", "Пользователь теряет контекст."),
    richBlock("heading_3", "Ожидаемый результат"),
    richBlock("paragraph", "Контекст сохраняется."),
    richBlock("heading_3", "Затрагиваемая аудитория или процесс"),
    richBlock("paragraph", "Сотрудники службы поддержки."),
    richBlock("heading_3", "Пользовательский или бизнес-результат"),
    richBlock("paragraph", "Пользователь возвращается к работе."),
  ];
  assert.match(blocksToMarkdown(blocks), /## Данные для оценки/u);
  const page = {
    id: "page-1",
    properties: {
      ID: { unique_id: { prefix: "W", number: 900108 } },
      Тип: { select: { name: "История" } },
      Название: { title: [{ plain_text: "Возврат к работе" }] },
      Parent: { relation: [] },
    },
  };
  const child = {
    id: "page-2",
    properties: {
      ID: { unique_id: { prefix: "W", number: 900109 } },
      Тип: { select: { name: "Задача" } },
      Название: { title: [{ plain_text: "Хранение" }] },
      Parent: { relation: [{ id: "page-1" }] },
    },
  };
  const schema = {
    idName: "ID",
    typeName: "Тип",
    typeType: "select",
    titleName: "Название",
    parentName: "Parent",
  };
  const result = await readTaskSource({}, {}, "W-900108", {
    findTaskFn: async () => ({ page, pages: [page, child], schema, source: { id: "source-1" } }),
    readBlockTreeFn: async () => blocks,
  });
  assert.equal(result.preflight.status, "READY");
  assert.deepEqual(result.preflight.excludedTaskCodes, ["W-900109"]);
  assert.equal(result.source.title, "Возврат к работе");
});

test("toggle Данные для оценки сохраняет иерархию подзаголовков", () => {
  const toggle = richBlock("toggle", "Данные для оценки", [
    richBlock("heading_3", "Проблема или текущее состояние"),
    richBlock("paragraph", "Проблема описана."),
    richBlock("heading_3", "Ожидаемый результат"),
    richBlock("paragraph", "Результат описан."),
    richBlock("heading_3", "Затрагиваемая аудитория или процесс"),
    richBlock("paragraph", "Аудитория описана."),
    richBlock("heading_3", "Связь с продуктовым эффектом"),
    richBlock("paragraph", "Техническая задача"),
  ]);
  const markdown = blocksToMarkdown([toggle]);
  assert.match(markdown, /^## Данные для оценки/mu);
  assert.match(markdown, /^#### Проблема или текущее состояние/mu);
  assert.equal(
    prepareSource({
      taskCode: "W-900600",
      taskType: "Задача",
      descriptionMarkdown: markdown,
    }).status,
    "READY",
  );
});
