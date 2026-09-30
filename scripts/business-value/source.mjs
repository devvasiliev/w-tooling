import { fail } from "./errors.mjs";
import {
  blockText,
  buildTaskHierarchySnapshot,
  findTask,
  pageTaskCode,
  pageTaskType,
  pageTitle,
  readBlockTree,
} from "../notion-workflow-lib.mjs";

export const SUPPORTED_TASK_TYPES = new Set(["Эпик", "История", "Баг", "Задача"]);
export const W_CODE_PATTERN = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/u;

const SECTION_TITLE = "Данные для оценки";
const COMMON_FIELDS = [
  "Проблема или текущее состояние",
  "Ожидаемый результат",
  "Затрагиваемая аудитория или процесс",
];
const TYPE_FIELDS = {
  Эпик: ["Пользовательский или бизнес-результат"],
  История: ["Пользовательский или бизнес-результат"],
  Баг: ["Ожидаемое поведение", "Фактическое поведение"],
  Задача: ["Связь с продуктовым эффектом"],
};
const QUESTIONS = {
  "Проблема или текущее состояние": "Какую проблему или текущее состояние должна изменить карточка?",
  "Ожидаемый результат": "Какой проверяемый результат должен появиться после выполнения?",
  "Затрагиваемая аудитория или процесс": "Какая аудитория или внутренний процесс затронуты?",
  "Пользовательский или бизнес-результат": "Какой пользовательский или бизнес-результат ожидается?",
  "Ожидаемое поведение": "Как должно работать поведение без дефекта?",
  "Фактическое поведение": "Как система ведёт себя сейчас?",
  "Связь с продуктовым эффектом": "Как Задача связана с продуктовым эффектом, либо является ли она точной «Технической задачей»?",
};

const normalizeValue = (value) =>
  String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .trim();

export const isMeaningfulValue = (value) => {
  const normalized = normalizeValue(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/[.!?,;:()[\]{}]/gu, "")
    .trim();
  return !new Set(["", "-", "неизвестно", "нет данных", "tbd", "todo", "n/a"]).has(
    normalized,
  );
};

export const validateTaskCode = (value) => {
  const code = String(value ?? "").trim();
  if (!W_CODE_PATTERN.test(code)) {
    fail("INVALID_TASK_CODE", "Ожидается один код вида CODE-N", { valueLength: code.length });
  }
  return code;
};

export function parseEvaluationSection(markdown) {
  const lines = normalizeValue(markdown).split("\n");
  const headingPattern = /^(#{1,6})\s+(.+?)\s*$/u;
  const start = lines.findIndex((line) => {
    const match = line.match(headingPattern);
    return match?.[2] === SECTION_TITLE;
  });
  if (start < 0) return null;
  const rootLevel = lines[start].match(headingPattern)[1].length;
  const fields = {};
  let currentField = "";
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(headingPattern);
    if (heading) {
      const level = heading[1].length;
      if (level <= rootLevel) break;
      currentField = heading[2];
      fields[currentField] ??= [];
      continue;
    }
    if (currentField) fields[currentField].push(line);
  }
  return Object.fromEntries(
    Object.entries(fields).map(([label, valueLines]) => [
      label,
      normalizeValue(valueLines.join("\n")),
    ]),
  );
}

const contextCodes = (items) =>
  [...new Set((items || []).map((item) => item?.taskCode || item).filter(Boolean))]
    .filter((code) => W_CODE_PATTERN.test(code))
    .sort();

