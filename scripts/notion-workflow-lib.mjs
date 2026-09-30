import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

export const STATUS_FLOW = Object.freeze([
  "Идея",
  "Бэклог",
  "Аналитика",
  "Дизайн",
  "Разработка",
  "Тестирование",
  "Ожидание релиза",
  "Закрыто",
]);
export const ALLOWED_STATUSES = Object.freeze(STATUS_FLOW.slice(2, 7));
export const TASK_TYPES = Object.freeze([
  "Эпик",
  "История",
  "Задача",
  "Подзадача",
  "Баг",
]);
export const PRIORITIES = Object.freeze(["critical", "high", "medium", "low"]);
export const RELEASE_PROCESS_V1 = "v1";
export const SIZES = Object.freeze([
  "Маленький",
  "Обычный",
  "Крупный",
  "Огромный",
]);
export const TASK_TYPE_STORAGE = Object.freeze({
  Эпик: ["Эпик", "Epic"],
  История: ["История", "Story"],
  Задача: ["Задача", "Task"],
  Подзадача: ["Подзадача", "Subtask", "Sub-task"],
  Баг: ["Баг", "Bug"],
});
export const SIZE_STORAGE = Object.freeze({
  Маленький: ["Маленький", "Small"],
  Обычный: ["Обычный", "Normal"],
  Крупный: ["Крупный", "Large"],
  Огромный: ["Огромный", "Huge"],
});
export const ALLOWED_CHILD_TYPES = Object.freeze({
  root: Object.freeze(["Эпик", "Баг"]),
  Эпик: Object.freeze(["История", "Баг"]),
  История: Object.freeze(["Задача", "Баг"]),
  Задача: Object.freeze(["Подзадача", "Баг"]),
  Подзадача: Object.freeze(["Баг"]),
  Баг: Object.freeze([]),
});
export const MANAGED_SPEC_PREFIX = "Спецификация реализации · ";
export const OPEN_SPEC_GROUP_PREFIX = "OpenSpec · ";
export const MASTER_SPEC_MARKER = "Мастер-спецификация";
export const CALLOUT_ICON = "🫧";
export const PAGE_ICONS = Object.freeze([
  "🧭",
  "🧩",
  "🛠️",
  "📌",
  "🗂️",
  "🧪",
  "🔎",
  "⚙️",
  "📝",
  "🚀",
  "💡",
  "🎯",
]);
export const DEFAULT_CONFIG_PATH = resolve(homedir(), ".config/w/notion.env");
export const NOTION_API_VERSION = "2026-03-11";

export class TaskNotionError extends Error {
  constructor(code, message, { external = false, cause } = {}) {
    super(message, { cause });
    this.name = "TaskNotionError";
    this.code = code;
    this.external = external;
  }
}

function parseEnv(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export async function loadConfig({
  env = process.env,
  configPath = DEFAULT_CONFIG_PATH,
  requireBusiness = false,
} = {}) {
  let fileValues = {};
  let fileMode = null;
  try {
    const [content, info] = await Promise.all([
      readFile(configPath, "utf8"),
      stat(configPath),
    ]);
    fileValues = parseEnv(content);
    fileMode = info.mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new TaskNotionError(
        "CONFIG_READ_FAILED",
        `Не удалось прочитать ${configPath}`,
        {
          external: true,
          cause: error,
        },
      );
    }
  }

  const value = (key) => env[key] || fileValues[key] || "";
  const token = value("NOTION_TOKEN");
  const databaseId = normalizeNotionId(value("NOTION_BACKLOG_DATABASE_ID"));
  const businessDatabaseId = normalizeNotionId(
    value("NOTION_BUSINESS_REQUIREMENTS_DATABASE_ID"),
  );
  const missing = [];
  if (!token) missing.push("NOTION_TOKEN");
  if (!databaseId) missing.push("NOTION_BACKLOG_DATABASE_ID");
  if (requireBusiness && !businessDatabaseId)
    missing.push("NOTION_BUSINESS_REQUIREMENTS_DATABASE_ID");
  if (missing.length) {
    throw new TaskNotionError(
      "CONFIG_MISSING",
      `Не заданы параметры Notion: ${missing.join(", ")}. Проверь ${configPath}`,
      { external: true },
    );
  }

  return {
    token,
    databaseId,
    businessDatabaseId,
    statusProperty: value("NOTION_STATUS_PROPERTY") || "",
    parentProperty: value("NOTION_PARENT_PROPERTY") || "",
    typeProperty: value("NOTION_TYPE_PROPERTY") || "",
    priorityProperty: value("NOTION_PRIORITY_PROPERTY") || "",
    sizeProperty: value("NOTION_SIZE_PROPERTY") || "",
    technicalDebtProperty: value("NOTION_TECHNICAL_DEBT_PROPERTY") || "",
    releaseDateProperty: value("NOTION_RELEASE_DATE_PROPERTY") || "",
    releaseProperty: value("NOTION_RELEASE_PROPERTY") || "",
    releaseBugProperty: value("NOTION_RELEASE_BUG_PROPERTY") || "",
    incomingReleaseTasksProperty:
      value("NOTION_INCOMING_RELEASE_TASKS_PROPERTY") || "",
    releaseProcessProperty:
      value("NOTION_RELEASE_PROCESS_PROPERTY") || "",
    businessParentProperty:
      value("NOTION_BUSINESS_PARENT_PROPERTY") || "",
    configPath,
    insecureFileMode: fileMode !== null && (fileMode & 0o077) !== 0,
  };
}

export function normalizeNotionId(value) {
  if (!value) return "";
  const match = String(value).match(
    /[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu,
  );
  return match ? match[0].replaceAll("-", "").toLowerCase() : String(value).trim();
}

function resolvePageId(pagesById, value) {
  const normalized = normalizeNotionId(value);
  for (const pageId of pagesById.keys()) {
    if (normalizeNotionId(pageId) === normalized) return pageId;
  }
  return "";
}

export function redactSecret(value, token = "") {
  let result = String(value ?? "").replace(
    /Bearer\s+[^\s"']+/giu,
    "Bearer [REDACTED]",
  );
  if (token) result = result.split(token).join("[REDACTED]");
  return result;
}

const wait = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export class NotionClient {
  constructor({
    token,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30000,
    retries = 2,
    waitImpl = wait,
  } = {}) {
    if (!token)
      throw new TaskNotionError("CONFIG_MISSING", "Не задан NOTION_TOKEN");
    if (typeof fetchImpl !== "function") {
      throw new TaskNotionError(
        "FETCH_UNAVAILABLE",
        "В текущем Node.js недоступен fetch",
      );
    }
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.waitImpl = waitImpl;
  }

  async request(path, { method = "GET", body, formData } = {}) {
    const url = `https://api.notion.com/v1${path}`;
    // Повтор создания страницы или добавления блоков после потери ответа может
    // создать дубль. Такие операции возобновляет вызывающий код после read-back.
    const retrySafe = method === "GET" || method === "DELETE" ||
      (method === "PATCH" && !path.endsWith("/children")) ||
      (method === "POST" && (/^\/(?:data_sources|databases)\/[^/]+\/query$/u.test(path) || path === "/search"));
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_API_VERSION,
        };
        if (!formData) headers["Content-Type"] = "application/json";
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: formData || (body === undefined ? undefined : JSON.stringify(body)),
          signal: controller.signal,
        });
        const text = await response.text();
        let payload = {};
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = { message: "Notion вернул ответ в неизвестном формате" };
          }
        }
        if (response.ok) return payload;

        const retryable = response.status === 429 || (retrySafe && response.status >= 500);
        if (retryable && attempt < this.retries) {
          const retryAfter = response.headers?.get?.("retry-after");
          const delay = response.status === 429
            ? Math.max(1000, /^\d+(?:\.\d+)?$/u.test(retryAfter || "") ? Number(retryAfter) * 1000 : Date.parse(retryAfter || "") - Date.now() || 1000)
            : 150 * 2 ** attempt;
          clearTimeout(timeout);
          await this.waitImpl(delay);
          continue;
        }
        throw new TaskNotionError(
          `NOTION_HTTP_${response.status}`,
          redactSecret(
            payload?.message || `Notion вернул HTTP ${response.status}`,
            this.token,
          ),
          { external: true },
        );
      } catch (error) {
        if (error instanceof TaskNotionError) throw error;
        if (retrySafe && attempt < this.retries) {
          await this.waitImpl(150 * 2 ** attempt);
          continue;
        }
        const timedOut = error?.name === "AbortError";
        throw new TaskNotionError(
          !retrySafe ? "NOTION_WRITE_OUTCOME_UNKNOWN" : timedOut ? "NOTION_TIMEOUT" : "NOTION_NETWORK_ERROR",
          !retrySafe
            ? `Ответ на запись Notion потерян: ${method} ${path}. Проверь созданный объект перед повтором.`
            : timedOut
              ? `Notion не ответил вовремя: ${method} ${path}`
              : `Не удалось подключиться к Notion: ${method} ${path}`,
          { external: true, cause: error },
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new TaskNotionError(
      "NOTION_REQUEST_FAILED",
      "Запрос Notion не выполнен",
      {
        external: true,
      },
    );
  }

  async uploadFile(path) {
    const fileName = basename(path);
    const mimeType = mimeTypeForPath(path);
    const content = await readFile(path);
    const created = await this.request("/file_uploads", {
      method: "POST",
      body: {
        mode: "single_part",
        filename: fileName,
        content_type: mimeType,
      },
    });
    if (!created?.id) {
      throw new TaskNotionError(
        "FILE_UPLOAD_CREATE_FAILED",
        "Notion не вернул ID загрузки файла",
        { external: true },
      );
    }
    const formData = new FormData();
    formData.set("file", new Blob([content], { type: mimeType }), fileName);
    await this.request(`/file_uploads/${created.id}/send`, {
      method: "POST",
      formData,
    });
    return created.id;
  }
}

function mimeTypeForPath(path) {
  const extension = extname(path).toLowerCase();
  return (
    {
      ".gif": "image/gif",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    }[extension] || "application/octet-stream"
  );
}

export async function resolveDataSource(client, configuredId) {
  try {
    const source = await client.request(`/data_sources/${configuredId}`);
    if (source?.object === "data_source" || source?.properties) {
      return { id: source.id || configuredId, metadata: source };
    }
  } catch (error) {
    if (!(error instanceof TaskNotionError) || error.code !== "NOTION_HTTP_404")
      throw error;
  }

  const database = await client.request(`/databases/${configuredId}`);
  const sources = database?.data_sources || [];
  if (sources.length !== 1) {
    throw new TaskNotionError(
      "DATA_SOURCE_AMBIGUOUS",
      `У базы Notion найдено источников данных: ${sources.length}. Укажи ID data source`,
      { external: true },
    );
  }
  const source = await client.request(`/data_sources/${sources[0].id}`);
  return { id: source.id, metadata: source };
}

function propertyByName(properties, configuredName, acceptedTypes) {
  if (configuredName) {
    const property = properties?.[configuredName];
    if (!property || !acceptedTypes.includes(property.type)) {
      throw new TaskNotionError(
        "SCHEMA_PROPERTY_INVALID",
        `Свойство «${configuredName}» отсутствует или имеет неподходящий тип`,
        { external: true },
      );
    }
    return [configuredName, property];
  }
  const candidates = Object.entries(properties || {}).filter(([, property]) =>
    acceptedTypes.includes(property.type),
  );
  if (candidates.length !== 1) {
    throw new TaskNotionError(
      "SCHEMA_PROPERTY_AMBIGUOUS",
      `Ожидалось одно свойство типа ${acceptedTypes.join("/")}, найдено ${candidates.length}`,
      { external: true },
    );
  }
  return candidates[0];
}

function namedProperty(
  properties,
  configuredName,
  conventionalNames,
  acceptedTypes,
  { required = true } = {},
) {
  if (configuredName)
    return propertyByName(properties, configuredName, acceptedTypes);
  const conventionalName = conventionalNames.find((name) =>
    acceptedTypes.includes(properties?.[name]?.type),
  );
  if (conventionalName)
    return [conventionalName, properties[conventionalName]];
  if (!required) return ["", null];
  return propertyByName(properties, "", acceptedTypes);
}

function selectOptions(property) {
  return (property?.select?.options || []).map((option) => option.name);
}

export function discoverSchema(
  metadata,
  config = {},
  { requireTyped = false } = {},
) {
  const properties = metadata?.properties || {};
  const [titleName] = propertyByName(properties, "", ["title"]);
  const [idName] = propertyByName(properties, "", ["unique_id"]);
  const [statusName, statusProperty] = namedProperty(
    properties,
    config.statusProperty,
    ["Статус", "Status"],
    ["status", "select"],
  );

  let parentName = "";
  if (config.parentProperty) {
    [parentName] = propertyByName(properties, config.parentProperty, [
      "relation",
    ]);
  } else {
    const commonNames = [
      "Parent item",
      "Родительский элемент",
      "Родитель",
      "Parent",
    ];
    parentName =
      commonNames.find((name) => properties[name]?.type === "relation") || "";
    if (!parentName) {
      const relationCandidates = Object.entries(properties).filter(
        ([name, property]) =>
          property.type === "relation" && /parent|родител/iu.test(name),
      );
      if (relationCandidates.length === 1)
        parentName = relationCandidates[0][0];
    }
  }
  if (!parentName) {
    throw new TaskNotionError(
      "PARENT_PROPERTY_NOT_FOUND",
      "Не удалось определить свойство родителя sub-item. Задай NOTION_PARENT_PROPERTY",
      { external: true },
    );
  }

  const options =
    statusProperty.type === "status"
      ? statusProperty.status?.options || []
      : statusProperty.select?.options || [];
  const statusOptions = options.map((option) => option.name);
  const missingStatuses = STATUS_FLOW.filter(
    (name) => !statusOptions.includes(name),
  );

  const [typeName, typeProperty] = namedProperty(
    properties,
    config.typeProperty,
    ["Тип", "Type"],
    ["select"],
    { required: requireTyped },
  );
  const [priorityName, priorityProperty] = namedProperty(
    properties,
    config.priorityProperty,
    ["Приоритет", "Priority"],
    ["select"],
    { required: requireTyped },
  );
  const [sizeName, sizeProperty] = namedProperty(
    properties,
    config.sizeProperty,
    ["Размер", "Size"],
    ["select"],
    { required: requireTyped },
  );
  const [technicalDebtName] = namedProperty(
    properties,
    config.technicalDebtProperty,
    ["Технический долг", "Technical debt"],
    ["checkbox"],
    { required: requireTyped },
  );
  const [releaseDateName] = namedProperty(
    properties,
    config.releaseDateProperty,
    ["Дата релиза", "Release date"],
    ["date"],
    { required: requireTyped },
  );
  const [releaseName] = namedProperty(
    properties,
    config.releaseProperty,
    ["Релиз", "Release"],
    ["relation"],
    { required: requireTyped },
  );
  const [releaseBugName] = namedProperty(
    properties,
    config.releaseBugProperty,
    ["Баг релиза", "Release bug"],
    ["relation"],
    { required: requireTyped },
  );
  const [incomingReleaseTasksName] = namedProperty(
    properties,
    config.incomingReleaseTasksProperty,
    ["Входящие задачи", "Incoming tasks"],
    ["relation"],
    { required: requireTyped },
  );
  const [releaseProcessName, releaseProcessProperty] = namedProperty(
    properties,
    config.releaseProcessProperty,
    ["Релиз-процесс", "Release process"],
    ["select"],
    { required: requireTyped },
  );
  const typeOptions = selectOptions(typeProperty);
  const priorityOptions = selectOptions(priorityProperty);
  const sizeOptions = selectOptions(sizeProperty);
  const releaseProcessOptions = selectOptions(releaseProcessProperty);
  const missingTaskTypes = requireTyped
    ? TASK_TYPES.filter(
        (type) =>
          !TASK_TYPE_STORAGE[type].some((option) => typeOptions.includes(option)),
      )
    : [];
  const missingPriorities = requireTyped
    ? PRIORITIES.filter(
        (priority) =>
          !priorityOptions.some(
            (option) => option.toLowerCase() === priority.toLowerCase(),
          ),
      )
    : [];
  const missingSizes = requireTyped
    ? SIZES.filter(
        (size) =>
          !SIZE_STORAGE[size].some((option) => sizeOptions.includes(option)),
      )
    : [];
  const missingReleaseProcesses =
    requireTyped && !releaseProcessOptions.includes(RELEASE_PROCESS_V1)
      ? [RELEASE_PROCESS_V1]
      : [];

  return {
    titleName,
    idName,
    statusName,
    statusType: statusProperty.type,
    parentName,
    typeName,
    priorityName,
    sizeName,
    technicalDebtName,
    releaseDateName,
    releaseName,
    releaseBugName,
    incomingReleaseTasksName,
    releaseProcessName,
    typeOptions,
    priorityOptions,
    sizeOptions,
    releaseProcessOptions,
    missingTaskTypes,
    missingPriorities,
    missingSizes,
    missingReleaseProcesses,
    statusOptions,
    missingStatuses,
  };
}

export function discoverBusinessSchema(metadata, config = {}) {
  const properties = metadata?.properties || {};
  const [titleName] = propertyByName(properties, "", ["title"]);
  const [parentName] = namedProperty(
    properties,
    config.businessParentProperty,
    ["Parent item", "Родительский элемент", "Родитель", "Parent"],
    ["relation"],
  );
  const subItemName = ["Sub-item", "Дочерний элемент", "Подэлементы"].find(
    (name) => properties[name]?.type === "relation",
  );
  if (!subItemName) {
    throw new TaskNotionError(
      "SUB_ITEM_PROPERTY_NOT_FOUND",
      "Не удалось определить свойство дочерних бизнес-требований",
      { external: true },
    );
  }
  return { titleName, parentName, subItemName };
}

export async function inspectBacklogWorkspace(
  client,
  config,
  { requireTyped = false } = {},
) {
  const source = await resolveDataSource(client, config.databaseId);
  const schema = discoverSchema(source.metadata, config, { requireTyped });
  if (schema.missingStatuses.length) {
    throw new TaskNotionError(
      "STATUSES_MISSING",
      `В Notion отсутствуют статусы: ${schema.missingStatuses.join(", ")}`,
      { external: true },
    );
  }
  const missingOptions = [
    ...schema.missingTaskTypes.map((value) => `Тип:${value}`),
    ...schema.missingPriorities.map((value) => `Приоритет:${value}`),
    ...schema.missingSizes.map((value) => `Размер:${value}`),
    ...schema.missingReleaseProcesses.map(
      (value) => `Релиз-процесс:${value}`,
    ),
  ];
  if (missingOptions.length) {
    throw new TaskNotionError(
      "SCHEMA_OPTIONS_MISSING",
      `В Notion отсутствуют значения свойств: ${missingOptions.join(", ")}`,
      { external: true },
    );
  }
  return { source, schema };
}

export async function inspectWorkspace(client, config) {
  const backlog = await inspectBacklogWorkspace(client, config, {
    requireTyped: true,
  });
  if (!config.businessDatabaseId) {
    throw new TaskNotionError(
      "CONFIG_MISSING",
      "Не задан параметр Notion: NOTION_BUSINESS_REQUIREMENTS_DATABASE_ID",
      { external: true },
    );
  }
  const businessSource = await resolveDataSource(
    client,
    config.businessDatabaseId,
  );
  const businessSchema = discoverBusinessSchema(
    businessSource.metadata,
    config,
  );
  return {
    ...backlog,
    businessSource,
    businessSchema,
  };
}

