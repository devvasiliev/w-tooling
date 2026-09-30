import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  NotionClient,
  TaskNotionError,
  findTask,
  loadConfig,
  pageParentIds,
  pageTaskType,
} from "./notion-workflow-lib.mjs";

const SUBJECT_PATTERN = /^([A-Z][A-Z0-9]*-[0-9]+):\s+\S.+$/u;
const ITEM_PATTERN = /^- ([A-Z][A-Z0-9]*-[0-9]+)\s+(.+)$/u;
const SUBITEM_PATTERN = /^  - ([A-Z][A-Z0-9]*-[0-9]+)\s+(.+)$/u;

function fail(code, message) {
  throw new TaskNotionError(code, message);
}

export function parseSquashManifest(message) {
  const lines = String(message || "").replaceAll("\r\n", "\n").split("\n");
  const subject = lines.shift() || "";
  const subjectMatch = subject.match(SUBJECT_PATTERN);
  if (!subjectMatch) {
    fail("SQUASH_SUBJECT_INVALID", "Squash subject должен иметь вид CODE-N: Название истории");
  }

  while (lines[0] === "") lines.shift();
  if (lines.shift() !== "Задачи:") {
    fail("SQUASH_TASKS_SECTION_MISSING", "После subject нужен раздел «Задачи:»");
  }

  const tasks = [];
  const bugs = [];
  let currentTask = null;
  let section = "tasks";
  for (const line of lines) {
    if (!line) continue;
    if (line === "Баги:") {
      if (section === "bugs") fail("SQUASH_BUGS_SECTION_DUPLICATED", "Раздел «Баги:» указан дважды");
      section = "bugs";
      currentTask = null;
      continue;
    }
    if (section === "tasks") {
      const taskMatch = line.match(ITEM_PATTERN);
      if (taskMatch) {
        currentTask = { code: taskMatch[1], title: taskMatch[2], subtasks: [] };
        tasks.push(currentTask);
        continue;
      }
      const subtaskMatch = line.match(SUBITEM_PATTERN);
      if (subtaskMatch && currentTask) {
        currentTask.subtasks.push({ code: subtaskMatch[1], title: subtaskMatch[2] });
        continue;
      }
      fail("SQUASH_TASK_LINE_INVALID", `Некорректная строка раздела «Задачи»: ${line}`);
    }
    const bugMatch = line.match(ITEM_PATTERN);
    if (!bugMatch) fail("SQUASH_BUG_LINE_INVALID", `Некорректная строка раздела «Баги»: ${line}`);
    bugs.push({ code: bugMatch[1], title: bugMatch[2] });
  }
  if (!tasks.length) fail("SQUASH_TASKS_EMPTY", "Squash-манифест должен содержать хотя бы одну задачу");

  const allCodes = [
    ...tasks.flatMap((task) => [task.code, ...task.subtasks.map((item) => item.code)]),
    ...bugs.map((bug) => bug.code),
  ];
  const duplicate = allCodes.find((code, index) => allCodes.indexOf(code) !== index);
  if (duplicate) fail("SQUASH_CODE_DUPLICATED", `Код ${duplicate} повторяется в squash-манифесте`);

  return { subject, storyCode: subjectMatch[1], tasks, bugs, allCodes };
}

export function assertSquashSourceCodes(manifest, sourceCodes) {
  const expected = new Set(sourceCodes.map((code) => String(code).toUpperCase()));
  const actual = new Set([
    ...manifest.tasks.map((task) => task.code),
    ...manifest.bugs.map((bug) => bug.code),
  ]);
  const missing = [...expected].filter((code) => !actual.has(code));
  const extra = [...actual].filter((code) => !expected.has(code));
  if (missing.length || extra.length) {
    fail(
      "SQUASH_SOURCE_MISMATCH",
      `Squash-манифест расходится с исходными коммитами: отсутствуют [${missing.join(", ")}], лишние [${extra.join(", ")}]`,
    );
  }
  return true;
}

export async function validateSquashNotion(client, config, manifest) {
  const story = await findTask(client, config, manifest.storyCode);
  if (pageTaskType(story.page, story.schema) !== "История") {
    fail("SQUASH_STORY_TYPE_INVALID", `${manifest.storyCode} должен иметь тип «История»`);
  }
  for (const taskItem of manifest.tasks) {
    const task = await findTask(client, config, taskItem.code);
    if (pageTaskType(task.page, task.schema) !== "Задача") {
      fail("SQUASH_TASK_TYPE_INVALID", `${taskItem.code} должен иметь тип «Задача»`);
    }
    if (!pageParentIds(task.page, task.schema).includes(story.page.id)) {
      fail("SQUASH_TASK_PARENT_INVALID", `${taskItem.code} не принадлежит истории ${manifest.storyCode}`);
    }
    for (const subtaskItem of taskItem.subtasks) {
      const subtask = await findTask(client, config, subtaskItem.code);
      if (pageTaskType(subtask.page, subtask.schema) !== "Подзадача") {
        fail("SQUASH_SUBTASK_TYPE_INVALID", `${subtaskItem.code} должен иметь тип «Подзадача»`);
      }
      if (!pageParentIds(subtask.page, subtask.schema).includes(task.page.id)) {
        fail("SQUASH_SUBTASK_PARENT_INVALID", `${subtaskItem.code} не принадлежит задаче ${taskItem.code}`);
      }
    }
  }
  for (const bugItem of manifest.bugs) {
    const bug = await findTask(client, config, bugItem.code);
    if (pageTaskType(bug.page, bug.schema) !== "Баг") {
      fail("SQUASH_BUG_TYPE_INVALID", `${bugItem.code} должен иметь тип «Баг»`);
    }
  }
  return true;
}

export function sourceCommitCodes(baseRef, { exec = execFileSync } = {}) {
  const subjects = exec("git", ["log", "--format=%s", `${baseRef}..HEAD`], { encoding: "utf8" });
  return [...new Set(subjects.split("\n").map((line) => line.match(/^([A-Z][A-Z0-9]*-[0-9]+):/u)?.[1]).filter(Boolean))];
}

function parseArgs(argv) {
  const result = { messageFile: "", base: "", syntaxOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--syntax-only") result.syntaxOnly = true;
    else if (argument === "--message-file") result.messageFile = argv[++index] || "";
    else if (argument === "--base") result.base = argv[++index] || "";
    else fail("INVALID_ARGUMENT", `Неизвестный аргумент: ${argument}`);
  }
  if (!result.messageFile) fail("INVALID_ARGUMENT", "Нужен --message-file");
  if (!result.syntaxOnly && !result.base) fail("INVALID_ARGUMENT", "Для полной проверки нужен --base");
  return result;
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = parseSquashManifest(await readFile(args.messageFile, "utf8"));
  if (!args.syntaxOnly) {
    const sourceCodes = sourceCommitCodes(args.base);
    assertSquashSourceCodes(manifest, sourceCodes);
    const config = await loadConfig();
    await validateSquashNotion(new NotionClient({ token: config.token }), config, manifest);
  }
  process.stdout.write(`OK: squash-манифест ${manifest.storyCode} прошёл проверку.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run().catch((error) => {
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}