export function prepareSource(snapshot) {
  const taskCode = validateTaskCode(snapshot?.taskCode);
  const taskType = normalizeValue(snapshot?.taskType);
  if (!SUPPORTED_TASK_TYPES.has(taskType)) {
    fail("UNSUPPORTED_TASK_TYPE", `Тип «${taskType || "не указан"}» не поддерживается`, {
      taskType,
    });
  }
  const evaluationData = parseEvaluationSection(snapshot.descriptionMarkdown);
  if (!evaluationData) {
    return {
      status: "NEEDS_INPUT",
      modelAllowed: false,
      taskCode,
      taskType,
      evaluationData: {},
      missingFields: [SECTION_TITLE],
      questions: ["Добавь в описание раздел «Данные для оценки» с обязательными подзаголовками."],
      unknownReach: false,
      includedTaskCodes: [taskCode],
      excludedTaskCodes: contextCodes([
        ...(snapshot.descendants || []),
        ...(snapshot.dependencies || []),
      ]),
    };
  }

  const requiredFields = [...COMMON_FIELDS, ...TYPE_FIELDS[taskType]];
  const missingFields = requiredFields.filter(
    (field) => !isMeaningfulValue(evaluationData[field]),
  );
  const unknownReach =
    taskType === "Баг" &&
    Object.hasOwn(evaluationData, "Охват") &&
    !isMeaningfulValue(evaluationData.Охват);
  const status = missingFields.length > 0
    ? "NEEDS_INPUT"
    : unknownReach
      ? "READY_PARTIAL"
      : "READY";

  return {
    status,
    modelAllowed: status !== "NEEDS_INPUT",
    taskCode,
    taskType,
    evaluationData,
    missingFields,
    questions: missingFields.map((field) => QUESTIONS[field]),
    unknownReach,
    includedTaskCodes: [taskCode],
    excludedTaskCodes: contextCodes([
      ...(snapshot.descendants || []),
      ...(snapshot.dependencies || []),
    ]).filter((code) => code !== taskCode),
  };
}

const markdownPrefix = (block, depth) => {
  if (/^heading_[123]$/u.test(block.type)) {
    const sourceLevel = Number(block.type.slice(-1));
    return `${"#".repeat(Math.min(6, sourceLevel + depth))} `;
  }
  if (block.type === "bulleted_list_item") return "- ";
  if (block.type === "numbered_list_item") return "1. ";
  if (block.type === "to_do") return `- [${block.to_do?.checked ? "x" : " "}] `;
  if (block.type === "quote") return "> ";
  if (block.type === "toggle") return `${"#".repeat(Math.min(6, 2 + depth))} `;
  return "";
};

export function blocksToMarkdown(blocks, depth = 0) {
  const lines = [];
  for (const block of blocks || []) {
    const text = blockText(block).trim();
    if (text) {
      const indent = ["bulleted_list_item", "numbered_list_item", "to_do"].includes(
        block.type,
      )
        ? "  ".repeat(depth)
        : "";
      lines.push(`${indent}${markdownPrefix(block, depth)}${text}`);
    }
    if (block.children?.length) {
      const nested = blocksToMarkdown(block.children, depth + 1);
      if (nested) lines.push(nested);
    }
    if (text || block.children?.length) lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export async function readTaskSource(
  client,
  config,
  code,
  {
    findTaskFn = findTask,
    readBlockTreeFn = readBlockTree,
    buildHierarchyFn = buildTaskHierarchySnapshot,
  } = {},
) {
  const taskCode = validateTaskCode(code);
  const selected = await findTaskFn(client, config, taskCode);
  const taskType = pageTaskType(selected.page, selected.schema);
  if (!SUPPORTED_TASK_TYPES.has(taskType)) {
    fail("UNSUPPORTED_TASK_TYPE", `Тип «${taskType || "не указан"}» не поддерживается`, {
      taskType,
    });
  }
  const blocks = await readBlockTreeFn(client, selected.page.id);
  const hierarchy = buildHierarchyFn(selected.pages, selected.schema);
  const descendants = (hierarchy.directChildrenByParentId.get(selected.page.id) || [])
    .map((page) => pageTaskCode(page, selected.schema.idName))
    .filter(Boolean);
  const source = {
    taskCode,
    taskType,
    title: pageTitle(selected.page, selected.schema.titleName),
    descriptionMarkdown: blocksToMarkdown(blocks),
    descriptionBlocks: blocks,
    properties: selected.page.properties || {},
    descendants,
    dependencies: [],
  };
  return {
    source,
    preflight: prepareSource(source),
    pageId: selected.page.id,
    sourceId: selected.source?.id || "",
    schema: selected.schema,
  };
}