export async function queryAllPages(client, sourceId) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const result = await client.request(`/data_sources/${sourceId}/query`, {
      method: "POST",
      body,
    });
    pages.push(
      ...(result.results || []).filter((item) => item.object === "page"),
    );
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function blockRichText(item) {
  return item?.[item?.type]?.rich_text || [];
}

export function blockText(item) {
  return richTextValue(blockRichText(item));
}

export function blockPageMentions(item) {
  return blockRichText(item)
    .filter(
      (value) =>
        value?.type === "mention" && value?.mention?.type === "page",
    )
    .map((value) => value.mention.page?.id)
    .filter(Boolean);
}

export async function readBlockTree(client, blockId) {
  const blocks = await listAllChildren(client, blockId);
  const result = [];
  for (const item of blocks) {
    const children = item.has_children
      ? await readBlockTree(client, item.id)
      : [];
    result.push({ ...item, children });
  }
  return result;
}

function normalizedRichText(value) {
  return {
    type: value?.type || "",
    text: value?.plain_text ?? value?.text?.content ?? "",
    link: value?.href ?? value?.text?.link?.url ?? "",
    mention:
      value?.type === "mention" && value?.mention?.type === "page"
        ? value.mention.page?.id || ""
        : "",
    annotations: value?.annotations || {},
  };
}

function normalizedBlock(blockValue) {
  return {
    type: blockValue.type,
    text: blockText(blockValue),
    mentions: blockPageMentions(blockValue),
    richText: blockRichText(blockValue).map(normalizedRichText),
    icon:
      blockValue?.[blockValue.type]?.icon?.type === "emoji"
        ? blockValue[blockValue.type].icon.emoji
        : "",
    checked:
      blockValue.type === "to_do" ? Boolean(blockValue.to_do?.checked) : null,
    children: (blockValue.children || []).map(normalizedBlock),
  };
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function masterSection(blocks) {
  const markers = blocks
    .map((item, index) =>
      item.type === "paragraph" && blockText(item).trim() === MASTER_SPEC_MARKER
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  if (markers.length > 1) {
    throw new TaskNotionError(
      "MASTER_MARKER_AMBIGUOUS",
      `Найдено несколько разделов «${MASTER_SPEC_MARKER}»`,
      { external: true },
    );
  }
  const markerIndex = markers[0] ?? -1;
  if (
    markerIndex >= 0 &&
    (markerIndex === 0 || blocks[markerIndex - 1]?.type !== "divider")
  ) {
    throw new TaskNotionError(
      "MASTER_DIVIDER_REQUIRED",
      `Перед разделом «${MASTER_SPEC_MARKER}» нужен divider`,
      { external: true },
    );
  }
  const content = markerIndex >= 0 ? blocks.slice(markerIndex + 1) : [];
  return {
    markerIndex,
    markerId: markerIndex >= 0 ? blocks[markerIndex].id || "" : "",
    content,
    text: content.map(blockText).filter(Boolean).join("\n"),
    fingerprint: fingerprint(content.map(normalizedBlock)),
  };
}

export function buildBusinessHierarchySnapshot(pages, schema) {
  const pagesById = new Map();
  const parentIdsByPageId = new Map();
  const childrenByParentId = new Map();
  for (const page of pages) {
    if (!page?.id) continue;
    if (pagesById.has(page.id)) {
      throw new TaskNotionError(
        "PAGE_ID_AMBIGUOUS",
        `Страница бизнес-требования ${page.id} встречается дважды`,
        { external: true },
      );
    }
    pagesById.set(page.id, page);
    const parents = pageParentIds(page, schema);
    if (parents.length > 1) {
      throw new TaskNotionError(
        "MULTIPLE_PARENTS",
        `У бизнес-требования «${pageTitle(page, schema.titleName) || page.id}» несколько родителей`,
        { external: true },
      );
    }
    parentIdsByPageId.set(page.id, parents);
    if (parents[0]) {
      const children = childrenByParentId.get(parents[0]) || [];
      children.push(page.id);
      childrenByParentId.set(parents[0], children);
    }
  }
  for (const [pageId, parents] of parentIdsByPageId) {
    if (!parents.length) continue;
    const parentId = parents[0];
    if (!pagesById.has(parentId)) {
      throw new TaskNotionError(
        "PARENT_NOT_FOUND",
        `Родитель бизнес-требования ${parentId} недоступен`,
        { external: true },
      );
    }
    if ((parentIdsByPageId.get(parentId) || []).length) {
      throw new TaskNotionError(
        "BUSINESS_HIERARCHY_TOO_DEEP",
        `Бизнес-требование «${pageTitle(pagesById.get(pageId), schema.titleName) || pageId}» находится глубже второго уровня`,
        { external: true },
      );
    }
  }
  if (schema.subItemName) {
    for (const page of pages) {
      const declaredChildren = (
        page?.properties?.[schema.subItemName]?.relation || []
      )
        .map((relation) => relation?.id)
        .filter(Boolean)
        .sort();
      const computedChildren = [...(childrenByParentId.get(page.id) || [])].sort();
      if (JSON.stringify(declaredChildren) !== JSON.stringify(computedChildren)) {
        throw new TaskNotionError(
          "BUSINESS_SUBITEM_MISMATCH",
          `У бизнес-требования «${pageTitle(page, schema.titleName) || page.id}» расходятся Parent item и Sub-item`,
          { external: true },
        );
      }
    }
  }
  return { pagesById, parentIdsByPageId, childrenByParentId };
}

export async function inspectBusinessRequirements(client, config) {
  if (!config.businessDatabaseId) {
    throw new TaskNotionError(
      "CONFIG_MISSING",
      "Не задан параметр Notion: NOTION_BUSINESS_REQUIREMENTS_DATABASE_ID",
      { external: true },
    );
  }
  const source = await resolveDataSource(client, config.businessDatabaseId);
  const schema = discoverBusinessSchema(source.metadata, config);
  const pages = await queryAllPages(client, source.id);
  const hierarchy = buildBusinessHierarchySnapshot(pages, schema);
  const items = [];
  for (const page of pages) {
    const blocks = await readBlockTree(client, page.id);
    const title = pageTitle(page, schema.titleName);
    assertBusinessRequirementIndependent(
      title,
      flattenedBlocks(blocks).map(blockText),
    );
    if (page.icon?.type !== "emoji" || !page.icon.emoji) {
      throw new TaskNotionError(
        "PAGE_ICON_REQUIRED",
        `У бизнес-требования «${title || page.id}» отсутствует emoji-иконка`,
        { external: true },
      );
    }
    if (title === "История релизов") {
      const parentId = hierarchy.parentIdsByPageId.get(page.id)?.[0] || "";
      const childIds = hierarchy.childrenByParentId.get(page.id) || [];
      const forbidden = flattenedBlocks(blocks).filter(
        (item) => item.type !== "child_database",
      );
      if (parentId || childIds.length || forbidden.length) {
        throw new TaskNotionError(
          "RELEASE_HISTORY_CONTENT_FORBIDDEN",
          "«История релизов» должна быть верхнеуровневой бизнес-сущностью без описания, master/delta-спецификации и статических списков",
          { external: true },
        );
      }
    }
    const master = masterSection(blocks);
    items.push({
      id: page.id,
      title,
      parentId: hierarchy.parentIdsByPageId.get(page.id)?.[0] || "",
      childIds: hierarchy.childrenByParentId.get(page.id) || [],
      blocks,
      content: blocks.map(normalizedBlock),
      master: {
        markerIndex: master.markerIndex,
        text: master.text,
        fingerprint: master.fingerprint,
      },
    });
  }
  const snapshotFingerprint = fingerprint(
    items.map(({ id, title, parentId, childIds, content }) => ({
      id,
      title,
      parentId,
      childIds,
      content,
    })),
  );
  return { source, schema, pages, hierarchy, items, snapshotFingerprint };
}

function richTextValue(items = []) {
  return items
    .map((item) => item.plain_text ?? item.text?.content ?? "")
    .join("");
}

export function pageTitle(page, titleName) {
  return richTextValue(page?.properties?.[titleName]?.title || []);
}

export function pageStatus(page, schema) {
  const property = page?.properties?.[schema.statusName];
  return property?.status?.name || property?.select?.name || "";
}

export function pageParentIds(page, schema) {
  return (page?.properties?.[schema.parentName]?.relation || [])
    .map((relation) => relation?.id)
    .filter(Boolean);
}

function selectValue(page, propertyName) {
  if (!propertyName) return "";
  const property = page?.properties?.[propertyName];
  return property?.select?.name || property?.status?.name || "";
}

function canonicalValue(value, storage) {
  if (!value) return "";
  return (
    Object.entries(storage).find(([, aliases]) =>
      aliases.some(
        (alias) => alias.toLocaleLowerCase("ru") === value.toLocaleLowerCase("ru"),
      ),
    )?.[0] || ""
  );
}

export function pageTaskType(page, schema) {
  const rawType = selectValue(page, schema.typeName);
  const type = canonicalValue(rawType, TASK_TYPE_STORAGE);
  if (rawType && !type) {
    throw new TaskNotionError(
      "UNKNOWN_TASK_TYPE",
      `У задачи задан неизвестный тип «${rawType}»`,
      { external: true },
    );
  }
  return type;
}

export function normalizeTaskType(value) {
  return canonicalValue(String(value || ""), TASK_TYPE_STORAGE);
}

export function isOpenSpecOwner(
  type,
  { technicalDebt = false } = {},
) {
  return type === "История" || (type === "Эпик" && technicalDebt);
}

export function randomPageIcon(random = Math.random) {
  const sample = Number(random());
  const normalized = Number.isFinite(sample)
    ? Math.min(Math.max(sample, 0), 0.9999999999999999)
    : 0;
  return {
    type: "emoji",
    emoji: PAGE_ICONS[Math.floor(normalized * PAGE_ICONS.length)],
  };
}

export function assertBusinessRequirementIndependent(...values) {
  const text = values.flat(Infinity).map(String).join("\n");
  const match = text.match(/\b[A-Z][A-Z0-9]*-[0-9]+\b/iu);
  if (match) {
    throw new TaskNotionError(
      "BUSINESS_W_LINK_FORBIDDEN",
      `Бизнес-требование не должно содержать код ${match[0]}`,
      { external: true },
    );
  }
  return true;
}

export function assertTaskTitleWithoutTaskCode(title) {
  const match = String(title || "").match(/\b[A-Z][A-Z0-9]*-[0-9]+\b/iu);
  if (match) {
    throw new TaskNotionError(
      "TASK_TITLE_W_CODE_FORBIDDEN",
      `Заголовок задачи не должен содержать код ${match[0]}: он хранится в свойстве ID`,
    );
  }
  return true;
}

export function pagePriority(page, schema) {
  return selectValue(page, schema.priorityName);
}

export function pageSize(page, schema) {
  return canonicalValue(selectValue(page, schema.sizeName), SIZE_STORAGE);
}

export function pageReleaseDate(page, schema) {
  return page?.properties?.[schema.releaseDateName]?.date?.start || "";
}

export function pageTechnicalDebt(page, schema) {
  return page?.properties?.[schema.technicalDebtName]?.checkbox === true;
}

export function pageReleaseProcess(page, schema) {
  return selectValue(page, schema.releaseProcessName);
}

export function pageReleaseIds(page, schema) {
  return (page?.properties?.[schema.releaseName]?.relation || [])
    .map((item) => item?.id)
    .filter(Boolean);
}

export function pageReleaseBugIds(page, schema) {
  return (page?.properties?.[schema.releaseBugName]?.relation || [])
    .map((item) => item?.id)
    .filter(Boolean);
}

export function buildTaskHierarchySnapshot(pages, schema) {
  const pagesById = new Map();
  const parentIdsByPageId = new Map();
  const directChildrenByParentId = new Map();
  const typesByPageId = new Map();

  for (const page of pages) {
    if (!page?.id) continue;
    if (pagesById.has(page.id)) {
      throw new TaskNotionError(
        "PAGE_ID_AMBIGUOUS",
        `В снимке базы Notion страница ${page.id} встречается дважды`,
        { external: true },
      );
    }
    pagesById.set(page.id, page);
    typesByPageId.set(page.id, pageTaskType(page, schema));
    const parentIds = pageParentIds(page, schema);
    parentIdsByPageId.set(page.id, parentIds);
    for (const parentId of parentIds) {
      const children = directChildrenByParentId.get(parentId) || [];
      children.push(page);
      directChildrenByParentId.set(parentId, children);
    }
  }

  return {
    pagesById,
    parentIdsByPageId,
    directChildrenByParentId,
    typesByPageId,
  };
}

export function openDescendantBugs(pageId, snapshot, schema) {
  const result = [];
  const visited = new Set();
  const walk = (parentId) => {
    if (visited.has(parentId)) {
      throw new TaskNotionError(
        "PARENT_CYCLE",
        "В иерархии задач Notion найден цикл",
        { external: true },
      );
    }
    visited.add(parentId);
    for (const child of snapshot.directChildrenByParentId.get(parentId) || []) {
      if (pageTaskType(child, schema) === "Баг") {
        if (pageStatus(child, schema) !== "Закрыто") result.push(child);
        continue;
      }
      walk(child.id);
    }
  };
  walk(pageId);
  return result;
}

export function releasedAncestor(page, snapshot, schema) {
  let current = page || null;
  const visited = new Set();
  while (current) {
    if (visited.has(current.id)) {
      throw new TaskNotionError("PARENT_CYCLE", "В иерархии задач Notion найден цикл", { external: true });
    }
    visited.add(current.id);
    if (["Эпик", "История"].includes(pageTaskType(current, schema)) && pageReleaseIds(current, schema).length) {
      return current;
    }
    const parentIds = snapshot.parentIdsByPageId.get(current.id) || [];
    if (parentIds.length > 1) {
      throw new TaskNotionError("PARENT_AMBIGUOUS", "У элемента найдено несколько родителей", { external: true });
    }
    current = parentIds[0] ? snapshot.pagesById.get(parentIds[0]) || null : null;
  }
  return null;
}

function assertNoOpenDescendantBugs(page, snapshot, schema) {
  const type = pageTaskType(page, schema);
  if (type !== "Эпик" && type !== "История") return;
  const bugs = openDescendantBugs(page.id, snapshot, schema);
  if (!bugs.length) return;
  throw new TaskNotionError(
    "RELEASE_OPEN_SUBITEM_BUG",
    `Нельзя выпускать ${type.toLocaleLowerCase("ru")} ${pageTaskCode(page, schema.idName) || page.id}: открытые вложенные баги ${bugs
      .map((bug) => pageTaskCode(bug, schema.idName) || bug.id)
      .join(", ")}. Закрой их либо перенеси на верхний уровень с relation «Баг релиза»`,
    { external: true },
  );
}

export function assertAllowedTaskRelation(parentType, childType) {
  if (!TASK_TYPES.includes(childType)) {
    throw new TaskNotionError(
      "TASK_TYPE_REQUIRED",
      `Неизвестный или отсутствующий тип задачи «${childType || "не задан"}»`,
    );
  }
  const key = parentType || "root";
  if (!ALLOWED_CHILD_TYPES[key]?.includes(childType)) {
    throw new TaskNotionError(
      "TASK_RELATION_INVALID",
      `Тип «${childType}» нельзя создать у ${parentType ? `родителя типа «${parentType}»` : "верхнего уровня"}`,
    );
  }
  return true;
}

export function estimateTaskSize(estimatedCodeLines) {
  if (!Number.isInteger(estimatedCodeLines) || estimatedCodeLines < 0) {
    throw new TaskNotionError(
      "ESTIMATE_INVALID",
      "Оценка размера должна быть целым неотрицательным числом строк кода",
    );
  }
  if (estimatedCodeLines <= 200) return "Маленький";
  if (estimatedCodeLines <= 1000) return "Обычный";
  if (estimatedCodeLines <= 5000) return "Крупный";
  return "Огромный";
}

const SIZE_EXCLUDED_BASENAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
]);

export function isSizeExcludedChange({ path = "", generated = false, formattingOnly = false } = {}) {
  const normalized = String(path).replaceAll("\\", "/").toLowerCase();
  const name = normalized.split("/").at(-1) || "";
  return (
    generated === true ||
    formattingOnly === true ||
    SIZE_EXCLUDED_BASENAMES.has(name) ||
    normalized.endsWith(".snap") ||
    normalized.includes("/__snapshots__/") ||
    normalized.includes("/migrations/") ||
    normalized.startsWith("migrations/")
  );
}

export function estimateManualCodeLines(changes) {
  if (!Array.isArray(changes)) {
    throw new TaskNotionError("ESTIMATE_CHANGES_INVALID", "Изменения для оценки должны быть массивом");
  }
  return changes.reduce((total, change) => {
    const lines = Number(change?.lines);
    if (!Number.isInteger(lines) || lines < 0) {
      throw new TaskNotionError("ESTIMATE_INVALID", "Число изменяемых строк должно быть целым и неотрицательным");
    }
    return isSizeExcludedChange(change) ? total : total + lines;
  }, 0);
}

export function resolveStoredOption(schemaOptions, canonical, storage = {}) {
  const candidates = storage[canonical] || [canonical];
  const option = candidates.find((candidate) => schemaOptions.includes(candidate));
  if (!option) {
    throw new TaskNotionError(
      "SCHEMA_OPTION_MISSING",
      `В Notion отсутствует значение «${canonical}»`,
      { external: true },
    );
  }
  return option;
}

function mentionObject(pageId) {
  return {
    type: "mention",
    mention: { type: "page", page: { id: pageId } },
    annotations: { ...defaultAnnotations },
  };
}

function richTextBlock(type, richText, extra = {}) {
  return {
    object: "block",
    type,
    [type]: { rich_text: richText, color: "default", ...extra },
  };
}

function paragraphWithMentions(label, pageIds) {
  const richText = [textObject(label)];
  pageIds.forEach((pageId, index) => {
    if (index) richText.push(textObject(", "));
    richText.push(mentionObject(pageId));
  });
  return richTextBlock("paragraph", richText);
}

function calloutWithMentions(label, pageIds) {
  const paragraph = paragraphWithMentions(label, pageIds);
  return richTextBlock("callout", paragraph.paragraph.rich_text, {
    icon: { type: "emoji", emoji: CALLOUT_ICON },
  });
}

export function buildReleaseHistoryBusinessTemplate({
} = {}) {
  return [];
}

function taskStoryReference(storyId) {
  return richTextBlock("paragraph", [
    textObject("Поведение описано в "),
    mentionObject(storyId),
    textObject("."),
  ]);
}

function boldLabelBlock(text) {
  return richTextBlock("paragraph", [textObject(text, { bold: true })]);
}

const RELEASE_MONTHS_RU = Object.freeze([
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
]);

export function formatReleaseDateRu(
  value,
  { currentYear = new Date().getFullYear() } = {},
) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) {
    throw new TaskNotionError(
      "RELEASE_DATE_REQUIRED",
      "Для release-истории нужна дата в формате YYYY-MM-DD",
    );
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TaskNotionError("RELEASE_DATE_INVALID", "Указана несуществующая дата релиза");
  }
  const formatted = `${day} ${RELEASE_MONTHS_RU[month - 1]}`;
  return year === currentYear ? formatted : `${formatted} ${year}`;
}

export function formatReleaseTitleRu(value) {
  return `Релиз от ${formatReleaseDateRu(value, { currentYear: Number.NaN })}`;
}

