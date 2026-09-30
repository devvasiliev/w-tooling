import assert from "node:assert/strict";
import test from "node:test";

import { assertSquashSourceCodes, parseSquashManifest } from "./task-squash-manifest.mjs";

const message = `W-390: Обработка заявок

Задачи:
- W-412 Собрать API
  - W-413 Проверить повторный запуск
- W-414 Подключить интерфейс

Баги:
- W-417 Исправить сохранение`;

test("squash-манифест сохраняет задачи, подзадачи и баги", () => {
  const parsed = parseSquashManifest(message);
  assert.equal(parsed.storyCode, "W-390");
  assert.deepEqual(parsed.tasks.map((item) => item.code), ["W-412", "W-414"]);
  assert.deepEqual(parsed.tasks[0].subtasks.map((item) => item.code), ["W-413"]);
  assert.deepEqual(parsed.bugs.map((item) => item.code), ["W-417"]);
  assert.equal(assertSquashSourceCodes(parsed, ["W-412", "W-414", "W-417"]), true);
});

test("squash-манифест отклоняет расхождение с исходными коммитами", () => {
  const parsed = parseSquashManifest(message);
  assert.throws(
    () => assertSquashSourceCodes(parsed, ["W-412", "W-418"]),
    (error) => error.code === "SQUASH_SOURCE_MISMATCH" && /W-418/u.test(error.message),
  );
});

test("squash-манифест требует точную иерархию и уникальные коды", () => {
  assert.throws(
    () => parseSquashManifest("W-390: История\n\n- W-412 Задача"),
    (error) => error.code === "SQUASH_TASKS_SECTION_MISSING",
  );
  assert.throws(
    () => parseSquashManifest("W-390: История\n\nЗадачи:\n- W-412 Задача\nБаги:\n- W-412 Баг"),
    (error) => error.code === "SQUASH_CODE_DUPLICATED",
  );
});
