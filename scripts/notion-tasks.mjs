import { readFile, mkdir, rename, lstat, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { NotionClient, TaskNotionError, resolveDataSource, queryAllPages, readBlockTree } from "./notion-workflow-lib.mjs";
import { assertSafePath, SetupError, TOOLING_ROOT } from "./project-config.mjs";

export { NotionClient, TaskNotionError };
const richText = content => [{ type: "text", text: { content } }];
const text = value => (value || []).map(item => item.plain_text ?? item.text?.content ?? "").join("");

/** Принимает ID либо URL страницы; случайные строки не становятся API-путём. */
export function notionId(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/(?:^|\/|-)([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:[?#/]|$)/i);
  if (!match) throw new SetupError("INVALID_NOTION_ID", "Нужен ID или URL страницы, базы либо data source Notion.");
  return match[1].replaceAll("-", "").toLowerCase();
}

/** Сохраняет локальную конфигурацию атомарно; токен не попадает в Git. */
export async function saveJson(path, value, mode = 0o600) {
  assertSafePath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", mode);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
    await file.close();
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file.close();
    await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Читает токен из окружения или локального owner-only файла. */
export async function notionToken(root = TOOLING_ROOT, env = process.env) {
  if (env.NOTION_TOKEN) return env.NOTION_TOKEN;
  const path = join(root, ".project/notion-secret.json");
  assertSafePath(path);
  try {
    const info = await lstat(path);
    if (info.mode & 0o077) throw new SetupError("INSECURE_SECRET", `Выполни chmod 600 '${path}'.`, path);
    return JSON.parse(await readFile(path, "utf8")).token || "";
  } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

/** Сопоставляет поля по типу и явным именам; неоднозначность требует настройки. */
export function taskSchema(metadata, mapping = {}) {
  const properties = metadata.properties || {};
  function select(key, types, required = false) {
    if (mapping[key]) {
      const entry = Object.entries(properties).find(([name, property]) => name === mapping[key] || property.id === mapping[key]);
      if (!entry || !types.includes(entry[1].type)) throw new SetupError("NOTION_PROPERTY_INVALID", `Проверь поле ${key}: ${mapping[key]}.`);
      return { name: entry[0], ...entry[1] };
    }
    const entries = Object.entries(properties).filter(([, property]) => types.includes(property.type));
    if (entries.length === 1) return { name: entries[0][0], ...entries[0][1] };
    if (!required) return null;
    throw new SetupError("NOTION_PROPERTY_AMBIGUOUS", `Задай notion.properties.${key}: найдено полей ${entries.length}.`);
  }
  const title = select("title", ["title"], true);
  const code = mapping.code ? select("code", ["unique_id", "rich_text", "title", "number"]) : select("code", ["unique_id"]);
  const status = mapping.status ? select("status", ["status", "select"]) : select("status", ["status"]);
  return { title, code, status, parent: mapping.parent ? select("parent", ["relation"]) : null, type: mapping.type ? select("type", ["select"]) : null };
}

/** Возвращает строковое представление task ID для разных схем базы. */
export function taskCode(page, schema, prefix) {
  const property = page.properties?.[schema.code?.name];
  if (!property) return "";
  if (property.type === "unique_id") return `${property.unique_id.prefix || prefix}-${property.unique_id.number}`;
  if (property.type === "number") return property.number === null ? "" : `${prefix}-${property.number}`;
  return text(property[property.type]);
}

/** Возвращает metadata базы и доступные поля для doctor и последующих действий. */
export async function inspectTasks(client, project) {
  const source = await resolveDataSource(client, notionId(project.notion.databaseId));
  return { source, schema: taskSchema(source.metadata, project.notion.properties) };
}

/** Ищет ровно одну задачу; прямой URL проверяется на принадлежность подключённой базе. */
export async function findTask(client, project, reference) {
  const { source, schema } = await inspectTasks(client, project);
  let matches, id;
  try { id = notionId(reference); }
  catch (error) { if (error.code !== "INVALID_NOTION_ID") throw error; }
  if (id) {
    const page = await client.request(`/pages/${id}`);
    const parent = page.parent?.data_source_id || page.parent?.database_id;
    if (!parent || notionId(parent) !== notionId(source.id))
      throw new SetupError("TASK_OUTSIDE_DATABASE", "Страница принадлежит другой базе.");
    matches = [page];
  } else {
    if (!schema.code) throw new SetupError("NOTION_CODE_REQUIRED", "Задай поле кода либо передай URL задачи.");
    matches = (await queryAllPages(client, source.id)).filter(page => taskCode(page, schema, project.code).toUpperCase() === String(reference).toUpperCase());
  }
  if (matches.length !== 1) throw new SetupError(matches.length ? "TASK_AMBIGUOUS" : "TASK_NOT_FOUND", `Найдено задач: ${matches.length}.`);
  return { page: matches[0], source, schema };
}

/** Меняет только выбранную задачу на существующий в базе статус и проверяет read-back. */
export async function updateStatus(client, project, reference, status) {
  const selected = await findTask(client, project, reference);
  const field = selected.schema.status;
  if (!field) throw new SetupError("NOTION_STATUS_REQUIRED", "Задай notion.properties.status.");
  if (!(field[field.type]?.options || []).some(option => option.name === status))
    throw new SetupError("NOTION_STATUS_INVALID", "Выбери существующий статус из doctor.");
  await client.request(`/pages/${selected.page.id}`, { method: "PATCH", body: { properties: { [field.name]: { [field.type]: { name: status } } } } });
  const page = await client.request(`/pages/${selected.page.id}`);
  if (page.properties?.[field.name]?.[field.type]?.name !== status) throw new SetupError("NOTION_READBACK_FAILED", "Notion не подтвердил статус.");
  return summarize(page, selected.schema, project.code);
}

/** Создаёт задачу с нативным ID или явно заданным кодом для текстового поля. */
export async function createTask(client, project, { title, code, status, parent }) {
  if (!title || title.length > 2000) throw new SetupError("INVALID_TITLE", "Задай заголовок длиной до 2000 символов.");
  const { source, schema } = await inspectTasks(client, project);
  const properties = { [schema.title.name]: { title: richText(title) } };
  if (schema.code && schema.code.type !== "unique_id") {
    if (!code) throw new SetupError("TASK_CODE_REQUIRED", "Для этой базы нужен явный --code.");
    if (schema.code.name === schema.title.name && title !== code)
      throw new SetupError("TASK_TITLE_CODE_CONFLICT", "В этой базе код хранится в заголовке: --title и --code должны совпадать.");
    if (schema.code.type === "number") {
      if (!new RegExp(`^${project.code}-[0-9]+$`).test(code)) throw new SetupError("INVALID_TASK_CODE", "Код не соответствует префиксу проекта.");
      properties[schema.code.name] = { number: Number(code.split("-").at(-1)) };
    } else properties[schema.code.name] = { [schema.code.type]: richText(code) };
  }
  if (status) {
    const field = schema.status;
    if (!field || !(field[field.type]?.options || []).some(option => option.name === status)) throw new SetupError("NOTION_STATUS_INVALID", "Такого статуса нет в базе.");
    properties[field.name] = { [field.type]: { name: status } };
  }
  if (parent) {
    if (!schema.parent) throw new SetupError("NOTION_PARENT_REQUIRED", "Задай notion.properties.parent.");
    const selected = await findTask(client, project, parent);
    properties[schema.parent.name] = { relation: [{ id: selected.page.id }] };
  }
  const page = await client.request("/pages", { method: "POST", body: { parent: { type: "data_source_id", data_source_id: source.id }, properties } });
  return summarize(page, schema, project.code);
}

export function summarize(page, schema, prefix) {
  const field = schema.status;
  return { id: page.id, url: page.url, code: taskCode(page, schema, prefix), title: text(page.properties?.[schema.title.name]?.title), status: field ? page.properties?.[field.name]?.[field.type]?.name || "" : "" };
}

/** Стандартная база хранит задачи с независимой нумерацией выбранного проекта. */
export function standardProperties(code) {
  return {
    Name: { title: {} },
    ID: { unique_id: { prefix: code } },
    Status: { select: { options: ["Backlog", "Analysis", "Development", "Testing", "Ready", "Done"].map(name => ({ name })) } },
    Type: { select: { options: ["Epic", "Story", "Task", "Bug"].map(name => ({ name })) } },
    Priority: { select: { options: ["High", "Medium", "Low"].map(name => ({ name })) } },
  };
}

/** Создаёт базу с durable intent; потерянный ответ блокирует повторное создание. */
export async function provisionTasks(client, project, { parent, journalPath, existingId = "" }) {
  const parentId = notionId(parent);
  const fingerprint = createHash("sha256").update(JSON.stringify({ parentId, code: project.code, properties: standardProperties(project.code) })).digest("hex");
  assertSafePath(journalPath);
  let journal;
  try { journal = JSON.parse(await readFile(journalPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (journal && journal.fingerprint !== fingerprint) throw new SetupError("NOTION_INTENT_CONFLICT", "Незавершённая настройка относится к другому проекту или странице.", journalPath);
  if (!journal) {
    journal = { fingerprint, parentId, stage: "intent", databaseId: existingId ? notionId(existingId) : "" };
    await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
    // O_EXCL также блокирует конкурентный prepare до первого POST.
    const intent = await open(journalPath, "wx", 0o600);
    try { await intent.writeFile(`${JSON.stringify(journal)}\n`); await intent.sync(); }
    finally { await intent.close(); }
    const directory = await open(dirname(journalPath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    if (!existingId) {
      const database = await client.request("/databases", { method: "POST", body: {
        parent: { type: "page_id", page_id: parentId }, title: richText(`${project.name} Tasks`),
        initial_data_source: { properties: standardProperties(project.code) },
      } });
      journal.databaseId = notionId(database.id);
      journal.stage = "created";
      await saveJson(journalPath, journal);
    }
  } else if (existingId) {
    if (journal.databaseId && notionId(journal.databaseId) !== notionId(existingId))
      throw new SetupError("NOTION_INTENT_CONFLICT", "ID отличается от уже сохранённой базы.", journalPath);
    journal.databaseId = notionId(existingId); journal.stage = "created";
    await saveJson(journalPath, journal);
  }
  if (!journal.databaseId) throw new SetupError("NOTION_CREATE_OUTCOME_UNKNOWN", "Проверь страницу Notion и передай --notion-database созданной базы. Повторное создание остановлено.", journalPath);
  const database = await client.request(`/databases/${journal.databaseId}`);
  if (notionId(database.parent?.page_id || "") !== parentId) throw new SetupError("NOTION_PARENT_MISMATCH", "База находится на другой странице.");
  const source = await resolveDataSource(client, journal.databaseId);
  const properties = source.metadata.properties;
  if (properties.ID?.type !== "unique_id" || properties.ID.unique_id?.prefix !== project.code || properties.Name?.type !== "title" || properties.Status?.type !== "select")
    throw new SetupError("NOTION_READBACK_FAILED", "Созданная база не соответствует стандартной схеме.");
  for (const [name, definition] of Object.entries(standardProperties(project.code))) {
    if (!definition.select) continue;
    const options = properties[name]?.select?.options || [];
    if (properties[name]?.type !== "select" || definition.select.options.some(expected => !options.some(option => option.name === expected.name)))
      throw new SetupError("NOTION_READBACK_FAILED", `Notion не подтвердил варианты поля ${name}.`);
  }
  if (!properties.Parent) {
    await client.request(`/data_sources/${source.id}`, { method: "PATCH", body: { properties: { Parent: { relation: { data_source_id: source.id, type: "single_property", single_property: {} } } } } });
  }
  const confirmed = await client.request(`/data_sources/${source.id}`);
  if (confirmed.properties?.Parent?.type !== "relation" || notionId(confirmed.properties.Parent.relation?.data_source_id || "") !== notionId(source.id))
    throw new SetupError("NOTION_READBACK_FAILED", "Notion не подтвердил связь Parent.");
  journal.stage = "complete"; journal.dataSourceId = source.id;
  await saveJson(journalPath, journal);
  return { databaseId: source.id, properties: { title: "Name", code: "ID", status: "Status", parent: "Parent", type: "Type" } };
}

export { readBlockTree };