export function buildReleaseStoryTemplate({
  releaseDate,
  changes = [],
  currentYear = new Date().getFullYear(),
} = {}) {
  if (!changes.length) {
    throw new TaskNotionError(
      "RELEASE_CHANGES_REQUIRED",
      "Для истории релиза нужен список изменений из Git",
    );
  }
  return [
    richTextBlock(
      "callout",
      [
        textObject(
          `Дата релиза — ${formatReleaseDateRu(releaseDate, { currentYear })}`,
        ),
      ],
      { icon: { type: "emoji", emoji: CALLOUT_ICON } },
    ),
    richTextBlock("heading_2", [textObject("Изменения")]),
    ...changes.map((change) =>
      richTextBlock("bulleted_list_item", markdownInlineToRichText(change)),
    ),
    dividerBlock(),
  ];
}

function dividerBlock() {
  return { object: "block", type: "divider", divider: {} };
}

function descriptionBlocks(description) {
  if (!String(description || "").trim()) {
    throw new TaskNotionError(
      "DESCRIPTION_REQUIRED",
      "Для нового элемента требуется конкретное описание",
    );
  }
  return paragraphBlocks(String(description).trim());
}

export function buildTaskTemplate({
  type,
  description,
  businessRequirementIds = [],
  parentId = "",
  storyId = "",
  discoveredReleaseId = "",
  steps = [],
  expectedResults = [],
  checks = [],
  expectedResult = "",
  actualResult = "",
  technicalDebtContext = false,
} = {}) {
  const descriptionPart = descriptionBlocks(description);
  if ((type === "Эпик" || type === "История") && !technicalDebtContext) {
    if (!businessRequirementIds.length) {
      throw new TaskNotionError(
        "BUSINESS_REQUIREMENT_REQUIRED",
        `Для типа «${type}» нужна ссылка на бизнес-требование`,
      );
    }
  }
  if (type === "Эпик") {
    if (technicalDebtContext) return descriptionPart;
    return [
      calloutWithMentions("Ссылка на бизнес-требования — ", businessRequirementIds),
      ...descriptionPart,
    ];
  }
  if (type === "История") {
    if (!steps.length)
      throw new TaskNotionError(
        "STORY_STEPS_REQUIRED",
        "Для Истории нужен хотя бы один пункт в рамках работы",
      );
    if (!checks.length)
      throw new TaskNotionError(
        "STORY_ACCEPTANCE_REQUIRED",
        "Для Истории нужен хотя бы один критерий приёмки",
      );
    const content = [
      ...descriptionPart,
      boldLabelBlock("В рамках Истории необходимо"),
      ...steps.map((step) =>
        richTextBlock("to_do", markdownInlineToRichText(step), {
          checked: false,
        }),
      ),
      boldLabelBlock("Критерии приёмки"),
      ...checks.map((check) =>
        richTextBlock("to_do", markdownInlineToRichText(check), {
          checked: false,
        }),
      ),
    ];
    if (technicalDebtContext) return content;
    return [
      calloutWithMentions("Ссылка на бизнес-требования — ", businessRequirementIds),
      ...content,
    ];
  }
  if (type === "Задача") {
    if (!storyId)
      throw new TaskNotionError(
        "STORY_REQUIRED",
        "Для задачи нужна ссылка на родительскую историю",
      );
    if (!steps.length)
      throw new TaskNotionError(
        "TASK_STEPS_REQUIRED",
        "Для Задачи нужен хотя бы один шаг",
      );
    if (!expectedResults.length)
      throw new TaskNotionError(
        "TASK_RESULTS_REQUIRED",
        "Для Задачи нужен хотя бы один ожидаемый результат",
      );
    return [
      ...descriptionPart,
      taskStoryReference(storyId),
      boldLabelBlock("Шаги задачи"),
      ...steps.map((step) =>
        richTextBlock("to_do", markdownInlineToRichText(step), {
          checked: false,
        }),
      ),
      boldLabelBlock("Ожидаемый результат"),
      ...expectedResults.map((result) =>
        richTextBlock("to_do", markdownInlineToRichText(result), {
          checked: false,
        }),
      ),
      ...(checks.length
        ? [
            boldLabelBlock("Проверка"),
            ...checks.map((check) =>
              richTextBlock("to_do", markdownInlineToRichText(check), {
                checked: false,
              }),
            ),
          ]
        : []),
    ];
  }
  if (type === "Подзадача") {
    if (!parentId)
      throw new TaskNotionError(
        "TASK_REQUIRED",
        "Для подзадачи нужна ссылка на родительскую задачу",
      );
    if (!steps.length)
      throw new TaskNotionError(
        "SUBTASK_STEPS_REQUIRED",
        "Для подзадачи нужен хотя бы один шаг",
      );
    if (!expectedResults.length)
      throw new TaskNotionError(
        "SUBTASK_RESULTS_REQUIRED",
        "Для подзадачи нужен хотя бы один ожидаемый результат",
      );
    return [
      ...descriptionPart,
      boldLabelBlock("Шаги подзадачи"),
      ...steps.map((step) =>
        richTextBlock("to_do", markdownInlineToRichText(step), {
          checked: false,
        }),
      ),
      boldLabelBlock("Ожидаемый результат"),
      ...expectedResults.map((result) =>
        richTextBlock("to_do", markdownInlineToRichText(result), {
          checked: false,
        }),
      ),
      ...(checks.length
        ? [
            boldLabelBlock("Проверка"),
            ...checks.map((check) =>
              richTextBlock("to_do", markdownInlineToRichText(check), {
                checked: false,
              }),
            ),
          ]
        : []),
    ];
  }
  if (type === "Баг") {
    if (!String(expectedResult).trim() || !String(actualResult).trim()) {
      throw new TaskNotionError(
        "BUG_RESULT_REQUIRED",
        "Для бага обязательны ОР и ФР",
      );
    }
    if (parentId && discoveredReleaseId) {
      throw new TaskNotionError(
        "BUG_CONTEXT_CONFLICT",
        "Вложенный баг не должен содержать релиз обнаружения",
      );
    }
    if (!parentId && !discoveredReleaseId) {
      throw new TaskNotionError(
        "BUG_DISCOVERED_RELEASE_REQUIRED",
        "Для верхнеуровневого бага нужен релиз обнаружения",
      );
    }
    return [
      ...(discoveredReleaseId
        ? [calloutWithMentions("Обнаружен: ", [discoveredReleaseId])]
        : []),
      boldLabelBlock("Описание дефекта:"),
      ...descriptionPart,
      dividerBlock(),
      boldLabelBlock("ОР:"),
      ...paragraphBlocks(String(expectedResult).trim()),
      dividerBlock(),
      boldLabelBlock("ФР:"),
      ...paragraphBlocks(String(actualResult).trim()),
      dividerBlock(),
      boldLabelBlock("Приложения:"),
    ];
  }
  throw new TaskNotionError(
    "TASK_TYPE_REQUIRED",
    `Неизвестный тип задачи «${type || "не задан"}»`,
  );
}

function pageAncestorOfType(page, targetType, snapshot, schema) {
  const visited = new Set();
  let current = page;
  while (current) {
    if (visited.has(current.id)) {
      throw new TaskNotionError(
        "PARENT_CYCLE",
        "В иерархии задач Notion найден цикл",
        { external: true },
      );
    }
    visited.add(current.id);
    if (pageTaskType(current, schema) === targetType) return current;
    const parentIds = snapshot.parentIdsByPageId.get(current.id) || [];
    if (parentIds.length > 1) {
      throw new TaskNotionError(
        "MULTIPLE_PARENTS",
        `У задачи «${pageTitle(current, schema.titleName) || current.id}» несколько родителей`,
        { external: true },
      );
    }
    current = parentIds[0] ? snapshot.pagesById.get(parentIds[0]) : null;
    if (parentIds[0] && !current) {
      throw new TaskNotionError(
        "PARENT_NOT_FOUND",
        `Родительская страница ${parentIds[0]} недоступна`,
        { external: true },
      );
    }
  }
  return null;
}

function technicalDebtEpicForPage(page, snapshot, schema) {
  const epic = pageAncestorOfType(page, "Эпик", snapshot, schema);
  return epic && pageTechnicalDebt(epic, schema) ? epic : null;
}

function openSpecOwnerContext(page, pages, schema) {
  const snapshot = buildTaskHierarchySnapshot(pages, schema);
  const type = pageTaskType(page, schema);
  const technicalDebtEpic = technicalDebtEpicForPage(page, snapshot, schema);
  return {
    type,
    technicalDebt: type === "Эпик" && Boolean(technicalDebtEpic),
    inheritedTechnicalDebt:
      type !== "Эпик" && Boolean(technicalDebtEpic),
    technicalDebtEpic,
  };
}

function findPageByCode(pages, schema, code, label) {
  if (!code) return null;
  try {
    return selectTaskPage(pages, schema, code).page;
  } catch (error) {
    if (error instanceof TaskNotionError) {
      throw new TaskNotionError(error.code, `${label}: ${error.message}`, {
        external: error.external,
        cause: error,
      });
    }
    throw error;
  }
}

function pagePropertiesForCreate(
  schema,
  {
    title,
    type,
    priority,
    size,
    parentId,
    releaseDate,
    discoveredReleaseId,
    technicalDebt = false,
  },
) {
  const properties = {
    [schema.titleName]: { title: [textObject(title)] },
    [schema.statusName]:
      schema.statusType === "status"
        ? { status: { name: "Бэклог" } }
        : { select: { name: "Бэклог" } },
    [schema.typeName]: {
      select: {
        name: resolveStoredOption(
          schema.typeOptions,
          type,
          TASK_TYPE_STORAGE,
        ),
      },
    },
    [schema.releaseProcessName]: {
      select: { name: RELEASE_PROCESS_V1 },
    },
  };
  if (priority) properties[schema.priorityName] = { select: { name: priority } };
  if (size) {
    properties[schema.sizeName] = {
      select: {
        name: resolveStoredOption(schema.sizeOptions, size, SIZE_STORAGE),
      },
    };
  }
  if (parentId) properties[schema.parentName] = { relation: [{ id: parentId }] };
  if (releaseDate) {
    properties[schema.releaseDateName] = { date: { start: releaseDate } };
  }
  if (discoveredReleaseId) {
    properties[schema.releaseBugName] = {
      relation: [{ id: discoveredReleaseId }],
    };
  }
  if (technicalDebt) {
    properties[schema.technicalDebtName] = { checkbox: true };
  }
  return properties;
}

function blockSignature(item) {
  return JSON.stringify(normalizedBlock(item));
}

export function missingBlockSuffix(existingBlocks, expectedBlocks) {
  const overlap = Math.min(existingBlocks.length, expectedBlocks.length);
  for (let index = 0; index < overlap; index += 1) {
    if (blockSignature(existingBlocks[index]) !== blockSignature(expectedBlocks[index])) {
      throw new TaskNotionError(
        "CREATE_CONTENT_CONFLICT",
        "Существующее тело страницы расходится с обязательным шаблоном",
        { external: true },
      );
    }
  }
  return existingBlocks.length >= expectedBlocks.length
    ? []
    : expectedBlocks.slice(existingBlocks.length);
}

async function appendMissingBlocks(client, pageId, expectedBlocks) {
  const existing = await listAllChildren(client, pageId);
  const missing = missingBlockSuffix(existing, expectedBlocks);
  for (let index = 0; index < missing.length; index += 100) {
    await client.request(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: { children: missing.slice(index, index + 100) },
    });
  }
  return missing.length;
}

const REFRESHABLE_CONTENT_BLOCK_TYPES = new Set([
  "paragraph",
  "callout",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "quote",
  "divider",
]);

function checkedTaskTemplate(blocks, checked) {
  if (!checked) return blocks;
  return blocks.map((item) =>
    item.type === "to_do"
      ? { ...item, to_do: { ...item.to_do, checked: true } }
      : item,
  );
}

function taskContentBlockSignature(item) {
  return JSON.stringify({
    type: item.type,
    richText: blockRichText(item).map((value) =>
      value?.type === "mention" && value?.mention?.type === "page"
        ? { mention: value.mention.page?.id || "" }
        : { text: value?.plain_text ?? value?.text?.content ?? "" },
    ),
    icon:
      item?.[item.type]?.icon?.type === "emoji"
        ? item[item.type].icon.emoji
        : "",
    checked: item.type === "to_do" ? Boolean(item.to_do?.checked) : null,
  });
}

function isProtectedTaskContentBlock(item, { preserveBusinessCallout = false } = {}) {
  if (item.type === "child_database") return true;
  if (item.type === "toggle") {
    const title = toggleTitle(item);
    return title.startsWith(MANAGED_SPEC_PREFIX) || isManagedDocumentTitle(title);
  }
  return preserveBusinessCallout && item.type === "callout" && blockPageMentions(item).length > 0;
}

function normalizeContentManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.items) || !manifest.items.length) {
    throw new TaskNotionError(
      "CONTENT_MANIFEST_INVALID",
      "Манифест обновления должен содержать непустой массив items",
    );
  }
  const codes = new Set();
  return manifest.items.map((rawItem) => {
    const code = String(rawItem?.code || "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(code)) {
      throw new TaskNotionError(
        "CONTENT_MANIFEST_INVALID",
        `В манифесте указан некорректный код «${code}»`,
      );
    }
    if (codes.has(code)) {
      throw new TaskNotionError(
        "CONTENT_MANIFEST_DUPLICATE",
        `Карточка ${code} повторяется в манифесте`,
      );
    }
    codes.add(code);
    const title = String(rawItem.title || "").trim();
    if (title) assertTaskTitleWithoutTaskCode(title);
    return {
      code,
      title,
      description: String(rawItem.description || "").trim(),
      steps: Array.isArray(rawItem.steps) ? rawItem.steps.map(String) : [],
      expectedResults: Array.isArray(rawItem.expectedResults)
        ? rawItem.expectedResults.map(String)
        : [],
      checks: Array.isArray(rawItem.checks) ? rawItem.checks.map(String) : [],
    };
  });
}

async function readContentManifest(manifestPath) {
  if (!manifestPath) {
    throw new TaskNotionError(
      "CONTENT_MANIFEST_REQUIRED",
      "Укажи JSON-манифест через --manifest",
    );
  }
  let raw;
  try {
    raw = await readFile(resolve(manifestPath), "utf8");
  } catch (error) {
    throw new TaskNotionError(
      "CONTENT_MANIFEST_READ_FAILED",
      `Не удалось прочитать манифест: ${manifestPath}`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new TaskNotionError(
      "CONTENT_MANIFEST_INVALID",
      `Манифест ${manifestPath} не является корректным JSON`,
      { cause: error },
    );
  }
}

export async function refreshTaskContents(
  client,
  config,
  rootCode,
  { approved = false, dryRun = false, manifest, manifestPath } = {},
) {
  if (!approved && !dryRun) {
    throw new TaskNotionError(
      "APPROVAL_REQUIRED",
      "Массовое обновление карточек требует явный флаг --approved",
    );
  }
  const entries = normalizeContentManifest(
    manifest || (await readContentManifest(manifestPath)),
  );
  const selected = await findTask(client, config, rootCode);
  const snapshot = buildTaskHierarchySnapshot(selected.pages, selected.schema);
  const descendants = [];
  const collect = (parentId) => {
    for (const page of snapshot.directChildrenByParentId.get(parentId) || []) {
      if (pageTaskType(page, selected.schema) !== "Баг") descendants.push(page);
      collect(page.id);
    }
  };
  collect(selected.page.id);
  const refreshablePages = descendants.filter((page) =>
    ["История", "Задача", "Подзадача"].includes(
      pageTaskType(page, selected.schema),
    ),
  );
  const pagesByCode = new Map(
    refreshablePages.map((page) => [
      pageTaskCode(page, selected.schema.idName),
      page,
    ]),
  );
  const expectedCodes = [...pagesByCode.keys()].sort();
  const manifestCodes = entries.map((item) => item.code).sort();
  if (JSON.stringify(expectedCodes) !== JSON.stringify(manifestCodes)) {
    const missing = expectedCodes.filter((code) => !manifestCodes.includes(code));
    const extra = manifestCodes.filter((code) => !expectedCodes.includes(code));
    throw new TaskNotionError(
      "CONTENT_MANIFEST_SCOPE_MISMATCH",
      `Манифест должен покрывать все Истории, Задачи и Подзадачи: пропущены ${missing.join(", ") || "нет"}; лишние ${extra.join(", ") || "нет"}`,
    );
  }

  const plans = [];
  for (let offset = 0; offset < entries.length; offset += 8) {
    const batch = await Promise.all(
      entries.slice(offset, offset + 8).map(async (entry) => {
        const page = pagesByCode.get(entry.code);
        const type = pageTaskType(page, selected.schema);
        if (pageReleaseDate(page, selected.schema)) {
          throw new TaskNotionError(
            "RELEASE_STORY_CONTENT_FORBIDDEN",
            `Release-история ${entry.code} обновляется отдельным release-шаблоном`,
          );
        }
        const technicalDebtContext = Boolean(
          technicalDebtEpicForPage(page, snapshot, selected.schema),
        );
        const story = pageAncestorOfType(
          page,
          "История",
          snapshot,
          selected.schema,
        );
        const parentIds = assertSingleParent(page, snapshot, selected.schema);
        const expectedBlocks = checkedTaskTemplate(
          buildTaskTemplate({
            type,
            description: entry.description,
            parentId: parentIds[0] || "",
            storyId: story?.id || "",
            steps: entry.steps,
            expectedResults: entry.expectedResults,
            checks: entry.checks,
            technicalDebtContext: true,
          }),
          pageStatus(page, selected.schema) === "Закрыто",
        );
        const existing = await listAllChildren(client, page.id);
        const preserveBusinessCallout = type === "История" && !technicalDebtContext;
        const bodyBlocks = existing.filter(
          (item) =>
            !isProtectedTaskContentBlock(item, { preserveBusinessCallout }),
        );
        if (!bodyBlocks.length) {
          throw new TaskNotionError(
            "CONTENT_ANCHOR_REQUIRED",
            `У карточки ${entry.code} нет текстового блока, перед которым можно безопасно заменить тело`,
            { external: true },
          );
        }
        const unsafe = bodyBlocks.find(
          (item) => !REFRESHABLE_CONTENT_BLOCK_TYPES.has(item.type),
        );
        if (unsafe) {
          throw new TaskNotionError(
            "CONTENT_BLOCK_UNSAFE",
            `Карточка ${entry.code} содержит пользовательский блок ${unsafe.type}; автоматическая замена остановлена`,
            { external: true },
          );
        }
        return {
          entry,
          page,
          bodyBlocks,
          expectedBlocks,
        };
      }),
    );
    plans.push(...batch);
  }

  const plannedRenames = plans.filter(
    (plan) =>
      plan.entry.title &&
      plan.entry.title !== pageTitle(plan.page, selected.schema.titleName),
  ).length;
  if (dryRun) {
    return { updated: plans.length, renamed: plannedRenames, dryRun: true };
  }
  let renamed = 0;
  for (const plan of plans) {
    const anchorId = plan.bodyBlocks[0].id;
    await client.request(`/blocks/${plan.page.id}/children`, {
      method: "PATCH",
      body: {
        children: plan.expectedBlocks,
        position: {
          type: "after_block",
          after_block: { id: anchorId },
        },
      },
    });
    const refreshed = await listAllChildren(client, plan.page.id);
    const anchorIndex = refreshed.findIndex((item) => item.id === anchorId);
    const insertedBlocks = refreshed.slice(
      anchorIndex + 1,
      anchorIndex + 1 + plan.expectedBlocks.length,
    );
    const insertionConfirmed =
      anchorIndex >= 0 &&
      insertedBlocks.length === plan.expectedBlocks.length &&
      insertedBlocks.every(
        (item, index) =>
          taskContentBlockSignature(item) ===
          taskContentBlockSignature(plan.expectedBlocks[index]),
      );
    if (!insertionConfirmed) {
      throw new TaskNotionError(
        "CONTENT_BLOCK_CREATE_FAILED",
        `Повторное чтение не подтвердило полное новое тело карточки ${plan.entry.code}`,
        { external: true },
      );
    }
    for (const item of plan.bodyBlocks) {
      await client.request(`/blocks/${item.id}`, { method: "DELETE" });
    }
    if (
      plan.entry.title &&
      plan.entry.title !== pageTitle(plan.page, selected.schema.titleName)
    ) {
      await client.request(`/pages/${plan.page.id}`, {
        method: "PATCH",
        body: {
          properties: {
            [selected.schema.titleName]: {
              title: plainRichText(plan.entry.title),
            },
          },
        },
      });
      renamed += 1;
    }
  }
  return { updated: plans.length, renamed, dryRun: false };
}

function sameParent(page, schema, parentId) {
  const parents = pageParentIds(page, schema);
  return parentId ? parents.length === 1 && parents[0] === parentId : !parents.length;
}

export function assertStoryBusinessScope(
  epicBusinessIds,
  storyBusinessIds,
  businessHierarchy,
  { businessSubitemApproved = false } = {},
) {
  const epicIds = new Set(epicBusinessIds);
  for (const storyId of storyBusinessIds) {
    if (epicIds.has(storyId)) continue;
    const parentId = businessHierarchy.parentIdsByPageId.get(storyId)?.[0] || "";
    if (!epicIds.has(parentId)) {
      throw new TaskNotionError(
        "BUSINESS_SCOPE_MISMATCH",
        "История может ссылаться только на бизнес-требование эпика или его прямой sub-item",
      );
    }
    if (!businessSubitemApproved) {
      throw new TaskNotionError(
        "BUSINESS_SUBITEM_APPROVAL_REQUIRED",
        "Для связи истории с sub-item бизнес-требования нужно явное согласование оператора",
      );
    }
  }
  return true;
}

export function resolveTaskPriority({
  type,
  releaseHistory = false,
  priorityOverride = "",
  epicPriority = "",
} = {}) {
  if (releaseHistory) {
    if (type !== "Эпик" && type !== "История") {
      throw new TaskNotionError(
        "RELEASE_TYPE_INVALID",
        "Релизной сущностью может быть только эпик или история",
      );
    }
    if (priorityOverride) {
      throw new TaskNotionError(
        "RELEASE_PRIORITY_FORBIDDEN",
        "У release-эпика и release-истории приоритета быть не должно",
      );
    }
    return { priority: "", source: "not-applicable" };
  }
  const priority = priorityOverride || epicPriority;
  if (!priority) {
    throw new TaskNotionError(
      "PRIORITY_REQUIRED",
      type === "Эпик"
        ? "До создания эпика оператор должен определить приоритет"
        : "У эпика отсутствует приоритет для наследования",
    );
  }
  return { priority, source: priorityOverride ? "override" : "epic" };
}

export async function createTaskItem(client, config, input = {}) {
  const {
    type,
    title,
    description,
    parentCode = "",
    storyCode = "",
    discoveredReleaseCode = "",
    businessRequirementIds = [],
    businessSubitemApproved = false,
    priority: priorityOverride = "",
    estimatedCodeLines,
    attachmentPath = "",
    releaseHistory = false,
    technicalDebt = false,
    approved = false,
  } = input;
  if (!TASK_TYPES.includes(type))
    throw new TaskNotionError("TASK_TYPE_REQUIRED", "Укажи допустимый тип задачи");
  if (type === "Баг" && estimatedCodeLines !== undefined) {
    throw new TaskNotionError(
      "BUG_SIZE_FORBIDDEN",
      "Для бага размер работы не применяется",
    );
  }
  if (type === "Баг" && !approved) {
    throw new TaskNotionError(
      "BUG_EXTERNAL_ACCEPTANCE_REQUIRED",
      "Баг создаётся только после подтверждённой ручной приёмки разработчиком или тестировщиком; требуется явный флаг --approved",
    );
  }
  if (type === "Баг" && storyCode) {
    throw new TaskNotionError(
      "BUG_STORY_LINK_FORBIDDEN",
      "Связь с историей не дублируется в теле бага: используй Parent item или релиз обнаружения",
    );
  }
  if (type !== "Баг" && discoveredReleaseCode) {
    throw new TaskNotionError(
      "BUG_DISCOVERED_RELEASE_TYPE_INVALID",
      "Релиз обнаружения задаётся только для бага",
    );
  }
  if (attachmentPath && type !== "Баг") {
    throw new TaskNotionError(
      "ATTACHMENT_TYPE_INVALID",
      "Локальное приложение поддерживается только для бага",
    );
  }
  if (type !== "Баг" && estimatedCodeLines === undefined) {
    throw new TaskNotionError(
      "ESTIMATE_REQUIRED",
      `Для типа «${type}» нужна оценка изменяемых строк кода`,
    );
  }
  if (releaseHistory && businessRequirementIds.length) {
    throw new TaskNotionError(
      "RELEASE_BUSINESS_LINK_FORBIDDEN",
      "Release-эпик и release-история не ссылаются на бизнес-требования",
    );
  }
  if (technicalDebt && type !== "Эпик") {
    throw new TaskNotionError(
      "TECHNICAL_DEBT_EPIC_REQUIRED",
      "Признак технического долга устанавливается только на эпике",
    );
  }
  if (technicalDebt && releaseHistory) {
    throw new TaskNotionError(
      "TECHNICAL_DEBT_RELEASE_CONFLICT",
      "Release-эпик не является эпиком технического долга",
    );
  }
  if (
    releaseHistory &&
    type === "История" &&
    !/^\d{4}-\d{2}-\d{2}$/u.test(String(input.releaseDate || ""))
  ) {
    throw new TaskNotionError(
      "RELEASE_DATE_REQUIRED",
      "Для release-истории нужна дата в формате YYYY-MM-DD",
    );
  }
  const resolvedTitle =
    releaseHistory && type === "История"
      ? formatReleaseTitleRu(input.releaseDate)
      : String(title || "").trim();
  if (!resolvedTitle)
    throw new TaskNotionError("TITLE_REQUIRED", "Укажи название задачи");
  assertTaskTitleWithoutTaskCode(resolvedTitle);

  const { source, schema } = await inspectBacklogWorkspace(client, config, {
    requireTyped: true,
  });
  const pages = await queryAllPages(client, source.id);
  const snapshot = buildTaskHierarchySnapshot(pages, schema);
  const parentPage = findPageByCode(pages, schema, parentCode, "Родитель");
  const parentType = parentPage ? pageTaskType(parentPage, schema) : "";
  if (parentPage && !parentType) {
    throw new TaskNotionError(
      "LEGACY_PARENT_UNTYPED",
      "Нельзя доказать допустимость нового ребёнка у legacy-страницы без типа",
    );
  }
  assertAllowedTaskRelation(parentType, type);

  let storyPage = findPageByCode(pages, schema, storyCode, "История");
  if (storyPage && pageTaskType(storyPage, schema) !== "История") {
    throw new TaskNotionError(
      "STORY_TYPE_INVALID",
      `Указанная страница ${storyCode} не является историей`,
    );
  }
  const discoveredReleasePage = findPageByCode(
    pages,
    schema,
    discoveredReleaseCode,
    "Релиз обнаружения",
  );
  if (type === "Баг") {
    if (parentPage && discoveredReleasePage) {
      throw new TaskNotionError(
        "BUG_CONTEXT_CONFLICT",
        "Вложенный баг не должен содержать релиз обнаружения",
      );
    }
    if (!parentPage && !discoveredReleasePage) {
      throw new TaskNotionError(
        "BUG_DISCOVERED_RELEASE_REQUIRED",
        "Для верхнеуровневого бага нужен релиз обнаружения",
      );
    }
    if (
      discoveredReleasePage &&
      (pageTaskType(discoveredReleasePage, schema) !== "История" ||
        !pageReleaseDate(discoveredReleasePage, schema))
    ) {
      throw new TaskNotionError(
        "BUG_DISCOVERED_RELEASE_INVALID",
        "Релиз обнаружения должен быть release-историей с датой",
      );
    }
    if (parentPage) {
      const shippedParent = releasedAncestor(parentPage, snapshot, schema);
      if (shippedParent) {
        throw new TaskNotionError(
          "BUG_RELEASED_PARENT_FORBIDDEN",
          "У уже выпущенного родителя баг создаётся на верхнем уровне с relation «Баг релиза»",
        );
      }
    }
    storyPage = parentPage
      ? pageAncestorOfType(parentPage, "История", snapshot, schema)
      : null;
  }

  if (type === "Задача") storyPage = parentPage;
  const epicPage =
    type === "Эпик"
      ? null
      : pageAncestorOfType(storyPage || parentPage, "Эпик", snapshot, schema);
  const inheritedTechnicalDebt = Boolean(
    epicPage && pageTechnicalDebt(epicPage, schema),
  );
  const technicalDebtContext = technicalDebt || inheritedTechnicalDebt;
  let resolvedBusinessRequirementIds = businessRequirementIds;
  if (technicalDebtContext && businessRequirementIds.length) {
    throw new TaskNotionError(
      "TECHNICAL_DEBT_BUSINESS_LINK_FORBIDDEN",
      "Эпик технического долга и его дети не ссылаются на бизнес-требования",
    );
  }
  const priorityResult = resolveTaskPriority({
    type,
    releaseHistory,
    priorityOverride,
    epicPriority: epicPage ? pagePriority(epicPage, schema) : "",
  });
  const storedPriority = priorityResult.priority
    ? schema.priorityOptions.find(
        (option) =>
          option.toLocaleLowerCase("ru") ===
          priorityResult.priority.toLocaleLowerCase("ru"),
      )
    : "";
  if (
    priorityResult.priority &&
    (!storedPriority || !PRIORITIES.includes(storedPriority.toLowerCase()))
  ) {
    throw new TaskNotionError(
      "PRIORITY_INVALID",
      `Недопустимый приоритет «${priorityResult.priority}»`,
    );
  }

  if (
    (type === "Эпик" || type === "История") &&
    !releaseHistory &&
    !technicalDebtContext
  ) {
    const business = await inspectBusinessRequirements(client, config);
    resolvedBusinessRequirementIds = businessRequirementIds.map((pageId) => {
      const resolvedPageId = resolvePageId(
        business.hierarchy.pagesById,
        pageId,
      );
      if (!resolvedPageId) {
        throw new TaskNotionError(
          "BUSINESS_REQUIREMENT_NOT_FOUND",
          `Бизнес-требование ${pageId} не относится к настроенной базе`,
          { external: true },
        );
      }
      return resolvedPageId;
    });
    if (type === "История") {
      const epicBlocks = await readBlockTree(client, parentPage.id);
      const epicMentions = [
        ...new Set(
          epicBlocks.flatMap(function collect(item) {
            return [
              ...blockPageMentions(item),
              ...(item.children || []).flatMap(collect),
            ];
          }),
        ),
      ];
      const epicBusinessIds = epicMentions.filter((id) =>
        business.hierarchy.pagesById.has(id),
      );
      if (!epicBusinessIds.length) {
        throw new TaskNotionError(
          "EPIC_BUSINESS_MENTION_REQUIRED",
          "У эпика нет доступной ссылки на бизнес-требование",
          { external: true },
        );
      }
      assertStoryBusinessScope(
        epicBusinessIds,
        resolvedBusinessRequirementIds,
        business.hierarchy,
        { businessSubitemApproved },
      );
    }
  }

  const size = type === "Баг" ? "" : estimateTaskSize(estimatedCodeLines);
  const blocks =
    releaseHistory && type === "История"
      ? buildReleaseStoryTemplate({
          releaseDate: input.releaseDate,
          changes: input.changes,
        })
      : releaseHistory && type === "Эпик"
        ? []
      : buildTaskTemplate({
          ...input,
          type,
          description,
          parentId: parentPage?.id || "",
          storyId: storyPage?.id || "",
          discoveredReleaseId: discoveredReleasePage?.id || "",
          businessRequirementIds: resolvedBusinessRequirementIds,
          technicalDebtContext,
        });
  const duplicate = pages.filter(
    (page) =>
      pageTaskType(page, schema) === type &&
      sameParent(page, schema, parentPage?.id || "") &&
      (releaseHistory && type === "История"
        ? input.releaseSetId
          ? richTextValue(page.properties?.["Набор релиза"]?.rich_text || []) === input.releaseSetId
          : pageReleaseDate(page, schema) === input.releaseDate
        : pageTitle(page, schema.titleName) === resolvedTitle),
  );
  if (duplicate.length > 1) {
    throw new TaskNotionError(
      "CREATE_AMBIGUOUS",
      `Найдено несколько страниц «${resolvedTitle}» с тем же типом и родителем`,
      { external: true },
    );
  }
  let created = duplicate[0];
  let resumed = false;
  if (created) {
    resumed = true;
    await appendMissingBlocks(client, created.id, blocks);
  } else {
    created = await client.request("/pages", {
      method: "POST",
      body: {
        parent: { type: "data_source_id", data_source_id: source.id },
        icon: randomPageIcon(),
        properties: { ...pagePropertiesForCreate(schema, {
          title: resolvedTitle,
          type,
          priority: storedPriority,
          size,
          parentId: parentPage?.id || "",
          releaseDate: releaseHistory ? input.releaseDate : "",
          discoveredReleaseId: discoveredReleasePage?.id || "",
          technicalDebt,
        }), ...(releaseHistory && input.releaseSetId ? {
          "Набор релиза": { rich_text: [textObject(input.releaseSetId)] },
          "Манифест публикации": { rich_text: [textObject(input.publicationIntent || "")] },
        } : {}) },
        children: blocks,
      },
    });
    if (!created?.id) {
      throw new TaskNotionError(
        "PAGE_CREATE_FAILED",
        "Notion не вернул ID созданной задачи",
        { external: true },
      );
    }
  }
  if (
    releaseHistory &&
    type === "История" &&
    (pageReleaseDate(created, schema) !== input.releaseDate ||
      pageTitle(created, schema.titleName) !== resolvedTitle)
  ) {
    await client.request(`/pages/${created.id}`, {
      method: "PATCH",
      body: {
        properties: {
          [schema.releaseDateName]: { date: { start: input.releaseDate } },
          [schema.titleName]: { title: [textObject(resolvedTitle)] },
        },
      },
    });
  }
  if (pageReleaseProcess(created, schema) !== RELEASE_PROCESS_V1) {
    const releaseProcess = { select: { name: RELEASE_PROCESS_V1 } };
    await client.request(`/pages/${created.id}`, {
      method: "PATCH",
      body: {
        properties: {
          [schema.releaseProcessName]: releaseProcess,
        },
      },
    });
    created.properties[schema.releaseProcessName] = releaseProcess;
  }
  if (
    technicalDebt &&
    !pageTechnicalDebt(created, schema)
  ) {
    await client.request(`/pages/${created.id}`, {
      method: "PATCH",
      body: {
        properties: {
          [schema.technicalDebtName]: { checkbox: true },
        },
      },
    });
  }
  const discoveredReleaseIds = pageReleaseBugIds(created, schema);
  const targetDiscoveredReleaseIds = discoveredReleasePage
    ? [discoveredReleasePage.id]
    : [];
  if (
    JSON.stringify(discoveredReleaseIds) !==
    JSON.stringify(targetDiscoveredReleaseIds)
  ) {
    await client.request(`/pages/${created.id}`, {
      method: "PATCH",
      body: {
        properties: {
          [schema.releaseBugName]: {
            relation: targetDiscoveredReleaseIds.map((id) => ({ id })),
          },
        },
      },
    });
  }
  let attachmentUploaded = false;
  if (attachmentPath) {
    const currentBlocks = await listAllChildren(client, created.id);
    if (!currentBlocks.some((item) => item.type === "image")) {
      if (typeof client.uploadFile !== "function") {
        throw new TaskNotionError(
          "FILE_UPLOAD_UNAVAILABLE",
          "Клиент Notion не поддерживает загрузку файла",
        );
      }
      const uploadId = await client.uploadFile(attachmentPath);
      await client.request(`/blocks/${created.id}/children`, {
        method: "PATCH",
        body: {
          children: [
            {
              object: "block",
              type: "image",
              image: { type: "file_upload", file_upload: { id: uploadId } },
            },
          ],
        },
      });
      attachmentUploaded = true;
    }
  }
  return {
    page: created,
    schema,
    source,
    type,
    priority: storedPriority,
    prioritySource: priorityResult.source,
    size,
    releaseProcess: RELEASE_PROCESS_V1,
    parentId: parentPage?.id || "",
    storyId: storyPage?.id || "",
    resumed,
    attachmentUploaded,
  };
}

export async function backfillReleaseProcessV1(
  client,
  config,
  code,
  { approved = false } = {},
) {
  if (!approved) {
    throw new TaskNotionError(
      "APPROVAL_REQUIRED",
      "Рекурсивный backfill release-процесса требует --approved",
    );
  }
  const { source, schema } = await inspectBacklogWorkspace(client, config, {
    requireTyped: true,
  });
  const pages = await queryAllPages(client, source.id);
  const selected = selectTaskPage(pages, schema, code);
  const snapshot = buildTaskHierarchySnapshot(pages, schema);
  const subtree = [];
  const queue = [selected.page];
  const visited = new Set();

  while (queue.length) {
    const page = queue.shift();
    if (visited.has(page.id)) {
      throw new TaskNotionError(
        "TASK_HIERARCHY_AMBIGUOUS",
        "Выбранная иерархия содержит цикл либо элемент с несколькими родителями",
        { external: true },
      );
    }
    visited.add(page.id);
    const parentIds = snapshot.parentIdsByPageId.get(page.id) || [];
    if (parentIds.length > 1) {
      throw new TaskNotionError(
        "TASK_HIERARCHY_AMBIGUOUS",
        `У элемента ${pageTaskCode(page, schema.idName) || page.id} несколько родителей`,
        { external: true },
      );
    }
    const type = pageTaskType(page, schema);
    if (!TASK_TYPES.includes(type)) {
      throw new TaskNotionError(
        "TASK_TYPE_REQUIRED",
        `У элемента ${pageTaskCode(page, schema.idName) || page.id} отсутствует допустимый тип`,
        { external: true },
      );
    }
    subtree.push(page);
    const children = [
      ...(snapshot.directChildrenByParentId.get(page.id) || []),
    ].sort((left, right) =>
      pageTaskCode(left, schema.idName).localeCompare(
        pageTaskCode(right, schema.idName),
        "ru",
        { numeric: true },
      ),
    );
    queue.push(...children);
  }

  const pending = subtree.filter(
    (page) => pageReleaseProcess(page, schema) !== RELEASE_PROCESS_V1,
  );
  for (const page of pending) {
    await client.request(`/pages/${page.id}`, {
      method: "PATCH",
      body: {
        properties: {
          [schema.releaseProcessName]: {
            select: { name: RELEASE_PROCESS_V1 },
          },
        },
      },
    });
  }

  return {
    rootCode: pageTaskCode(selected.page, schema.idName),
    total: subtree.length,
    changed: pending.length,
    unchanged: subtree.length - pending.length,
    changedCodes: pending.map((page) => pageTaskCode(page, schema.idName)),
  };
}

export function buildReleaseRelationPlan(
  pages,
  schema,
  releasePage,
  taskCodes = [],
) {
  if (
    pageTaskType(releasePage, schema) !== "История" ||
    !pageReleaseDate(releasePage, schema)
  ) {
    throw new TaskNotionError(
      "RELEASE_STORY_REQUIRED",
      "Для связи задач нужна release-история с датой релиза",
    );
  }
  const snapshot = buildTaskHierarchySnapshot(pages, schema);
  const storyCandidates = new Map();
  const bugCandidates = new Map();
  const excluded = [];
  for (const code of [...new Set(taskCodes.map((item) => String(item).toUpperCase()))]) {
    const page = selectTaskPage(pages, schema, code).page;
    const type = pageTaskType(page, schema);
    const status = pageStatus(page, schema);
    if (!type) {
      excluded.push({
        code,
        title: pageTitle(page, schema.titleName),
        status,
        reason: "legacy-untyped",
      });
      continue;
    }
    if (type === "Эпик") {
      throw new TaskNotionError(
        "RELEASE_EPIC_COMMIT_FORBIDDEN",
        `Коммит ${code} не может относиться к эпику`,
        { external: true },
      );
    }
    if (type === "Подзадача") {
      throw new TaskNotionError(
        "RELEASE_SUBTASK_COMMIT_FORBIDDEN",
        `Подзадача ${code} не должна иметь отдельный коммит: используй код родительской задачи`,
        { external: true },
      );
    }
    if (type === "Баг") {
      if (status !== "Закрыто") {
        throw new TaskNotionError(
          "RELEASE_UNCLOSED_BUG",
          `В Git diff найден незакрытый баг ${code} со статусом «${status || "не задан"}»`,
          { external: true },
        );
      }
      bugCandidates.set(page.id, page);
      continue;
    }
    if (type === "История") {
      throw new TaskNotionError(
        "RELEASE_STORY_COMMIT_FORBIDDEN",
        `Коммит ${code} не может относиться к истории: используй ID задачи или бага`,
        { external: true },
      );
    }
    if (type !== "Задача") {
      throw new TaskNotionError(
        "RELEASE_COMMIT_TYPE_INVALID",
        `Коммит ${code} относится к недопустимому типу «${type}»`,
        { external: true },
      );
    }
    if (status !== "Закрыто") {
      throw new TaskNotionError(
        "RELEASE_UNCLOSED_TASK",
        `В Git diff найдена незакрытая задача ${code} со статусом «${status || "не задан"}»`,
        { external: true },
      );
    }
    const story = pageAncestorOfType(page, "История", snapshot, schema);
    if (!story) {
      throw new TaskNotionError(
        "RELEASE_STORY_NOT_FOUND",
        `Для задачи ${code} не найдена родительская история`,
        { external: true },
      );
    }
    const storyStatus = pageStatus(story, schema);
    if (storyStatus !== "Закрыто") {
      throw new TaskNotionError(
        "RELEASE_UNCLOSED_STORY",
        `В Git diff есть работа по незакрытой истории ${pageTaskCode(story, schema.idName) || story.id} со статусом «${storyStatus || "не задан"}». Уточни у оператора причину и допустимость коммита`,
        { external: true },
      );
    }
    storyCandidates.set(story.id, story);
  }

  const representedStoryIds = new Set(storyCandidates.keys());
  const selectedById = new Map();
  for (const story of storyCandidates.values()) {
    const epic = pageAncestorOfType(story, "Эпик", snapshot, schema);
    const visible = epic && pageStatus(epic, schema) === "Закрыто" ? epic : story;
    assertNoOpenDescendantBugs(visible, snapshot, schema);
    selectedById.set(visible.id, visible);
  }
  for (const bug of bugCandidates.values()) {
    const parentIds = snapshot.parentIdsByPageId.get(bug.id) || [];
    const directStory =
      parentIds.length === 1 &&
      pageTaskType(snapshot.pagesById.get(parentIds[0]), schema) === "История"
        ? snapshot.pagesById.get(parentIds[0])
        : null;
    if (directStory && representedStoryIds.has(directStory.id)) continue;
    selectedById.set(bug.id, bug);
  }
  const selected = [...selectedById.values()];

  for (const page of pages) {
    const releaseIds = pageReleaseIds(page, schema);
    const type = pageTaskType(page, schema);
    if (type !== "Эпик" && releaseIds.length > 1) {
      throw new TaskNotionError(
        "MULTIPLE_RELEASES",
        `Элемент ${pageTaskCode(page, schema.idName) || page.id} связан с несколькими релизами`,
        { external: true },
      );
    }
    if (["Задача", "Подзадача"].includes(type) && releaseIds.length) {
      throw new TaskNotionError(
        "TASK_RELEASE_RELATION_FORBIDDEN",
        `Relation «Релиз» допустим только для отображаемых эпиков, историй и багов; найден у ${pageTaskCode(page, schema.idName) || page.id}`,
        { external: true },
      );
    }
  }
  const selectedIds = new Set(selected.map((page) => page.id));
  const conflicting = selected.find((page) => {
    if (pageTaskType(page, schema) === "Эпик") return false;
    const releaseIds = pageReleaseIds(page, schema);
    return releaseIds.length === 1 && releaseIds[0] !== releasePage.id;
  });
  if (conflicting) {
    throw new TaskNotionError(
      "TASK_RELEASE_CONFLICT",
      `Элемент ${pageTaskCode(conflicting, schema.idName) || conflicting.id} уже относится к другому релизу`,
      { external: true },
    );
  }
  const affected = pages.filter(
    (page) =>
      selectedIds.has(page.id) || pageReleaseIds(page, schema).includes(releasePage.id),
  );
  const updates = affected
    .map((page) => {
      const currentIds = pageReleaseIds(page, schema);
      const targetIds = selectedIds.has(page.id)
        ? pageTaskType(page, schema) === "Эпик"
          ? [...new Set([...currentIds, releasePage.id])]
          : [releasePage.id]
        : currentIds.filter((id) => id !== releasePage.id);
      return JSON.stringify(currentIds) === JSON.stringify(targetIds)
        ? null
        : { pageId: page.id, targetIds };
    })
    .filter(Boolean);
  return {
    releasePageId: releasePage.id,
    selected: selected.map((page) => ({
      code: pageTaskCode(page, schema.idName),
      title: pageTitle(page, schema.titleName),
      type: pageTaskType(page, schema),
      status: pageStatus(page, schema),
    })),
    excluded,
    updates,
  };
}

export async function syncReleaseTaskRelations(
  client,
  config,
  releaseCode,
  taskCodes = [],
) {
  const { source, schema } = await inspectBacklogWorkspace(client, config, {
    requireTyped: true,
  });
  const pages = await queryAllPages(client, source.id);
  const releasePage = selectTaskPage(pages, schema, releaseCode).page;
  const views = await ensureReleaseViews(client, config, {
    source,
    schema,
    releasePage,
  });
  const plan = buildReleaseRelationPlan(pages, schema, releasePage, taskCodes);
  for (const update of plan.updates) {
    await client.request(`/pages/${update.pageId}`, {
      method: "PATCH",
      body: {
        properties: {
          [schema.releaseName]: {
            relation: update.targetIds.map((id) => ({ id })),
          },
        },
      },
    });
  }
  return { ...plan, views };
}

export function releaseIncomingViewBody(sourceId, schema, releasePageId) {
  return {
    data_source_id: sourceId,
    name: "Входящие задачи",
    type: "table",
    filter: {
      property: schema.releaseName,
      relation: { contains: releasePageId },
    },
    configuration: {
      type: "table",
      properties: [
        { property_id: schema.idName, visible: true, width: 140 },
        { property_id: schema.titleName, visible: true, width: 420 },
        { property_id: schema.statusName, visible: true, width: 180 },
      ],
      wrap_cells: true,
    },
  };
}

export function releaseHistoryViewBody(sourceId, schema) {
  return {
    data_source_id: sourceId,
    name: "Релизы",
    type: "table",
    filter: {
      property: schema.releaseDateName,
      date: { is_not_empty: true },
    },
    sorts: [
      { property: schema.releaseDateName, direction: "descending" },
    ],
    configuration: {
      type: "table",
      properties: [
        { property_id: schema.titleName, visible: true, width: 420 },
        { property_id: schema.releaseDateName, visible: true, width: 180 },
      ],
      wrap_cells: true,
    },
  };
}

async function findLinkedView(client, parentPageId, name) {
  const children = await listAllChildren(client, parentPageId);
  const databases = children.filter((item) => item.type === "child_database");
  const matches = [];
  for (const database of databases) {
    const listed = await client.request(
      `/views?database_id=${encodeURIComponent(database.id)}&page_size=100`,
    );
    for (const reference of listed.results || []) {
      const view = await client.request(`/views/${reference.id}`);
      if (view.name === name) matches.push(view);
    }
  }
  if (matches.length > 1) {
    throw new TaskNotionError(
      "RELEASE_VIEW_AMBIGUOUS",
      `На странице найдено несколько представлений «${name}»`,
      { external: true },
    );
  }
  return matches[0] || null;
}

function viewPropertyMatches(reference, propertyName, source) {
  const propertyId = source?.metadata?.properties?.[propertyName]?.id || "";
  return (
    reference === propertyName ||
    reference === propertyId ||
    reference?.property_name === propertyName ||
    reference?.property_id === propertyName ||
    reference?.property_id === propertyId
  );
}

function visibleViewProperties(view) {
  return (view?.configuration?.properties || []).filter(
    (item) => item.visible !== false,
  );
}

export async function validateReleaseViews(
  client,
  { source, schema, releasePage, historyPage },
) {
  const incoming = await findLinkedView(client, releasePage.id, "Входящие задачи");
  if (
    !incoming ||
    incoming.data_source_id !== source.id ||
    !viewPropertyMatches(incoming.filter?.property, schema.releaseName, source) ||
    incoming.filter?.relation?.contains !== releasePage.id
  ) {
    throw new TaskNotionError(
      "RELEASE_INCOMING_VIEW_INVALID",
      "В release-истории отсутствует корректный динамический view «Входящие задачи»",
      { external: true },
    );
  }
  const incomingProperties = visibleViewProperties(incoming);
  const requiredIncoming = [schema.idName, schema.titleName, schema.statusName];
  if (
    requiredIncoming.length !== incomingProperties.length ||
    requiredIncoming.some(
      (name, index) => !viewPropertyMatches(incomingProperties[index], name, source),
    )
  ) {
    throw new TaskNotionError(
      "RELEASE_INCOMING_COLUMNS_INVALID",
      "View «Входящие задачи» должен показывать только ID, Название и Статус",
      { external: true },
    );
  }

  const history = await findLinkedView(client, historyPage.id, "Релизы");
  if (
    !history ||
    history.data_source_id !== source.id ||
    !viewPropertyMatches(history.filter?.property, schema.releaseDateName, source) ||
    history.filter?.date?.is_not_empty !== true ||
    history.sorts?.[0]?.direction !== "descending" ||
    !viewPropertyMatches(history.sorts?.[0]?.property, schema.releaseDateName, source)
  ) {
    throw new TaskNotionError(
      "RELEASE_HISTORY_VIEW_INVALID",
      "В бизнес-сущности «История релизов» отсутствует корректный динамический список релизов",
      { external: true },
    );
  }
  const historyProperties = visibleViewProperties(history);
  const requiredHistory = [schema.titleName, schema.releaseDateName];
  if (
    requiredHistory.length !== historyProperties.length ||
    requiredHistory.some(
      (name, index) => !viewPropertyMatches(historyProperties[index], name, source),
    )
  ) {
    throw new TaskNotionError(
      "RELEASE_HISTORY_COLUMNS_INVALID",
      "View «Релизы» должен показывать только название и дату релиза",
      { external: true },
    );
  }
  return { incoming, history };
}

async function ensureLinkedTableView(client, parentPageId, body) {
  const existing = await findLinkedView(client, parentPageId, body.name);
  if (existing) {
    const { name, filter, sorts, configuration } = body;
    const view = await client.request(`/views/${existing.id}`, {
      method: "PATCH",
      body: { name, filter, sorts: sorts || [], configuration },
    });
    return { id: view.id || existing.id, created: false };
  }
  const view = await client.request("/views", {
    method: "POST",
    body: {
      ...body,
      create_database: {
        parent: { type: "page_id", page_id: parentPageId },
      },
    },
  });
  if (!view?.id) {
    throw new TaskNotionError(
      "RELEASE_VIEW_CREATE_FAILED",
      `Notion не вернул ID представления «${body.name}»`,
      { external: true },
    );
  }
  return { id: view.id, created: true };
}

export async function ensureReleaseViews(
  client,
  config,
  { source, schema, releasePage } = {},
) {
  const business = await inspectBusinessRequirements(client, config);
  const historyItems = business.items.filter(
    (item) => item.title === "История релизов",
  );
  if (historyItems.length !== 1) {
    throw new TaskNotionError(
      "RELEASE_HISTORY_BUSINESS_AMBIGUOUS",
      "В базе должна быть ровно одна бизнес-сущность «История релизов»",
      { external: true },
    );
  }
  const incoming = await ensureLinkedTableView(
    client,
    releasePage.id,
    releaseIncomingViewBody(source.id, schema, releasePage.id),
  );
  const history = await ensureLinkedTableView(
    client,
    historyItems[0].id,
    releaseHistoryViewBody(source.id, schema),
  );
  return { incoming, history };
}

function businessPageProperties(schema, title, parentId) {
  const properties = {
    [schema.titleName]: { title: [textObject(title)] },
  };
  if (parentId) properties[schema.parentName] = { relation: [{ id: parentId }] };
  return properties;
}

export async function createBusinessRequirement(
  client,
  config,
  {
    title,
    description,
    parentId = "",
    snapshotFingerprint = "",
  } = {},
) {
  if (!String(title || "").trim())
    throw new TaskNotionError("TITLE_REQUIRED", "Укажи название бизнес-требования");
  assertBusinessRequirementIndependent(title, description);
  const blocks =
    title === "История релизов"
      ? buildReleaseHistoryBusinessTemplate({ description })
      : descriptionBlocks(description);
  const snapshot = await inspectBusinessRequirements(client, config);
  if (!snapshotFingerprint) {
    throw new TaskNotionError(
      "BUSINESS_PREFLIGHT_REQUIRED",
      "Перед созданием нужен fingerprint полного снимка бизнес-требований",
    );
  }
  if (snapshot.snapshotFingerprint !== snapshotFingerprint) {
    throw new TaskNotionError(
      "BUSINESS_SNAPSHOT_CONFLICT",
      "Бизнес-требования изменились после смыслового preflight",
      { external: true },
    );
  }
  if (parentId) {
    const resolvedParentId = resolvePageId(
      snapshot.hierarchy.pagesById,
      parentId,
    );
    const parent = snapshot.hierarchy.pagesById.get(resolvedParentId);
    if (!parent) {
      throw new TaskNotionError(
        "PARENT_NOT_FOUND",
        `Родительское бизнес-требование ${parentId} недоступно`,
        { external: true },
      );
    }
    if (
      (snapshot.hierarchy.parentIdsByPageId.get(resolvedParentId) || []).length
    ) {
      throw new TaskNotionError(
        "BUSINESS_HIERARCHY_TOO_DEEP",
        "Третий уровень бизнес-требований запрещён",
      );
    }
    parentId = resolvedParentId;
  }
  const duplicate = snapshot.pages.filter(
    (page) =>
      pageTitle(page, snapshot.schema.titleName) === title &&
      sameParent(page, snapshot.schema, parentId),
  );
  if (duplicate.length > 1) {
    throw new TaskNotionError(
      "CREATE_AMBIGUOUS",
      `Найдено несколько бизнес-требований «${title}» с тем же родителем`,
      { external: true },
    );
  }
  if (duplicate[0]) {
    await appendMissingBlocks(client, duplicate[0].id, blocks);
    return {
      page: duplicate[0],
      source: snapshot.source,
      schema: snapshot.schema,
      resumed: true,
    };
  }
  const page = await client.request("/pages", {
    method: "POST",
    body: {
      parent: {
        type: "data_source_id",
        data_source_id: snapshot.source.id,
      },
      icon: randomPageIcon(),
      properties: businessPageProperties(snapshot.schema, title, parentId),
      children: blocks,
    },
  });
  if (!page?.id) {
    throw new TaskNotionError(
      "PAGE_CREATE_FAILED",
      "Notion не вернул ID бизнес-требования",
      { external: true },
    );
  }
  return {
    page,
    source: snapshot.source,
    schema: snapshot.schema,
    resumed: false,
  };
}

export async function validateTaskBusinessMentions(
  client,
  config,
  taskPage,
  { required = true } = {},
) {
  const [blocks, business] = await Promise.all([
    readBlockTree(client, taskPage.id),
    inspectBusinessRequirements(client, config),
  ]);
  const mentions = [
    ...new Set(
      blocks.flatMap(function collect(item) {
        return [
          ...blockPageMentions(item),
          ...(item.children || []).flatMap(collect),
        ];
      }),
    ),
  ];
  const businessIds = mentions.filter((id) =>
    business.hierarchy.pagesById.has(id),
  );
  if (required && !businessIds.length) {
    throw new TaskNotionError(
      "BUSINESS_MENTION_REQUIRED",
      "В странице нет доступного упоминания бизнес-требования",
      { external: true },
    );
  }
  return { blocks, business, mentions, businessIds };
}

export async function updateMasterSpecification(
  client,
  config,
  pageId,
  { markdown, expectedFingerprint } = {},
) {
  if (!String(markdown || "").trim()) {
    throw new TaskNotionError(
      "MASTER_SPEC_EMPTY",
      "Мастер-спецификация не может быть пустой",
    );
  }
  assertBusinessRequirementIndependent(markdown);
  const business = await inspectBusinessRequirements(client, config);
  const resolvedPageId = resolvePageId(business.hierarchy.pagesById, pageId);
  if (!resolvedPageId) {
    throw new TaskNotionError(
      "BUSINESS_REQUIREMENT_NOT_FOUND",
      `Страница ${pageId} не относится к базе бизнес-требований`,
      { external: true },
    );
  }
  pageId = resolvedPageId;
  const blocks = await listAllChildren(client, pageId);
  const current = masterSection(blocks);
  if (expectedFingerprint !== current.fingerprint) {
    throw new TaskNotionError(
      "MASTER_FINGERPRINT_CONFLICT",
      "Мастер-спецификация изменилась после чтения",
      { external: true },
    );
  }
  let markerAdded = false;
  const markerBlock = block("paragraph", `**${MASTER_SPEC_MARKER}**`);
  if (current.markerIndex < 0) {
    await client.request(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: {
        children: [dividerBlock(), markerBlock],
      },
    });
    markerAdded = true;
  } else {
    const marker = blocks[current.markerIndex];
    const markerRichText = marker?.paragraph?.rich_text || [];
    if (!markerRichText.some((item) => item?.annotations?.bold)) {
      await client.request(`/blocks/${current.markerId}`, {
        method: "PATCH",
        body: { paragraph: markerBlock.paragraph },
      });
    }
    for (const item of current.content) {
      if (!item.id) {
        throw new TaskNotionError(
          "MASTER_BLOCK_ID_MISSING",
          "Notion не вернул ID блока мастер-спецификации",
          { external: true },
        );
      }
      await client.request(`/blocks/${item.id}`, { method: "DELETE" });
    }
  }
  const nextBlocks = markdownToBlocks(markdown);
  for (let index = 0; index < nextBlocks.length; index += 100) {
    await client.request(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: { children: nextBlocks.slice(index, index + 100) },
    });
  }
  return {
    pageId,
    markerAdded,
    previousFingerprint: current.fingerprint,
    blocks: nextBlocks.length,
  };
}

export async function validateEpicMasterSpecifications(client, config, epicPage) {
  const { businessIds, business } = await validateTaskBusinessMentions(
    client,
    config,
    epicPage,
  );
  const missing = businessIds.filter((id) => {
    const item = business.items.find((candidate) => candidate.id === id);
    if (item?.title === "История релизов") return false;
    return !item?.master?.text?.trim();
  });
  if (missing.length) {
    throw new TaskNotionError(
      "MASTER_SPEC_REQUIRED",
      `Перед завершением эпика нужна мастер-спецификация: ${missing.join(", ")}`,
      { external: true },
    );
  }
  return { businessIds };
}

function isReleaseHistoryPage(page, snapshot, schema) {
  const type = pageTaskType(page, schema);
  return (
    (type === "История" && Boolean(pageReleaseDate(page, schema))) ||
    (type === "Эпик" &&
      (snapshot.directChildrenByParentId.get(page.id) || []).some(
        (child) => pageReleaseDate(child, schema),
      ))
  );
}

async function validateWaitingReleaseEpics(client, config, pages, schema, plan) {
  const snapshot = buildTaskHierarchySnapshot(pages, schema);
  for (const update of plan.updates) {
    if (update.targetStatus !== "Ожидание релиза") continue;
    const page = snapshot.pagesById.get(update.pageId);
    if (
      !page ||
      pageTaskType(page, schema) !== "Эпик" ||
      pageTechnicalDebt(page, schema) ||
      isReleaseHistoryPage(page, snapshot, schema)
    ) {
      continue;
    }
    await validateEpicMasterSpecifications(client, config, page);
  }
}

export async function finalizeStoryBusiness(
  client,
  config,
  code,
  {
    approved = false,
    businessChanged,
    technicalRequirements = [],
    masterUpdates = [],
  } = {},
) {
  if (!approved) {
    throw new TaskNotionError(
      "APPROVAL_REQUIRED",
      "Для бизнес-финализации истории требуется явный флаг --approved",
    );
  }
  if (typeof businessChanged !== "boolean") {
    throw new TaskNotionError(
      "BUSINESS_OUTCOME_REQUIRED",
      "Укажи результат: business changed или business unchanged",
    );
  }
  if (!technicalRequirements.length) {
    throw new TaskNotionError(
      "TECHNICAL_REQUIREMENTS_REQUIRED",
      "Укажи затронутые технические requirements",
    );
  }
  const selected = await findTask(client, config, code);
  if (pageTaskType(selected.page, selected.schema) !== "История") {
    throw new TaskNotionError(
      "STORY_OWNER_REQUIRED",
      "Финализация бизнес-дельты выполняется только для истории",
    );
  }
  const storyStatus = pageStatus(selected.page, selected.schema);
  if (storyStatus !== "Тестирование") {
    throw new TaskNotionError(
      "STORY_NOT_ACCEPTED",
      "Бизнес-финализация разрешена только после приёмки истории в статусе «Тестирование»",
    );
  }
  if (!businessChanged && masterUpdates.length) {
    throw new TaskNotionError(
      "BUSINESS_OUTCOME_CONFLICT",
      "Для business unchanged мастер-спецификация не обновляется",
    );
  }
  if (businessChanged && !masterUpdates.length) {
    throw new TaskNotionError(
      "MASTER_UPDATE_REQUIRED",
      "Для business changed нужен хотя бы один master update",
    );
  }
  if (businessChanged) {
    const { businessIds, business } = await validateTaskBusinessMentions(
      client,
      config,
      selected.page,
    );
    const allowedBusinessIds = new Set(businessIds);
    for (const update of masterUpdates) {
      if (!allowedBusinessIds.has(update.pageId)) {
        throw new TaskNotionError(
          "MASTER_UPDATE_SCOPE_MISMATCH",
          `История не ссылается на бизнес-требование ${update.pageId}`,
          { external: true },
        );
      }
      const item = business.items.find((candidate) => candidate.id === update.pageId);
      if (!item || item.master.fingerprint !== update.expectedFingerprint) {
        throw new TaskNotionError(
          "MASTER_FINGERPRINT_CONFLICT",
          `Бизнес-требование ${update.pageId} изменилось после подготовки финализации`,
          { external: true },
        );
      }
    }
    const applied = [];
    try {
      for (const update of masterUpdates) {
        applied.push(
          await updateMasterSpecification(client, config, update.pageId, update),
        );
      }
    } catch (error) {
      throw new TaskNotionError(
        "STORY_FINALIZATION_PARTIAL",
        "Финализация истории остановлена; завершение не подтверждено",
        { external: true, cause: error },
      );
    }
    return {
      code,
      businessOutcome: "changed",
      technicalRequirements,
      masterUpdates: applied,
    };
  }
  return {
    code,
    businessOutcome: "unchanged",
    technicalRequirements,
    masterUpdates: [],
  };
}

const statusIndex = (status) => STATUS_FLOW.indexOf(status);

function assertKnownStatus(status, page, schema) {
  if (statusIndex(status) >= 0) return;
  const title = pageTitle(page, schema.titleName) || page?.id || "без названия";
  throw new TaskNotionError(
    "UNKNOWN_STATUS",
    `У задачи «${title}» неизвестный статус «${status || "не задан"}»`,
    { external: true },
  );
}

function assertSingleParent(page, snapshot, schema) {
  const parentIds = snapshot.parentIdsByPageId.get(page.id) || [];
  if (parentIds.length <= 1) return parentIds;
  const title = pageTitle(page, schema.titleName) || page.id;
  throw new TaskNotionError(
    "MULTIPLE_PARENTS",
    `У задачи «${title}» найдено несколько родителей`,
    { external: true },
  );
}

export function calculateParentStatus(currentStatus, childStatuses) {
  if (!STATUS_FLOW.includes(currentStatus)) {
    throw new TaskNotionError(
      "UNKNOWN_STATUS",
      `Неизвестный статус родителя «${currentStatus || "не задан"}»`,
      { external: true },
    );
  }
  if (!childStatuses.length) {
    throw new TaskNotionError(
      "PARENT_WITHOUT_CHILDREN",
      "У родительской задачи нет прямых дочерних задач",
      { external: true },
    );
  }
  for (const status of childStatuses) {
    if (!STATUS_FLOW.includes(status)) {
      throw new TaskNotionError(
        "UNKNOWN_STATUS",
        `У дочерней задачи неизвестный статус «${status || "не задан"}»`,
        { external: true },
      );
    }
  }

  if (currentStatus === "Закрыто") return currentStatus;

  const currentIndex = statusIndex(currentStatus);
  const childIndexes = childStatuses.map(statusIndex);
  const earliestChildIndex = Math.min(...childIndexes);
  const allAtLeast = (status) =>
    childIndexes.every((index) => index >= statusIndex(status));

  if (currentStatus === "Ожидание релиза") {
    if (allAtLeast("Ожидание релиза")) return currentStatus;
    return STATUS_FLOW[Math.max(statusIndex("Разработка"), earliestChildIndex)];
  }

  let candidateIndex = currentIndex;
  if (allAtLeast("Ожидание релиза")) {
    candidateIndex = statusIndex("Ожидание релиза");
  } else if (allAtLeast("Тестирование")) {
    candidateIndex = statusIndex("Тестирование");
  } else {
    const furthestChildIndex = Math.max(...childIndexes);
    if (furthestChildIndex >= statusIndex("Аналитика")) {
      candidateIndex = Math.min(statusIndex("Разработка"), furthestChildIndex);
    }
  }

  return STATUS_FLOW[Math.max(currentIndex, candidateIndex)];
}

function statusTransition(
  page,
  schema,
  previousStatus,
  targetStatus,
  isParent,
) {
  return {
    page,
    pageId: page.id,
    title: pageTitle(page, schema.titleName),
    previousStatus,
    targetStatus,
    isParent,
  };
}

export function buildStatusUpdatePlan(
  pages,
  schema,
  selectedPageId,
  targetStatus,
) {
  if (!STATUS_FLOW.includes(targetStatus)) {
    throw new TaskNotionError(
      "INVALID_STATUS",
      `Недопустимый статус «${targetStatus}»`,
    );
  }

  const snapshot = buildTaskHierarchySnapshot(pages, schema);
  const selectedPage = snapshot.pagesById.get(selectedPageId);
  if (!selectedPage) {
    throw new TaskNotionError(
      "TASK_NOT_FOUND",
      `Страница ${selectedPageId} отсутствует в снимке базы Notion`,
      { external: true },
    );
  }

  const selectedPreviousStatus = pageStatus(selectedPage, schema);
  assertKnownStatus(selectedPreviousStatus, selectedPage, schema);
  if (targetStatus === "Ожидание релиза") {
    assertNoOpenDescendantBugs(selectedPage, snapshot, schema);
  }
  const projectedStatuses = new Map([[selectedPage.id, targetStatus]]);
  const updates = [];
  if (selectedPreviousStatus !== targetStatus) {
    updates.push(
      statusTransition(
        selectedPage,
        schema,
        selectedPreviousStatus,
        targetStatus,
        false,
      ),
    );
  }

  const visited = new Set([selectedPage.id]);
  let currentPage = selectedPage;
  while (currentPage) {
    const parentIds = assertSingleParent(currentPage, snapshot, schema);
    if (snapshot.typesByPageId.get(currentPage.id) === "Баг") {
      if (parentIds[0] && visited.has(parentIds[0])) {
        throw new TaskNotionError(
          "PARENT_CYCLE",
          "В иерархии задач Notion найден цикл",
          { external: true },
        );
      }
      if (parentIds[0] && !snapshot.pagesById.has(parentIds[0])) {
        throw new TaskNotionError(
          "PARENT_NOT_FOUND",
          `Родительская страница ${parentIds[0]} отсутствует в снимке базы Notion`,
          { external: true },
        );
      }
      break;
    }
    if (!parentIds.length) {
      const currentType = snapshot.typesByPageId.get(currentPage.id);
      if (currentType) assertAllowedTaskRelation("", currentType);
      break;
    }

    const parentId = parentIds[0];
    if (visited.has(parentId)) {
      throw new TaskNotionError(
        "PARENT_CYCLE",
        "В иерархии задач Notion найден цикл",
        { external: true },
      );
    }
    const parentPage = snapshot.pagesById.get(parentId);
    if (!parentPage) {
      throw new TaskNotionError(
        "PARENT_NOT_FOUND",
        `Родительская страница ${parentId} отсутствует в снимке базы Notion`,
        { external: true },
      );
    }
    visited.add(parentId);
    const currentType = snapshot.typesByPageId.get(currentPage.id);
    const parentType = snapshot.typesByPageId.get(parentPage.id);
    if (currentType && parentType)
      assertAllowedTaskRelation(parentType, currentType);

    const parentPreviousStatus =
      projectedStatuses.get(parentId) || pageStatus(parentPage, schema);
    assertKnownStatus(parentPreviousStatus, parentPage, schema);
    if (parentPreviousStatus === "Закрыто") break;

    const children = (
      snapshot.directChildrenByParentId.get(parentPage.id) || []
    ).filter((childPage) => {
      const childType = snapshot.typesByPageId.get(childPage.id);
      if (childType && parentType)
        assertAllowedTaskRelation(parentType, childType);
      return childType !== "Баг";
    });
    if (!children.length) break;
    const childStatuses = children.map((childPage) => {
      assertSingleParent(childPage, snapshot, schema);
      const childStatus =
        projectedStatuses.get(childPage.id) || pageStatus(childPage, schema);
      assertKnownStatus(childStatus, childPage, schema);
      return childStatus;
    });
    const parentTargetStatus = calculateParentStatus(
      parentPreviousStatus,
      childStatuses,
    );
    if (parentTargetStatus === "Ожидание релиза") {
      assertNoOpenDescendantBugs(parentPage, snapshot, schema);
    }
    projectedStatuses.set(parentPage.id, parentTargetStatus);
    if (parentPreviousStatus !== parentTargetStatus) {
      updates.push(
        statusTransition(
          parentPage,
          schema,
          parentPreviousStatus,
          parentTargetStatus,
          true,
        ),
      );
    }

    currentPage = parentPage;
  }

  return {
    selectedPage,
    selectedPreviousStatus,
    selectedTargetStatus: targetStatus,
    selectedChanged: selectedPreviousStatus !== targetStatus,
    updates,
    parentUpdates: updates.filter((update) => update.isParent),
  };
}

export function pageTaskCode(page, idName) {
  const value = page?.properties?.[idName]?.unique_id;
  if (!value || !Number.isInteger(value.number)) return "";
  return `${value.prefix || ""}-${value.number}`.replace(/^-+/u, "");
}

export function isExactTaskMatch(value, code) {
  return String(value).toUpperCase() === String(code).toUpperCase();
}

export function selectTaskPage(pages, schema, code) {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(code)) {
    throw new TaskNotionError(
      "INVALID_TASK_CODE",
      "Код задачи должен иметь вид CODE-N",
    );
  }
  const matches = pages
    .filter((page) => isExactTaskMatch(pageTaskCode(page, schema.idName), code))
    .map((page) => ({
      page,
      title: pageTitle(page, schema.titleName),
      isChild:
        (page?.properties?.[schema.parentName]?.relation || []).length > 0,
    }));
  const children = matches.filter((candidate) => candidate.isChild);
  if (children.length === 1) return children[0];
  if (children.length > 1) {
    throw new TaskNotionError(
      "TASK_AMBIGUOUS",
      `Найдено несколько дочерних задач ${code}: ${children.map((item) => item.title).join("; ")}`,
      { external: true },
    );
  }
  const roots = matches.filter((candidate) => !candidate.isChild);
  if (roots.length === 1) return roots[0];
  if (roots.length > 1) {
    throw new TaskNotionError(
      "TASK_AMBIGUOUS",
      `Найдено несколько задач ${code}: ${roots.map((item) => item.title).join("; ")}`,
      { external: true },
    );
  }
  throw new TaskNotionError(
    "TASK_NOT_FOUND",
    `Задача ${code} не найдена в «Бэклоге»`,
    {
      external: true,
    },
  );
}

export async function findTask(client, config, code) {
  const { source, schema } = await inspectBacklogWorkspace(client, config);
  const pages = await queryAllPages(client, source.id);
  const selected = selectTaskPage(pages, schema, code);
  return { ...selected, schema, source, pages };
}

export function statusUpdateBody(schema, targetStatus) {
  const value =
    schema.statusType === "status"
      ? { status: { name: targetStatus } }
      : { select: { name: targetStatus } };
  return { properties: { [schema.statusName]: value } };
}

export async function applyStatusUpdatePlan(client, schema, plan) {
  for (const update of plan.updates) {
    await client.request(`/pages/${update.pageId}`, {
      method: "PATCH",
      body: statusUpdateBody(schema, update.targetStatus),
    });
  }
  return plan;
}

export async function updateTaskStatus(
  client,
  config,
  code,
  targetStatus,
  { approved = false } = {},
) {
  if (!ALLOWED_STATUSES.includes(targetStatus)) {
    throw new TaskNotionError(
      "INVALID_STATUS",
      `Недопустимый статус «${targetStatus}». Разрешены: ${ALLOWED_STATUSES.join(", ")}`,
    );
  }
  if (targetStatus === "Ожидание релиза" && !approved) {
    throw new TaskNotionError(
      "APPROVAL_REQUIRED",
      "Для перехода в «Ожидание релиза» требуется явный флаг --approved",
    );
  }
  const selected = await findTask(client, config, code);
  const currentStatus = pageStatus(selected.page, selected.schema);
  if (
    targetStatus === "Ожидание релиза" &&
    !["Тестирование", "Ожидание релиза"].includes(currentStatus)
  ) {
    throw new TaskNotionError(
      "ACCEPTANCE_STATUS_REQUIRED",
      "Переход в «Ожидание релиза» разрешён только из «Тестирования»",
    );
  }
  const plan = buildStatusUpdatePlan(
    selected.pages,
    selected.schema,
    selected.page.id,
    targetStatus,
  );
  if (targetStatus === "Ожидание релиза") {
    await validateWaitingReleaseEpics(
      client,
      config,
      selected.pages,
      selected.schema,
      plan,
    );
  }
  await applyStatusUpdatePlan(client, selected.schema, plan);
  return {
    ...selected,
    previousStatus: plan.selectedPreviousStatus,
    targetStatus,
    changed: plan.selectedChanged,
    parentUpdates: plan.parentUpdates,
  };
}

const defaultAnnotations = Object.freeze({
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
});

const textObject = (content, annotations = {}, link = null) => ({
  type: "text",
  text: { content, link: link ? { url: link } : null },
  annotations: { ...defaultAnnotations, ...annotations },
});

function pushRichText(result, content, annotations = {}, link = null) {
  for (let offset = 0; offset < content.length; offset += 2000) {
    result.push(
      textObject(content.slice(offset, offset + 2000), annotations, link),
    );
  }
}

export function markdownInlineToRichText(content) {
  const value = String(content).replace(/<br\s*\/?\s*>/giu, "\n");
  const items = [];
  const token =
    /(\*\*([^*]+?)\*\*|__([^_]+?)__|`([^`]+?)`|\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)|\*([^*\n]+?)\*|_([^_\n]+?)_)/gu;
  let offset = 0;
  let match;
  while ((match = token.exec(value)) !== null) {
    if (match.index > offset)
      pushRichText(items, value.slice(offset, match.index));
    if (match[2] !== undefined || match[3] !== undefined) {
      pushRichText(items, match[2] ?? match[3], { bold: true });
    } else if (match[4] !== undefined) {
      pushRichText(items, match[4], { code: true });
    } else if (match[5] !== undefined) {
      pushRichText(items, match[5], {}, match[6]);
    } else {
      pushRichText(items, match[7] ?? match[8], { italic: true });
    }
    offset = token.lastIndex;
  }
  if (offset < value.length) pushRichText(items, value.slice(offset));
  return items.length ? items : [textObject("")];
}

const plainRichText = (content) => {
  const result = [];
  pushRichText(result, String(content));
  return result.length ? result : [textObject("")];
};

function block(type, content) {
  return {
    object: "block",
    type,
    [type]: { rich_text: markdownInlineToRichText(content), color: "default" },
  };
}

function paragraphBlocks(text) {
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += 1900) {
    chunks.push(block("paragraph", text.slice(offset, offset + 1900)));
  }
  return chunks.length ? chunks : [block("paragraph", "")];
}

export function markdownToBlocks(markdown) {
  const lines = String(markdown).replace(/\r\n/gu, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let code = [];
  let inCode = false;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(...paragraphBlocks(paragraph.join("\n")));
    paragraph = [];
  };
  const flushCode = () => {
    const content = code.join("\n");
    for (let offset = 0; offset < Math.max(content.length, 1); offset += 1900) {
      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: plainRichText(content.slice(offset, offset + 1900)),
          language: "plain text",
          caption: [],
        },
      });
    }
    code = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) flushCode();
      else flushParagraph();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/u);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/u);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/u);
    const quote = line.match(/^>\s?(.+)$/u);
    if (heading) {
      flushParagraph();
      blocks.push(
        block(`heading_${Math.min(heading[1].length, 3)}`, heading[2]),
      );
    } else if (task) {
      flushParagraph();
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: markdownInlineToRichText(task[2]),
          checked: task[1].toLowerCase() === "x",
          color: "default",
        },
      });
    } else if (/^\s*([-*_])\1\1+\s*$/u.test(line)) {
      flushParagraph();
      blocks.push({ object: "block", type: "divider", divider: {} });
    } else if (bullet) {
      flushParagraph();
      blocks.push(block("bulleted_list_item", bullet[1]));
    } else if (numbered) {
      flushParagraph();
      blocks.push(block("numbered_list_item", numbered[1]));
    } else if (quote) {
      flushParagraph();
      blocks.push(block("quote", quote[1]));
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  if (inCode) flushCode();
  flushParagraph();
  return blocks;
}

export async function listAllChildren(client, blockId) {
  const children = [];
  let cursor;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const result = await client.request(`/blocks/${blockId}/children?${query}`);
    children.push(...(result.results || []));
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  return children;
}

function toggleTitle(item) {
  return item?.type === "toggle"
    ? richTextValue(item.toggle?.rich_text || [])
    : "";
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findChangeRoot(specPath) {
  let current = dirname(resolve(specPath));
  while (true) {
    if (await fileExists(join(current, ".openspec.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return dirname(resolve(specPath));
    current = parent;
  }
}

async function collectMarkdownFiles(directory) {
  if (!(await fileExists(directory))) return [];
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collectMarkdownFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(path);
  }
  return result;
}

export async function loadOpenSpecDocuments(specPath) {
  if (!specPath)
    throw new TaskNotionError(
      "SPEC_PATH_REQUIRED",
      "Укажи итоговый spec через --spec",
    );
  const requiredPath = resolve(specPath);
  let requiredMarkdown;
  try {
    requiredMarkdown = await readFile(requiredPath, "utf8");
  } catch (error) {
    throw new TaskNotionError(
      "SPEC_READ_FAILED",
      `Не удалось прочитать spec: ${specPath}`,
      { cause: error },
    );
  }
  if (!requiredMarkdown.trim())
    throw new TaskNotionError("SPEC_EMPTY", "Итоговый spec пуст");

  const root = await findChangeRoot(requiredPath);
  const candidates = [
    join(root, "proposal.md"),
    join(root, "design.md"),
    join(root, "tasks.md"),
    ...(await collectMarkdownFiles(join(root, "specs"))).sort(),
  ];
  if (!candidates.includes(requiredPath)) candidates.push(requiredPath);

  const documents = [];
  for (const path of [...new Set(candidates)]) {
    if (!(await fileExists(path))) continue;
    const markdown =
      path === requiredPath ? requiredMarkdown : await readFile(path, "utf8");
    if (!markdown.trim()) continue;
    documents.push({
      path,
      label: relative(root, path) || "spec.md",
      markdown,
    });
  }
  return documents;
}

export async function loadPlanningDocuments(changePath) {
  if (!changePath) {
    throw new TaskNotionError(
      "CHANGE_PATH_REQUIRED",
      "Укажи каталог OpenSpec change через --change",
    );
  }
  const resolvedPath = resolve(changePath);
  let info;
  try {
    info = await stat(resolvedPath);
  } catch (error) {
    throw new TaskNotionError(
      "CHANGE_READ_FAILED",
      `Не удалось прочитать change: ${changePath}`,
      { cause: error },
    );
  }
  const root = info.isDirectory()
    ? resolvedPath
    : await findChangeRoot(resolvedPath);
  const candidates = [
    join(root, "proposal.md"),
    join(root, "design.md"),
    join(root, "tasks.md"),
    ...(await collectMarkdownFiles(join(root, "specs"))).sort(),
  ];
  const documents = [];
  for (const path of candidates) {
    if (!(await fileExists(path))) continue;
    const markdown = await readFile(path, "utf8");
    if (!markdown.trim()) continue;
    documents.push({
      path,
      label: relative(root, path),
      markdown,
    });
  }
  if (!documents.length) {
    throw new TaskNotionError(
      "CHANGE_EMPTY",
      "В OpenSpec change нет плановых Markdown-документов",
    );
  }
  return documents;
}

export function assertOpenSpecLinkage(documents, code) {
  const proposal = documents.find((document) => document.label === "proposal.md");
  if (!proposal) {
    throw new TaskNotionError(
      "PROPOSAL_REQUIRED",
      "Для публикации OpenSpec нужен proposal.md",
    );
  }
  const firstLine = proposal.markdown.split(/\r?\n/u).find((line) => line.trim());
  if (firstLine?.trim() !== `Task: ${String(code).toUpperCase()}`) {
    throw new TaskNotionError(
      "OPENSPEC_LINKAGE_MISMATCH",
      `Первая содержательная строка proposal.md должна быть «Task: ${String(code).toUpperCase()}»`,
    );
  }
  return true;
}

export function assertOpenSpecBusinessLinkage(documents, businessIds) {
  const allowedIds = new Set(businessIds.map(normalizeNotionId));
  const specs = documents.filter((document) => /^specs\/.+\/spec\.md$/u.test(document.label));
  if (!specs.length) {
    throw new TaskNotionError(
      "DELTA_SPEC_REQUIRED",
      "Для обычной истории нужна хотя бы одна delta-спецификация",
    );
  }
  for (const document of specs) {
    const declaration = document.markdown.match(
      /^Business requirements:\s*(.+?)\s*$/mu,
    )?.[1];
    const linkedIds = (declaration?.match(/[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/giu) || [])
      .map(normalizeNotionId);
    if (!linkedIds.length || linkedIds.some((id) => !allowedIds.has(id))) {
      throw new TaskNotionError(
        "OPENSPEC_BUSINESS_LINKAGE_MISMATCH",
        `Delta-спецификация ${document.label} должна явно ссылаться на бизнес-требование истории строкой «Business requirements: ...»`,
      );
    }
  }
  return true;
}

export function openSpecDocumentTitle(document) {
  if (document.label === "proposal.md") return "Предложения";
  if (document.label === "design.md") return "Дизайн архитектуры";
  if (document.label === "tasks.md") return "Задачи";
  if (/^specs\//u.test(document.label)) {
    const requirement = document.markdown.match(
      /^### Requirement:\s*(.+?)\s*$/mu,
    )?.[1];
    const fallback = document.label
      .replace(/^specs\//u, "")
      .replace(/\/spec\.md$/u, "")
      .replace(/[-_]+/gu, " ");
    return `Спецификация · ${requirement || fallback}`;
  }
  return `Документ · ${document.label}`;
}

function isOpenSpecDocumentTitle(title) {
  return (
    title === "Предложения" ||
    title === "Дизайн архитектуры" ||
    title === "Задачи" ||
    title.startsWith("Спецификация · ")
  );
}

function isOpenSpecGroupTitle(title) {
  return title.startsWith(OPEN_SPEC_GROUP_PREFIX);
}

function isManagedDocumentTitle(title) {
  return isOpenSpecDocumentTitle(title) || isOpenSpecGroupTitle(title);
}

function titledOpenSpecDocuments(documents) {
  const titledDocuments = documents.map((document) => ({
    ...document,
    title: openSpecDocumentTitle(document),
  }));
  const generatedTitles = titledDocuments.map((document) => document.title);
  if (new Set(generatedTitles).size !== generatedTitles.length) {
    throw new TaskNotionError(
      "DOCUMENT_TITLE_AMBIGUOUS",
      "Несколько OpenSpec-документов получили одинаковое название dropdown",
    );
  }
  return titledDocuments;
}

function managedOpenSpecBlocks(existing, code) {
  const legacyTitle = `${MANAGED_SPEC_PREFIX}${code}`;
  const managed = existing.filter((item) => {
    const title = toggleTitle(item);
    return title === legacyTitle || isManagedDocumentTitle(title);
  });
  const counts = new Map();
  for (const item of managed) {
    const title = toggleTitle(item);
    counts.set(title, (counts.get(title) || 0) + 1);
  }
  const duplicate = [...counts.entries()].find(([, count]) => count > 1);
  if (duplicate) {
    throw new TaskNotionError(
      "SPEC_BLOCK_AMBIGUOUS",
      `В задаче найдено несколько блоков «${duplicate[0]}»`,
      { external: true },
    );
  }
  return managed;
}

async function createOpenSpecToggle(client, parentId, title) {
  const created = await client.request(`/blocks/${parentId}/children`, {
    method: "PATCH",
    body: {
      children: [
        {
          object: "block",
          type: "toggle",
          toggle: {
            rich_text: plainRichText(title),
            color: "default",
          },
        },
      ],
    },
  });
  const toggle = created.results?.[0];
  if (!toggle?.id) {
    throw new TaskNotionError(
      "SPEC_BLOCK_CREATE_FAILED",
      `Notion не вернул ID блока «${title}»`,
      { external: true },
    );
  }
  return toggle;
}

async function appendOpenSpecMarkdown(client, toggleId, markdown) {
  const blocks = markdownToBlocks(markdown);
  for (let index = 0; index < blocks.length; index += 100) {
    await client.request(`/blocks/${toggleId}/children`, {
      method: "PATCH",
      body: { children: blocks.slice(index, index + 100) },
    });
  }
  return blocks.length;
}

async function publishManagedBlocks(client, pageId, code, blocks) {
  const title = `${MANAGED_SPEC_PREFIX}${code}`;
  const existing = (await listAllChildren(client, pageId)).filter(
    (item) => toggleTitle(item) === title,
  );
  if (existing.length > 1) {
    throw new TaskNotionError(
      "SPEC_BLOCK_AMBIGUOUS",
      `В задаче найдено несколько блоков «${title}»`,
      { external: true },
    );
  }
  if (existing.length === 1) {
    await client.request(`/blocks/${existing[0].id}`, { method: "DELETE" });
  }
  const created = await client.request(`/blocks/${pageId}/children`, {
    method: "PATCH",
    body: {
      children: [
        {
          object: "block",
          type: "toggle",
          toggle: { rich_text: plainRichText(title), color: "default" },
        },
      ],
    },
  });
  const toggle =
    created.results?.find((item) => toggleTitle(item) === title) ||
    created.results?.[0];
  if (!toggle?.id) {
    throw new TaskNotionError(
      "SPEC_BLOCK_CREATE_FAILED",
      "Notion не вернул ID блока spec",
      {
        external: true,
      },
    );
  }
  for (let index = 0; index < blocks.length; index += 100) {
    await client.request(`/blocks/${toggle.id}/children`, {
      method: "PATCH",
      body: { children: blocks.slice(index, index + 100) },
    });
  }
  return {
    blockId: toggle.id,
    replaced: existing.length === 1,
    blocks: blocks.length,
  };
}

export async function publishManagedSpec(client, pageId, code, markdown) {
  return publishManagedBlocks(client, pageId, code, markdownToBlocks(markdown));
}

export async function publishManagedDocuments(client, pageId, code, documents) {
  const titledDocuments = titledOpenSpecDocuments(documents);
  const existing = await listAllChildren(client, pageId);
  const managed = managedOpenSpecBlocks(existing, code);
  for (const item of managed) {
    await client.request(`/blocks/${item.id}`, { method: "DELETE" });
  }

  const blockIds = [];
  let blockCount = 0;
  for (const document of titledDocuments) {
    const toggle = await createOpenSpecToggle(client, pageId, document.title);
    blockIds.push(toggle.id);
    blockCount += await appendOpenSpecMarkdown(
      client,
      toggle.id,
      document.markdown,
    );
  }
  return {
    blockIds,
    replaced: managed.length > 0,
    blocks: blockCount,
    documents: titledDocuments.length,
  };
}

export async function publishManagedDocumentGroups(
  client,
  pageId,
  code,
  groups,
) {
  if (!groups.length) {
    throw new TaskNotionError(
      "CHANGE_PATH_REQUIRED",
      "Укажи хотя бы один каталог OpenSpec change через --change",
    );
  }
  const preparedGroups = groups.map((group) => {
    const owner = String(group.owner || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(owner)) {
      throw new TaskNotionError(
        "OPENSPEC_REPOSITORY_OWNER_INVALID",
        `Не удалось определить безопасное имя репозитория OpenSpec: «${owner}»`,
      );
    }
    return {
      owner,
      title: `${OPEN_SPEC_GROUP_PREFIX}${owner}`,
      documents: titledOpenSpecDocuments(group.documents),
    };
  });
  const groupTitles = preparedGroups.map((group) => group.title);
  if (new Set(groupTitles).size !== groupTitles.length) {
    throw new TaskNotionError(
      "OPENSPEC_REPOSITORY_OWNER_AMBIGUOUS",
      "В одной Истории допускается один repo-local OpenSpec на репозиторий",
    );
  }

  const existing = await listAllChildren(client, pageId);
  const managed = managedOpenSpecBlocks(existing, code);
  for (const item of managed) {
    await client.request(`/blocks/${item.id}`, { method: "DELETE" });
  }

  const blockIds = [];
  const documentBlockIds = [];
  let blockCount = 0;
  let documentCount = 0;
  for (const group of preparedGroups) {
    const groupToggle = await createOpenSpecToggle(client, pageId, group.title);
    blockIds.push(groupToggle.id);
    for (const document of group.documents) {
      const documentToggle = await createOpenSpecToggle(
        client,
        groupToggle.id,
        document.title,
      );
      documentBlockIds.push(documentToggle.id);
      documentCount += 1;
      blockCount += await appendOpenSpecMarkdown(
        client,
        documentToggle.id,
        document.markdown,
      );
    }
  }
  return {
    blockIds,
    documentBlockIds,
    replaced: managed.length > 0,
    blocks: blockCount,
    documents: documentCount,
    groups: preparedGroups.length,
  };
}

export async function removeManagedDocuments(client, pageId) {
  const existing = await listAllChildren(client, pageId);
  const managed = existing.filter((item) => {
    const title = toggleTitle(item);
    return title.startsWith(MANAGED_SPEC_PREFIX) || isManagedDocumentTitle(title);
  });
  const counts = new Map();
  for (const item of managed) {
    const title = toggleTitle(item);
    counts.set(title, (counts.get(title) || 0) + 1);
  }
  const duplicate = [...counts.entries()].find(([, count]) => count > 1);
  if (duplicate) {
    throw new TaskNotionError(
      "SPEC_BLOCK_AMBIGUOUS",
      `В задаче найдено несколько блоков «${duplicate[0]}»`,
      { external: true },
    );
  }
  for (const item of managed) {
    await client.request(`/blocks/${item.id}`, { method: "DELETE" });
  }
  return {
    removed: managed.length,
    blockIds: managed.map((item) => item.id),
  };
}

export async function releaseTask(
  client,
  config,
  code,
  { approved, specPath } = {},
) {
  if (!approved) {
    throw new TaskNotionError(
      "APPROVAL_REQUIRED",
      "Для перехода в «Ожидание релиза» требуется явный флаг --approved",
    );
  }
  const documents = await loadOpenSpecDocuments(specPath);
  assertOpenSpecLinkage(documents, code);

  const selected = await findTask(client, config, code);
  const owner = openSpecOwnerContext(
    selected.page,
    selected.pages,
    selected.schema,
  );
  if (!isOpenSpecOwner(owner.type, owner)) {
    throw new TaskNotionError(
      "STORY_OWNER_REQUIRED",
      "OpenSpec release разрешён истории-владельцу или эпику технического долга для общего change",
    );
  }
  if (pageReleaseDate(selected.page, selected.schema)) {
    throw new TaskNotionError(
      "RELEASE_STORY_OPENSPEC_FORBIDDEN",
      "История релиза не содержит OpenSpec, delta или master-спецификацию",
    );
  }
  const currentStatus = pageStatus(selected.page, selected.schema);
  if (!["Тестирование", "Ожидание релиза"].includes(currentStatus)) {
    throw new TaskNotionError(
      "ACCEPTANCE_STATUS_REQUIRED",
      "OpenSpec release разрешён только после приёмки в статусе «Тестирование»",
    );
  }
  if (owner.type === "История" && !owner.inheritedTechnicalDebt) {
    const { businessIds } = await validateTaskBusinessMentions(
      client,
      config,
      selected.page,
    );
    assertOpenSpecBusinessLinkage(documents, businessIds);
  }
  const plan = buildStatusUpdatePlan(
    selected.pages,
    selected.schema,
    selected.page.id,
    "Ожидание релиза",
  );
  await validateWaitingReleaseEpics(
    client,
    config,
    selected.pages,
    selected.schema,
    plan,
  );
  const publication = await publishManagedDocuments(
    client,
    selected.page.id,
    code,
    documents,
  );
  await applyStatusUpdatePlan(client, selected.schema, plan);
  return {
    ...selected,
    previousStatus: plan.selectedPreviousStatus,
    statusChanged: plan.selectedChanged,
    parentUpdates: plan.parentUpdates,
    publication,
  };
}

export async function publishPlanningTask(
  client,
  config,
  code,
  { changePath, changePaths = [] } = {},
) {
  const requestedPaths = changePaths.length
    ? changePaths
    : changePath
      ? [changePath]
      : [];
  if (!requestedPaths.length) {
    throw new TaskNotionError(
      "CHANGE_PATH_REQUIRED",
      "Укажи хотя бы один каталог OpenSpec change через --change",
    );
  }
  const documentGroups = [];
  for (const requestedPath of requestedPaths) {
    const documents = await loadPlanningDocuments(requestedPath);
    assertOpenSpecLinkage(documents, code);
    const resolvedProposalPath = resolve(
      documents.find((document) => document.label === "proposal.md")?.path ||
        documents[0].path,
    );
    const segments = resolvedProposalPath.split(/[\\/]/u);
    const openSpecIndex = segments.lastIndexOf("openspec");
    const repositoryOwner =
      openSpecIndex > 0 ? segments[openSpecIndex - 1] : "";
    documentGroups.push({ owner: repositoryOwner, documents });
  }
  const selected = await findTask(client, config, code);
  const owner = openSpecOwnerContext(
    selected.page,
    selected.pages,
    selected.schema,
  );
  if (!isOpenSpecOwner(owner.type, owner)) {
    throw new TaskNotionError(
      "STORY_OWNER_REQUIRED",
      "Плановые OpenSpec-материалы публикуются в историю-владельца или эпик технического долга для общего change",
    );
  }
  if (pageReleaseDate(selected.page, selected.schema)) {
    throw new TaskNotionError(
      "RELEASE_STORY_OPENSPEC_FORBIDDEN",
      "История релиза не содержит OpenSpec, delta или master-спецификацию",
    );
  }
  if (owner.type === "История" && !owner.inheritedTechnicalDebt) {
    const { businessIds } = await validateTaskBusinessMentions(
      client,
      config,
      selected.page,
    );
    for (const group of documentGroups) {
      assertOpenSpecBusinessLinkage(group.documents, businessIds);
    }
  }
  const publication = documentGroups.length === 1
    ? await publishManagedDocuments(
      client,
      selected.page.id,
      code,
      documentGroups[0].documents,
    )
    : await publishManagedDocumentGroups(
      client,
      selected.page.id,
      code,
      documentGroups,
    );
  return { ...selected, publication };
}

export async function verifyStoryReady(client, config, code) {
  const selected = await findTask(client, config, code);
  const type = pageTaskType(selected.page, selected.schema);
  if (type === "История" && pageReleaseDate(selected.page, selected.schema)) {
    const releaseDate = pageReleaseDate(selected.page, selected.schema);
    if (pageTitle(selected.page, selected.schema.titleName) !== formatReleaseTitleRu(releaseDate)) {
      throw new TaskNotionError(
        "RELEASE_TITLE_INVALID",
        `Release-история должна называться «${formatReleaseTitleRu(releaseDate)}»`,
        { external: true },
      );
    }
    const pageBlocks = await listAllChildren(client, selected.page.id);
    const contentBlocks = pageBlocks.filter(
      (item) => item.type !== "paragraph" || blockText(item).trim(),
    );
    const expectedDate = `Дата релиза — ${formatReleaseDateRu(releaseDate)}`;
    const dateCallout = contentBlocks[0];
    const hasDateCallout =
      dateCallout?.type === "callout" &&
      dateCallout.callout?.icon?.type === "emoji" &&
      dateCallout.callout.icon.emoji === CALLOUT_ICON &&
      blockText(dateCallout).trim() === expectedDate;
    const hasChanges =
      contentBlocks[1]?.type === "heading_2" &&
      blockText(contentBlocks[1]).trim() === "Изменения";
    const dividerIndex = contentBlocks.findIndex(
      (item, index) => index > 1 && item.type === "divider",
    );
    const changeItems = contentBlocks.slice(2, dividerIndex);
    const hasChangeItems =
      dividerIndex > 2 &&
      changeItems.every(
        (item) =>
          item.type === "bulleted_list_item" && blockText(item).trim(),
      );
    const trailingBlocks = contentBlocks.slice(dividerIndex + 1);
    const hasUnexpectedBlocks =
      dividerIndex < 0 ||
      trailingBlocks.some((item) => item.type !== "child_database");
    const hasStaticTable = pageBlocks.some((item) => item.type === "table");
    const hasOpenSpec = pageBlocks.some(
      (item) => item.type === "toggle" && isManagedDocumentTitle(toggleTitle(item)),
    );
    if (
      !hasDateCallout ||
      !hasChanges ||
      !hasChangeItems ||
      hasUnexpectedBlocks ||
      hasStaticTable ||
      hasOpenSpec
    ) {
      throw new TaskNotionError(
        "RELEASE_STORY_STRUCTURE_INVALID",
        "Release-история должна содержать дату и непустой changes-список без статической таблицы или OpenSpec",
        { external: true },
      );
    }
    const business = await inspectBusinessRequirements(client, config);
    const historyItems = business.items.filter(
      (item) => item.title === "История релизов",
    );
    if (historyItems.length !== 1) {
      throw new TaskNotionError(
        "RELEASE_HISTORY_BUSINESS_AMBIGUOUS",
        "В базе должна быть ровно одна бизнес-сущность «История релизов»",
        { external: true },
      );
    }
    const views = await validateReleaseViews(client, {
      source: selected.source,
      schema: selected.schema,
      releasePage: selected.page,
      historyPage: historyItems[0],
    });
    return { ...selected, checkedChildren: [], releaseStory: true, views };
  }
  const owner = openSpecOwnerContext(
    selected.page,
    selected.pages,
    selected.schema,
  );
  if (!isOpenSpecOwner(type, owner)) {
    throw new TaskNotionError(
      "STORY_OWNER_REQUIRED",
      "Итоговая OpenSpec-проверка выполняется для истории-владельца или эпика технического долга для общего change",
    );
  }
  const pageBlocks = await listAllChildren(client, selected.page.id);
  const topLevelToggles = pageBlocks.filter((item) => item.type === "toggle");
  const groupBlocks = topLevelToggles.filter((item) =>
    isOpenSpecGroupTitle(toggleTitle(item)),
  );
  const flatDocumentTitles = topLevelToggles
    .map(toggleTitle)
    .filter(isOpenSpecDocumentTitle);
  const requiredTitles = ["Предложения", "Дизайн архитектуры", "Задачи"];
  const documentSets = [];
  let invalidPublication = false;
  if (groupBlocks.length) {
    const groupTitles = groupBlocks.map(toggleTitle);
    invalidPublication =
      flatDocumentTitles.length > 0 ||
      new Set(groupTitles).size !== groupTitles.length;
    for (const groupBlock of groupBlocks) {
      const children = await listAllChildren(client, groupBlock.id);
      documentSets.push(
        children
          .filter((item) => item.type === "toggle")
          .map(toggleTitle)
          .filter(isOpenSpecDocumentTitle),
      );
    }
  } else {
    documentSets.push(flatDocumentTitles);
  }
  invalidPublication ||= documentSets.some((documentTitles) =>
    new Set(documentTitles).size !== documentTitles.length ||
    requiredTitles.some((title) => !documentTitles.includes(title)) ||
    !documentTitles.some((title) => title.startsWith("Спецификация · ")),
  );
  if (invalidPublication) {
    throw new TaskNotionError(
      "STORY_SPECIFICATION_REQUIRED",
      "В истории не опубликован полный и однозначный набор proposal, design, tasks и delta-спецификаций",
      { external: true },
    );
  }
  const snapshot = buildTaskHierarchySnapshot(selected.pages, selected.schema);
  const children = (
    snapshot.directChildrenByParentId.get(selected.page.id) || []
  ).filter((page) => pageTaskType(page, selected.schema) !== "Баг");
  const incomplete = children.filter(
    (page) => statusIndex(pageStatus(page, selected.schema)) < statusIndex("Тестирование"),
  );
  if (incomplete.length) {
    throw new TaskNotionError(
      "STORY_CHILDREN_INCOMPLETE",
      `История не готова: ${incomplete
        .map((page) => pageTaskCode(page, selected.schema.idName) || pageTitle(page, selected.schema.titleName))
        .join(", ")}`,
      { external: true },
    );
  }
  return {
    ...selected,
    technicalDebtEpic: Boolean(owner.technicalDebtEpic),
    checkedChildren: children.map((page) => ({
      code: pageTaskCode(page, selected.schema.idName),
      title: pageTitle(page, selected.schema.titleName),
      status: pageStatus(page, selected.schema),
    })),
  };
}

function flattenedBlocks(blocks) {
  return blocks.flatMap((item) => [item, ...flattenedBlocks(item.children || [])]);
}

function requireAnyBlockText(blocks, texts, code) {
  if (!blocks.some((item) => texts.includes(blockText(item).trim()))) {
    throw new TaskNotionError(
      code,
      `В странице отсутствует обязательный раздел «${texts[0]}»`,
      { external: true },
    );
  }
}

export async function inspectTaskItem(client, config, code) {
  const selected = await findTask(client, config, code);
  const snapshot = buildTaskHierarchySnapshot(selected.pages, selected.schema);
  const type = pageTaskType(selected.page, selected.schema);
  if (!type) {
    return {
      ...selected,
      type: "legacy",
      warnings: ["У страницы не задан тип; действует режим совместимости"],
    };
  }
  assertTaskTitleWithoutTaskCode(pageTitle(selected.page, selected.schema.titleName));
  if (selected.page.icon?.type !== "emoji" || !selected.page.icon.emoji) {
    throw new TaskNotionError(
      "PAGE_ICON_REQUIRED",
      "У страницы задачи отсутствует emoji-иконка",
      { external: true },
    );
  }
  const parentIds = assertSingleParent(selected.page, snapshot, selected.schema);
  const parent = parentIds[0] ? snapshot.pagesById.get(parentIds[0]) : null;
  if (parentIds[0] && !parent) {
    throw new TaskNotionError(
      "PARENT_NOT_FOUND",
      `Родительская страница ${parentIds[0]} недоступна`,
      { external: true },
    );
  }
  assertAllowedTaskRelation(parent ? pageTaskType(parent, selected.schema) : "", type);
  if (pageTechnicalDebt(selected.page, selected.schema) && type !== "Эпик") {
    throw new TaskNotionError(
      "TECHNICAL_DEBT_EPIC_REQUIRED",
      "Checkbox «Технический долг» допустим только у эпика",
      { external: true },
    );
  }
  const technicalDebtEpic = technicalDebtEpicForPage(
    selected.page,
    snapshot,
    selected.schema,
  );
  const technicalDebtContext = Boolean(technicalDebtEpic);
  const children = snapshot.directChildrenByParentId.get(selected.page.id) || [];
  if (type === "Баг" && children.length) {
    throw new TaskNotionError(
      "BUG_CHILDREN_FORBIDDEN",
      "Баг не может иметь дочерние элементы",
      { external: true },
    );
  }
  if (type !== "Баг" && pageReleaseBugIds(selected.page, selected.schema).length) {
    throw new TaskNotionError(
      "BUG_DISCOVERED_RELEASE_TYPE_INVALID",
      "Relation «Баг релиза» допустима только для верхнеуровневого бага",
      { external: true },
    );
  }
  const blocks = await readBlockTree(client, selected.page.id);
  const allBlocks = flattenedBlocks(blocks);
  const mentions = [...new Set(allBlocks.flatMap(blockPageMentions))];
  const releaseHistoryItem =
    (type === "История" && Boolean(pageReleaseDate(selected.page, selected.schema))) ||
    (type === "Эпик" &&
      children.some((child) => pageReleaseDate(child, selected.schema)));
  if (
    pageReleaseDate(selected.page, selected.schema) &&
    type !== "История"
  ) {
    throw new TaskNotionError(
      "RELEASE_DATE_TYPE_FORBIDDEN",
      "Свойство «Дата релиза» допустимо только для release-истории",
      { external: true },
    );
  }
  if (!releaseHistoryItem && !pagePriority(selected.page, selected.schema)) {
    throw new TaskNotionError(
      "PRIORITY_REQUIRED",
      `Для типа «${type}» требуется приоритет`,
      { external: true },
    );
  }
  if (type !== "Баг" && !pageSize(selected.page, selected.schema)) {
    throw new TaskNotionError(
      "SIZE_REQUIRED",
      `Для типа «${type}» требуется размер`,
      { external: true },
    );
  }
  if (releaseHistoryItem && technicalDebtContext) {
    throw new TaskNotionError(
      "TECHNICAL_DEBT_RELEASE_CONFLICT",
      "Release-эпик не может быть эпиком технического долга",
      { external: true },
    );
  }
  const textBlocks = allBlocks.filter(
    (item) =>
      ["paragraph", "callout", "quote"].includes(item.type) &&
      blockText(item).trim(),
  );
  if (!releaseHistoryItem && !textBlocks.length) {
    throw new TaskNotionError(
      "DESCRIPTION_REQUIRED",
      "В странице отсутствует описание",
      { external: true },
    );
  }

  let businessIds = [];
  let businessSnapshot = null;
  if (releaseHistoryItem) {
    if (pagePriority(selected.page, selected.schema)) {
      throw new TaskNotionError(
        "RELEASE_PRIORITY_FORBIDDEN",
        "У release-эпика и release-истории свойство «Приоритет» должно быть пустым",
        { external: true },
      );
    }
    if (mentions.length) {
      throw new TaskNotionError(
        "RELEASE_BUSINESS_LINK_FORBIDDEN",
        "Release-эпик и release-история не должны содержать ссылки на бизнес-требования",
        { external: true },
      );
    }
  } else if ((type === "Эпик" || type === "История") && technicalDebtContext) {
    businessSnapshot = await inspectBusinessRequirements(client, config);
    businessIds = mentions.filter((id) =>
      businessSnapshot.hierarchy.pagesById.has(id),
    );
    if (businessIds.length) {
      throw new TaskNotionError(
        "TECHNICAL_DEBT_BUSINESS_LINK_FORBIDDEN",
        "Эпик технического долга и его дети не должны ссылаться на бизнес-требования",
        { external: true },
      );
    }
  } else if (type === "Эпик" || type === "История") {
    businessSnapshot = await inspectBusinessRequirements(client, config);
    businessIds = mentions.filter((id) =>
      businessSnapshot.hierarchy.pagesById.has(id),
    );
    if (!businessIds.length) {
      throw new TaskNotionError(
        "BUSINESS_MENTION_REQUIRED",
        `Для типа «${type}» требуется page mention бизнес-требования`,
        { external: true },
      );
    }
    const relationCallout = blocks[0];
    const calloutMentions = blockPageMentions(relationCallout);
    if (
      relationCallout?.type !== "callout" ||
      relationCallout.callout?.icon?.type !== "emoji" ||
      relationCallout.callout.icon.emoji !== CALLOUT_ICON ||
      !blockText(relationCallout).startsWith("Ссылка на бизнес-требования — ") ||
      businessIds.some((id) => !calloutMentions.includes(id))
    ) {
      throw new TaskNotionError(
        "BUSINESS_CALLOUT_REQUIRED",
        `У типа «${type}» первым блоком должен быть callout «Ссылка на бизнес-требования» с иконкой ${CALLOUT_ICON}`,
        { external: true },
      );
    }
  }
  if (type === "История" && !releaseHistoryItem && !technicalDebtContext) {
    const epicBlocks = await readBlockTree(client, parent.id);
    const epicMentions = [
      ...new Set(flattenedBlocks(epicBlocks).flatMap(blockPageMentions)),
    ];
    const epicBusinessIds = epicMentions.filter((id) =>
      businessSnapshot.hierarchy.pagesById.has(id),
    );
    if (!epicBusinessIds.length) {
      throw new TaskNotionError(
        "EPIC_BUSINESS_MENTION_REQUIRED",
        "У эпика нет доступной ссылки на бизнес-требование",
        { external: true },
      );
    }
    assertStoryBusinessScope(
      epicBusinessIds,
      businessIds,
      businessSnapshot.hierarchy,
      { businessSubitemApproved: true },
    );
    const rawReference = allBlocks.some((item) => {
      const text = blockText(item).trim();
      return text === "change-спецификация" || /^openspec\//u.test(text);
    });
    if (rawReference) {
      throw new TaskNotionError(
        "STORY_RAW_SPEC_REFERENCE_FORBIDDEN",
        "История не должна показывать служебный путь OpenSpec",
        { external: true },
      );
    }
  }
  if (type === "История" && releaseHistoryItem) {
    const rawReference = allBlocks.some((item) => {
      const text = blockText(item).trim();
      return (
        text === "change-спецификация" ||
        /^openspec\//u.test(text) ||
        item.type === "toggle"
      );
    });
    if (rawReference) {
      throw new TaskNotionError(
        "RELEASE_STORY_OPENSPEC_FORBIDDEN",
        "Release-история не должна содержать OpenSpec-материалы",
        { external: true },
      );
    }
  }
  if (type === "Задача") {
    const story = pageAncestorOfType(selected.page, "История", snapshot, selected.schema);
    if (!story) {
      throw new TaskNotionError(
        "STORY_REQUIRED",
        "Для Задачи нужна родительская История в Parent item",
        { external: true },
      );
    }
    if (!blocks.some((item) => item.type === "paragraph" && blockText(item).trim())) {
      throw new TaskNotionError(
        "DESCRIPTION_REQUIRED",
        "Для Задачи требуется понятное описание результата",
        { external: true },
      );
    }
  }
  if (type === "Подзадача") {
    if (!allBlocks.some((item) => item.type === "to_do")) {
      throw new TaskNotionError(
        "SUBTASK_STEPS_REQUIRED",
        "В подзадаче нет шагов to-do",
        { external: true },
      );
    }
  }
  let storyId = "";
  if (type === "Баг") {
    requireAnyBlockText(allBlocks, ["Описание дефекта:", "Описание"], "DESCRIPTION_REQUIRED");
    requireAnyBlockText(allBlocks, ["ОР:", "ОР"], "BUG_EXPECTED_RESULT_REQUIRED");
    requireAnyBlockText(allBlocks, ["ФР:", "ФР"], "BUG_ACTUAL_RESULT_REQUIRED");
    requireAnyBlockText(allBlocks, ["Приложения:", "Приложения"], "BUG_ATTACHMENTS_REQUIRED");
    for (const label of ["Описание дефекта:", "ОР:", "ФР:", "Приложения:"]) {
      const labelBlock = allBlocks.find((item) => blockText(item).trim() === label);
      const richText = labelBlock?.[labelBlock.type]?.rich_text || [];
      if (!richText.length || richText.some((item) => !item.annotations?.bold)) {
        throw new TaskNotionError(
          "BUG_LABEL_FORMAT_REQUIRED",
          `Заголовок «${label}» должен быть выделен жирным`,
          { external: true },
        );
      }
    }
    const labelIndexes = ["Описание дефекта:", "ОР:", "ФР:", "Приложения:"]
      .map((label) => blocks.findIndex((item) => blockText(item).trim() === label));
    if (
      labelIndexes.some((index) => index < 0) ||
      labelIndexes.some((index, position) => position > 0 && index <= labelIndexes[position - 1]) ||
      labelIndexes.slice(0, 3).some((index) => !blockText(blocks[index + 1]).trim())
    ) {
      throw new TaskNotionError(
        "BUG_STRUCTURE_INVALID",
        "Разделы бага должны идти в порядке «Описание дефекта → ОР → ФР → Приложения» и содержать значения",
        { external: true },
      );
    }
    if (pageSize(selected.page, selected.schema)) {
      throw new TaskNotionError(
        "BUG_SIZE_FORBIDDEN",
        "Для бага свойство «Размер» должно быть пустым",
        { external: true },
      );
    }
    const discoveredReleaseIds = pageReleaseBugIds(
      selected.page,
      selected.schema,
    );
    const callouts = blocks.filter((item) => item.type === "callout");
    if (parent) {
      if (discoveredReleaseIds.length || callouts.length || mentions.length) {
        throw new TaskNotionError(
          "BUG_SUBITEM_CONTEXT_INVALID",
          "Вложенный баг связывается только через Parent item и не содержит callout или page mentions",
          { external: true },
        );
      }
      storyId =
        pageAncestorOfType(selected.page, "История", snapshot, selected.schema)
          ?.id || "";
    } else {
      if (discoveredReleaseIds.length !== 1) {
        throw new TaskNotionError(
          "BUG_DISCOVERED_RELEASE_REQUIRED",
          "У верхнеуровневого бага должна быть ровно одна relation «Баг релиза»",
          { external: true },
        );
      }
      const discoveredRelease = snapshot.pagesById.get(
        discoveredReleaseIds[0],
      );
      if (
        !discoveredRelease ||
        pageTaskType(discoveredRelease, selected.schema) !== "История" ||
        !pageReleaseDate(discoveredRelease, selected.schema)
      ) {
        throw new TaskNotionError(
          "BUG_DISCOVERED_RELEASE_INVALID",
          "Relation «Баг релиза» должна указывать release-историю с датой",
          { external: true },
        );
      }
      const discoveredCallout = blocks[0];
      const calloutMentions = blockPageMentions(discoveredCallout);
      if (
        discoveredCallout?.type !== "callout" ||
        discoveredCallout.callout?.icon?.type !== "emoji" ||
        discoveredCallout.callout.icon.emoji !== CALLOUT_ICON ||
        !blockText(discoveredCallout).startsWith("Обнаружен: ") ||
        calloutMentions.length !== 1 ||
        calloutMentions[0] !== discoveredRelease.id ||
        mentions.length !== 1 ||
        mentions[0] !== discoveredRelease.id
      ) {
        throw new TaskNotionError(
          "BUG_DISCOVERED_RELEASE_CALLOUT_REQUIRED",
          `Верхнеуровневый баг должен первым callout-блоком с иконкой ${CALLOUT_ICON} указывать тот же релиз обнаружения`,
          { external: true },
        );
      }
    }
  }
  return {
    ...selected,
    type,
    priority: pagePriority(selected.page, selected.schema),
    size: pageSize(selected.page, selected.schema),
    parentId: parent?.id || "",
    storyId,
    discoveredReleaseId:
      type === "Баг"
        ? pageReleaseBugIds(selected.page, selected.schema)[0] || ""
        : "",
    technicalDebt: pageTechnicalDebt(selected.page, selected.schema),
    technicalDebtEpicId: technicalDebtEpic?.id || "",
    businessIds,
    blocks,
    mentions,
    warnings: [],
  };
}
