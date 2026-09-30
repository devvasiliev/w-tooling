import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  NotionClient,
  TaskNotionError,
  blockText,
  findTask,
  formatReleaseDateRu,
  formatReleaseTitleRu,
  inspectBacklogWorkspace,
  listAllChildren,
  loadConfig,
  normalizeNotionId,
  pageParentIds,
  pageReleaseDate,
  pageStatus,
  pageTitle,
  pageTaskCode,
  pageTaskType,
  queryAllPages,
  randomPageIcon,
  resolveDataSource,
} from "./notion-workflow-lib.mjs";

export const DELIVERY_STATES = Object.freeze(["Формируется", "Развёрнута"]);
export const RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-?[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)?$/u;

const DELIVERY_PROPERTIES = Object.freeze({
  title: "Поставка",
  release: "Релиз",
  service: "Сервис",
  version: "Версия / тег",
  baseSha: "Начальный SHA",
  headSha: "Конечный SHA",
  previous: "Предыдущая поставка",
  deployedAt: "Дата развёртывания",
  state: "Состояние",
  tasks: "Входящие задачи",
});

function fail(code, message, external = false) {
  throw new TaskNotionError(code, message, { external });
}

function richText(content) {
  return [{ type: "text", text: { content: String(content || "") } }];
}

function propertyText(page, name) {
  const property = page?.properties?.[name] || {};
  const values = property.title || property.rich_text || [];
  return values.map((item) => item.plain_text || item.text?.content || "").join("");
}

function relationIds(page, name) {
  return (page?.properties?.[name]?.relation || []).map((item) => item.id).filter(Boolean);
}

function propertyDate(page, name) {
  return page?.properties?.[name]?.date?.start || "";
}

function propertySelect(page, name) {
  return page?.properties?.[name]?.select?.name || "";
}

function comparableDate(value) {
  const parsed = Date.parse(String(value || ""));
  // Date-свойство Notion сохраняет время с точностью до минуты. Точный
  // timestamp остаётся в publication manifest и связанном с ним receipt.
  return Number.isNaN(parsed) ? String(value || "") : new Date(Math.floor(parsed / 60_000) * 60_000).toISOString();
}

function requireProperties(metadata, expected) {
  for (const [name, type] of Object.entries(expected)) {
    if (metadata?.properties?.[name]?.type !== type) {
      fail("RELEASE_INFRA_SCHEMA_INVALID", `Свойство «${name}» должно иметь тип ${type}`, true);
    }
  }
  return true;
}

export function discoverDeliverySchema(metadata) {
  requireProperties(metadata, {
    [DELIVERY_PROPERTIES.title]: "title",
    [DELIVERY_PROPERTIES.release]: "relation",
    [DELIVERY_PROPERTIES.service]: "rich_text",
    [DELIVERY_PROPERTIES.version]: "rich_text",
    [DELIVERY_PROPERTIES.baseSha]: "rich_text",
    [DELIVERY_PROPERTIES.headSha]: "rich_text",
    [DELIVERY_PROPERTIES.previous]: "relation",
    [DELIVERY_PROPERTIES.deployedAt]: "date",
    [DELIVERY_PROPERTIES.state]: "select",
    [DELIVERY_PROPERTIES.tasks]: "relation",
  });
  return { ...DELIVERY_PROPERTIES };
}

export function releaseBranchForVersion(version) {
  if (!RELEASE_VERSION_PATTERN.test(String(version || ""))) {
    fail("DELIVERY_VERSION_INVALID", `Недопустимая версия поставки «${version || ""}»`);
  }
  return `release/${version}`;
}

export function repositoryName(repository) {
  const normalized = String(repository || "").trim().replace(/\/+$/u, "");
  const name = normalized.split(/[/:]/u).at(-1)?.replace(/\.git$/u, "") || "";
  if (!name) fail("DELIVERY_REPOSITORY_NAME_INVALID", `Не удалось определить имя репозитория «${repository || ""}»`);
  return name;
}

export function deliveryTitle(repository) {
  return repositoryName(repository);
}

export function normalizeReleaseManifest(input = {}) {
  if (!Array.isArray(input.deliveries) || !input.deliveries.length) {
    fail("RELEASE_DELIVERIES_REQUIRED", "Релиз должен включать хотя бы одну поставку");
  }
  const deliveries = input.deliveries.map((item, index) => {
    const normalized = {
      service: String(item?.service || "").trim(),
      repository: String(item?.repository || "").trim(),
      version: String(item?.version || "").trim(),
      baseSha: String(item?.baseSha || "").trim(),
      headSha: String(item?.headSha || "").trim(),
      previousDeliveryId: normalizeNotionId(item?.previousDeliveryId || ""),
      deployedAt: String(item?.deployedAt || "").trim(),
      state: String(item?.state || "Формируется").trim(),
      taskCodes: [...new Set((item?.taskCodes || []).map((code) => String(code).toUpperCase()))],
    };
    if (!normalized.service || !normalized.repository) {
      fail("DELIVERY_REPOSITORY_REQUIRED", `У поставки ${index + 1} нужны сервис и репозиторий`);
    }
    normalized.repository = repositoryName(normalized.repository);
    if (!normalized.version || !normalized.baseSha || !normalized.headSha) {
      fail("DELIVERY_GIT_POINT_REQUIRED", `У поставки ${normalized.service} нужны версия и обе SHA-точки`);
    }
    normalized.releaseBranch = releaseBranchForVersion(normalized.version);
    if (!DELIVERY_STATES.includes(normalized.state)) {
      fail("DELIVERY_STATE_INVALID", `Недопустимое состояние поставки «${normalized.state}»`);
    }
    if (normalized.state === "Развёрнута" && !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(normalized.deployedAt)) {
      fail("DELIVERY_DATE_REQUIRED", `У развёрнутой поставки ${normalized.service} нужна production-дата`);
    }
    return normalized;
  });
  const duplicate = deliveries.find((item, index) =>
    deliveries.findIndex((candidate) => candidate.repository === item.repository) !== index,
  );
  if (duplicate) fail("DELIVERY_REPOSITORY_DUPLICATED", `Репозиторий ${duplicate.repository} повторяется в релизе`);
  return { deliveries };
}

export function releaseDateFromDeliveries(deliveries) {
  if (!deliveries.length || deliveries.some((item) => item.state !== "Развёрнута" || !item.deployedAt)) {
    fail("RELEASE_NOT_DEPLOYED", "Для заморозки все включённые поставки должны быть развёрнуты");
  }
  return deliveries.map((item) => item.deployedAt.slice(0, 10)).sort().at(-1);
}

export function assertFrozenDeliveryUnchanged(
  existing,
  desired,
  schema = DELIVERY_PROPERTIES,
  { approvedCorrection = false, correctionReason = "" } = {},
) {
  if (propertySelect(existing, schema.state) !== "Развёрнута") return true;
  const actual = {
    repository: propertyText(existing, schema.title),
    version: propertyText(existing, schema.version),
    baseSha: propertyText(existing, schema.baseSha),
    headSha: propertyText(existing, schema.headSha),
    previousDeliveryId: relationIds(existing, schema.previous)[0] || "",
    deployedAt: comparableDate(propertyDate(existing, schema.deployedAt)),
    taskIds: relationIds(existing, schema.tasks).sort(),
  };
  const expected = {
    repository: deliveryTitle(desired.repository),
    version: desired.version,
    baseSha: desired.baseSha,
    headSha: desired.headSha,
    previousDeliveryId: desired.previousDeliveryId,
    deployedAt: comparableDate(desired.deployedAt),
    taskIds: [...desired.taskIds].sort(),
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    if (approvedCorrection && String(correctionReason || "").trim()) return false;
    fail("DELIVERY_FROZEN", `Развёрнутая поставка «${propertyText(existing, schema.title)}» неизменяема`);
  }
  return true;
}

export function validatePreviousDelivery(deliveryPages, desired, schema = DELIVERY_PROPERTIES) {
  if (!desired.previousDeliveryId) return null;
  const previous = deliveryPages.find(
    (page) => normalizeNotionId(page.id) === normalizeNotionId(desired.previousDeliveryId),
  );
  if (!previous) {
    fail("DELIVERY_PREVIOUS_NOT_FOUND", `Предыдущая поставка для ${desired.repository} не найдена`);
  }
  if (propertyText(previous, schema.title) !== deliveryTitle(desired.repository)) {
    fail("DELIVERY_PREVIOUS_REPOSITORY_MISMATCH", "Предыдущая поставка должна относиться к тому же репозиторию");
  }
  if (propertySelect(previous, schema.state) !== "Развёрнута") {
    fail("DELIVERY_PREVIOUS_NOT_DEPLOYED", "Предыдущая поставка должна быть развёрнута в production");
  }
  if (propertyText(previous, schema.headSha) !== desired.baseSha) {
    fail("DELIVERY_BASE_SHA_MISMATCH", "Начальный SHA должен совпадать с конечным SHA предыдущей поставки");
  }
  return previous;
}

export function deliveryDatabaseBody(parentPageId, backlogSourceId) {
  return {
    parent: { type: "page_id", page_id: parentPageId },
    title: richText("Поставки релиза"),
    icon: randomPageIcon(),
    is_inline: true,
    initial_data_source: {
      properties: {
        [DELIVERY_PROPERTIES.title]: { title: {} },
        [DELIVERY_PROPERTIES.release]: {
          relation: { data_source_id: backlogSourceId, dual_property: { synced_property_name: "Поставки релиза" } },
        },
        [DELIVERY_PROPERTIES.service]: { rich_text: {} },
        [DELIVERY_PROPERTIES.version]: { rich_text: {} },
        [DELIVERY_PROPERTIES.baseSha]: { rich_text: {} },
        [DELIVERY_PROPERTIES.headSha]: { rich_text: {} },
        [DELIVERY_PROPERTIES.deployedAt]: { date: {} },
        [DELIVERY_PROPERTIES.state]: {
          select: { options: [{ name: "Формируется", color: "yellow" }, { name: "Развёрнута", color: "green" }] },
        },
        [DELIVERY_PROPERTIES.tasks]: {
          relation: { data_source_id: backlogSourceId, dual_property: { synced_property_name: "Поставки исходных изменений" } },
        },
      },
    },
  };
}

export function deliveryViewBody(sourceId, sourceMetadata, releasePageId) {
  const id = (name) => sourceMetadata.properties[name]?.id || name;
  return {
    data_source_id: sourceId,
    name: "Поставки релиза",
    type: "table",
    filter: { property: DELIVERY_PROPERTIES.release, relation: { contains: releasePageId } },
    sorts: [{ property: DELIVERY_PROPERTIES.title, direction: "ascending" }],
    configuration: {
      type: "table",
      properties: [
        { property_id: id(DELIVERY_PROPERTIES.title), visible: true, width: 260 },
        { property_id: id(DELIVERY_PROPERTIES.service), visible: true, width: 180 },
        { property_id: id(DELIVERY_PROPERTIES.version), visible: true, width: 160 },
        { property_id: id(DELIVERY_PROPERTIES.state), visible: true, width: 150 },
        { property_id: id(DELIVERY_PROPERTIES.deployedAt), visible: true, width: 190 },
      ],
      wrap_cells: true,
    },
  };
}

async function childDatabase(client, parentPageId, title) {
  const blocks = await listAllChildren(client, parentPageId);
  const matches = blocks.filter((block) => block.type === "child_database" && block.child_database?.title === title);
  if (matches.length > 1) fail("RELEASE_INFRA_AMBIGUOUS", `Найдено несколько баз «${title}»`, true);
  return matches[0] || null;
}

async function createDatabase(client, body) {
  const database = await client.request("/databases", { method: "POST", body });
  if (!database?.id) fail("RELEASE_DATABASE_CREATE_FAILED", "Notion не вернул ID созданной базы", true);
  return resolveDataSource(client, database.id);
}

export function legacyDeliveryMigrationProperties(page, catalog) {
  const related = relationIds(page, "Дистрибутив");
  if (related.length !== 1 || !catalog.has(related[0])) {
    fail("LEGACY_DISTRIBUTIVE_MIGRATION_INVALID", `Не удалось перенести дистрибутив поставки «${propertyText(page, DELIVERY_PROPERTIES.title)}»`, true);
  }
  const item = catalog.get(related[0]);
  return {
    [DELIVERY_PROPERTIES.title]: { title: richText(deliveryTitle(item.repository)) },
    [DELIVERY_PROPERTIES.service]: { rich_text: richText(item.service) },
  };
}

async function migrateLegacyDistributiveCatalog(client, legacyDatabase, deliveries) {
  const legacyRelation = deliveries.metadata.properties.Дистрибутив;
  const needsFields = deliveries.metadata.properties[DELIVERY_PROPERTIES.service]?.type !== "rich_text";
  if (needsFields) {
    await client.request(`/data_sources/${deliveries.id}`, {
      method: "PATCH",
      body: {
        properties: {
          [DELIVERY_PROPERTIES.service]: { rich_text: {} },
        },
      },
    });
    deliveries = await resolveDataSource(client, deliveries.id);
  }
  if (!legacyRelation && !legacyDatabase) return deliveries;
  if (legacyRelation?.type !== "relation" || !legacyDatabase) {
    fail("LEGACY_DISTRIBUTIVE_MIGRATION_INVALID", "Старая relation дистрибутива не соответствует базе-каталогу", true);
  }

  const legacySource = await resolveDataSource(client, legacyDatabase.id);
  requireProperties(legacySource.metadata, { Название: "title", Репозиторий: "rich_text" });
  const [catalogPages, deliveryPages] = await Promise.all([
    queryAllPages(client, legacySource.id),
    queryAllPages(client, deliveries.id),
  ]);
  const catalog = new Map(
    catalogPages.map((page) => [page.id, {
      service: propertyText(page, "Название"),
      repository: propertyText(page, "Репозиторий"),
    }]),
  );
  for (const page of deliveryPages) {
    await client.request(`/pages/${page.id}`, {
      method: "PATCH",
      body: { properties: legacyDeliveryMigrationProperties(page, catalog) },
    });
  }
  await client.request(`/data_sources/${deliveries.id}`, {
    method: "PATCH",
    body: { properties: { Дистрибутив: null } },
  });
  const legacyDatabaseId = legacySource.metadata?.parent?.database_id || legacyDatabase.id;
  await client.request(`/databases/${legacyDatabaseId}`, {
    method: "PATCH",
    body: { in_trash: true },
  });
  return resolveDataSource(client, deliveries.id);
}

export function storedRepositoryMigrationProperties(page) {
  const repository = propertyText(page, "Репозиторий");
  if (!repository) {
    fail("DELIVERY_REPOSITORY_MIGRATION_INVALID", `У поставки «${propertyText(page, DELIVERY_PROPERTIES.title)}» отсутствует репозиторий`, true);
  }
  return { [DELIVERY_PROPERTIES.title]: { title: richText(deliveryTitle(repository)) } };
}

async function migrateStoredRepositoryProperty(client, deliveries) {
  const property = deliveries.metadata.properties.Репозиторий;
  if (!property) return deliveries;
  if (property.type !== "rich_text") {
    fail("DELIVERY_REPOSITORY_MIGRATION_INVALID", "Свойство «Репозиторий» должно иметь тип rich_text", true);
  }
  const pages = await queryAllPages(client, deliveries.id);
  for (const page of pages) {
    await client.request(`/pages/${page.id}`, {
      method: "PATCH",
      body: { properties: storedRepositoryMigrationProperties(page) },
    });
  }
  await client.request(`/data_sources/${deliveries.id}`, {
    method: "PATCH",
    body: { properties: { Репозиторий: null } },
  });
  return resolveDataSource(client, deliveries.id);
}

async function ensureDeliveryView(client, releasePageId, source) {
  const body = deliveryViewBody(source.id, source.metadata, releasePageId);
  const blocks = await listAllChildren(client, releasePageId);
  const databases = blocks.filter((item) => item.type === "child_database");
  for (const database of databases) {
    const listed = await client.request(`/views?database_id=${encodeURIComponent(database.id)}&page_size=100`);
    for (const reference of listed.results || []) {
      const view = await client.request(`/views/${reference.id}`);
      if (view.name === body.name) {
        await client.request(`/views/${view.id}`, {
          method: "PATCH",
          body: { name: body.name, filter: body.filter, sorts: body.sorts, configuration: body.configuration },
        });
        return { id: view.id, created: false };
      }
    }
  }
  const view = await client.request("/views", {
    method: "POST",
    body: { ...body, create_database: { parent: { type: "page_id", page_id: releasePageId } } },
  });
  if (!view?.id) fail("DELIVERY_VIEW_CREATE_FAILED", "Notion не вернул ID вида поставок", true);
  return { id: view.id, created: true };
}

export async function ensureReleaseInfrastructure(client, config, releaseCode) {
  const release = await findTask(client, config, releaseCode);
  if (pageTaskType(release.page, release.schema) !== "История") {
    fail("RELEASE_STORY_REQUIRED", `${releaseCode} должен иметь тип «История»`);
  }
  const parentIds = pageParentIds(release.page, release.schema);
  if (parentIds.length !== 1) fail("RELEASE_EPIC_REQUIRED", "Release-история должна иметь один release-эпик");
  const backlog = await inspectBacklogWorkspace(client, config, { requireTyped: true });
  const legacyDistributives = await childDatabase(client, parentIds[0], "Дистрибутивы");
  let deliveries = await childDatabase(client, parentIds[0], "Поставки релиза");
  if (deliveries) {
    deliveries = await resolveDataSource(client, deliveries.id);
  } else {
    deliveries = await createDatabase(
      client,
      deliveryDatabaseBody(parentIds[0], backlog.source.id),
    );
    await client.request(`/data_sources/${deliveries.id}`, {
      method: "PATCH",
      body: {
        properties: {
          [DELIVERY_PROPERTIES.previous]: {
            relation: {
              data_source_id: deliveries.id,
              dual_property: { synced_property_name: "Следующие поставки" },
            },
          },
        },
      },
    });
    deliveries = await resolveDataSource(client, deliveries.id);
  }
  deliveries = await migrateLegacyDistributiveCatalog(client, legacyDistributives, deliveries);
  deliveries = await migrateStoredRepositoryProperty(client, deliveries);
  discoverDeliverySchema(deliveries.metadata);
  const view = await ensureDeliveryView(client, release.page.id, deliveries);
  return { release, backlog, deliveries, view };
}

/** Собирает свойства поставки для общей базы и сохраняет связь с исходным релизом. */
export function deliveryProperties(schema, item) {
  const properties = {
    [schema.title]: { title: richText(deliveryTitle(item.repository)) },
    [schema.release]: { relation: [{ id: item.releaseId }] },
    [schema.service]: { rich_text: richText(item.service) },
    [schema.version]: { rich_text: richText(item.version) },
    [schema.baseSha]: { rich_text: richText(item.baseSha) },
    [schema.headSha]: { rich_text: richText(item.headSha) },
    [schema.deployedAt]: { date: item.deployedAt ? { start: item.deployedAt } : null },
    [schema.state]: { select: { name: item.state } },
    [schema.tasks]: { relation: item.taskIds.map((id) => ({ id })) },
  };
  if (item.previousDeliveryId) properties[schema.previous] = { relation: [{ id: item.previousDeliveryId }] };
  else properties[schema.previous] = { relation: [] };
  return properties;
}

/** Добавляет поставку в выбранную базу после проверки её полного состава вызывающим кодом. */
export async function createDataPage(client, sourceId, properties) {
  return client.request("/pages", {
    method: "POST",
    body: {
      parent: { type: "data_source_id", data_source_id: sourceId },
      icon: randomPageIcon(),
      properties,
    },
  });
}

export async function syncReleaseManifest(
  client,
  config,
  releaseCode,
  manifestInput,
  { freeze = false, approved = false, correctFrozen = false, correctionReason = "" } = {},
) {
  const manifest = normalizeReleaseManifest(manifestInput);
  if (correctFrozen && (!approved || !String(correctionReason || "").trim())) {
    fail("DELIVERY_CORRECTION_APPROVAL_REQUIRED", "Для исправления выпущенной поставки нужны --approved и --reason");
  }
  const infra = await ensureReleaseInfrastructure(client, config, releaseCode);
  const deliverySchema = discoverDeliverySchema(infra.deliveries.metadata);
  const [deliveryPages, backlogPages] = await Promise.all([
    queryAllPages(client, infra.deliveries.id),
    queryAllPages(client, infra.backlog.source.id),
  ]);
  const releaseId = infra.release.page.id;
  const currentReleaseDeliveries = deliveryPages.filter((page) => relationIds(page, deliverySchema.release).includes(releaseId));
  const productFrozen = Boolean(
    pageReleaseDate(infra.release.page, infra.release.schema) &&
    currentReleaseDeliveries.length &&
    currentReleaseDeliveries.every((page) => propertySelect(page, deliverySchema.state) === "Развёрнута"),
  );
  const backlogByCode = new Map(backlogPages.map((page) => [pageTaskCode(page, infra.backlog.schema.idName), page]));
  const results = [];

  for (const item of manifest.deliveries) {
    const taskPages = item.taskCodes.map((code) => {
      const page = backlogByCode.get(code);
      if (!page) fail("DELIVERY_TASK_NOT_FOUND", `код задачи ${code} не найден в Бэклоге`, true);
      const type = pageTaskType(page, infra.backlog.schema);
      if (!["Задача", "Баг"].includes(type)) fail("DELIVERY_TASK_TYPE_INVALID", `${code} должен иметь тип «Задача» или «Баг»`);
      if (pageStatus(page, infra.backlog.schema) !== "Закрыто") fail("DELIVERY_TASK_UNCLOSED", `${code} должен быть закрыт до поставки`);
      return page;
    });
    for (const taskPage of taskPages) {
      const conflicting = deliveryPages.find(
        (page) =>
          relationIds(page, deliverySchema.tasks).includes(taskPage.id) &&
          !relationIds(page, deliverySchema.release).includes(releaseId),
      );
      if (conflicting) fail("DELIVERY_TASK_OTHER_RELEASE", `${pageTaskCode(taskPage, infra.backlog.schema.idName)} уже входит в поставку другого релиза`);
    }

    const matchingDeliveries = deliveryPages.filter(
      (page) =>
        relationIds(page, deliverySchema.release).includes(releaseId) &&
        propertyText(page, deliverySchema.title) === deliveryTitle(item.repository),
    );
    if (matchingDeliveries.length > 1) fail("DELIVERY_AMBIGUOUS", `Для репозитория ${item.repository} найдено несколько поставок релиза`, true);
    const desired = {
      service: item.service,
      repository: item.repository,
      releaseId,
      version: item.version,
      baseSha: item.baseSha,
      headSha: item.headSha,
      previousDeliveryId: item.previousDeliveryId,
      deployedAt: item.deployedAt,
      state: item.state,
      taskIds: taskPages.map((page) => page.id),
    };
    validatePreviousDelivery(deliveryPages, desired, deliverySchema);
    let delivery = matchingDeliveries[0];
    if (delivery) {
      const unchanged = assertFrozenDeliveryUnchanged(delivery, desired, deliverySchema, {
        approvedCorrection: correctFrozen,
        correctionReason,
      });
      const displayChanged =
        propertyText(delivery, deliverySchema.service) !== desired.service ||
        propertyText(delivery, deliverySchema.title) !== deliveryTitle(desired.repository);
      if (propertySelect(delivery, deliverySchema.state) !== "Развёрнута" || !unchanged) {
        delivery = await client.request(`/pages/${delivery.id}`, {
          method: "PATCH",
          body: { properties: deliveryProperties(deliverySchema, desired) },
        });
      } else if (displayChanged) {
        delivery = await client.request(`/pages/${delivery.id}`, {
          method: "PATCH",
          body: {
            properties: {
              [deliverySchema.title]: { title: richText(deliveryTitle(desired.repository)) },
              [deliverySchema.service]: { rich_text: richText(desired.service) },
            },
          },
        });
      }
    } else {
      if (productFrozen) fail("RELEASE_FROZEN", "В замороженный продуктовый релиз нельзя добавлять поставки");
      delivery = await createDataPage(client, infra.deliveries.id, deliveryProperties(deliverySchema, desired));
      deliveryPages.push(delivery);
    }
    results.push({ delivery, desired });
  }

  const desiredDeliveryIds = new Set(results.map((item) => item.delivery.id));
  const omittedDeliveries = currentReleaseDeliveries.filter((page) => !desiredDeliveryIds.has(page.id));
  for (const omitted of omittedDeliveries) {
    if (productFrozen || propertySelect(omitted, deliverySchema.state) === "Развёрнута") {
      fail("RELEASE_MEMBERSHIP_FROZEN", `Нельзя удалить выпущенную поставку «${propertyText(omitted, deliverySchema.title)}»`);
    }
    await client.request(`/pages/${omitted.id}`, { method: "PATCH", body: { in_trash: true } });
  }

  if (freeze) {
    if (!approved) fail("RELEASE_FREEZE_APPROVAL_REQUIRED", "Для заморозки релиза нужен --approved");
    const releaseDate = releaseDateFromDeliveries(manifest.deliveries);
    const existingIds = currentReleaseDeliveries.filter((page) => !omittedDeliveries.includes(page)).map((page) => page.id).sort();
    const desiredIds = results.map((item) => item.delivery.id).sort();
    if (existingIds.length && JSON.stringify(existingIds) !== JSON.stringify(desiredIds)) {
      fail("RELEASE_MEMBERSHIP_CONFLICT", "Manifest заморозки не совпадает с текущим набором поставок релиза");
    }
    const currentDate = pageReleaseDate(infra.release.page, infra.release.schema);
    if (currentDate && currentDate !== releaseDate) {
      fail("RELEASE_DATE_CONFLICT", `Дата релиза уже равна ${currentDate}, вычислена ${releaseDate}`);
    }
    const expectedReleaseTitle = formatReleaseTitleRu(releaseDate);
    if (pageTitle(infra.release.page, infra.release.schema.titleName) !== expectedReleaseTitle) {
      await client.request(`/pages/${releaseId}`, {
        method: "PATCH",
        body: {
          properties: {
            [infra.release.schema.titleName]: { title: richText(expectedReleaseTitle) },
          },
        },
      });
    }
    if (!currentDate) {
      await client.request(`/pages/${releaseId}`, {
        method: "PATCH",
        body: { properties: { [infra.release.schema.releaseDateName]: { date: { start: releaseDate } } } },
      });
      const blocks = await listAllChildren(client, releaseId);
      const first = blocks.find((block) => block.type !== "child_database" && blockText(block));
      if (!first || first.type !== "callout") fail("RELEASE_DATE_CALLOUT_MISSING", "Первым содержательным блоком релиза должен быть callout даты", true);
      await client.request(`/blocks/${first.id}`, {
        method: "PATCH",
        body: {
          callout: {
            rich_text: richText(`Дата релиза — ${formatReleaseDateRu(releaseDate)}`),
            icon: { type: "emoji", emoji: "🫧" },
          },
        },
      });
    }
  }
  return { ...infra, manifest, results, frozen: freeze, releaseDate: freeze ? releaseDateFromDeliveries(manifest.deliveries) : "" };
}

function parseArgs(argv) {
  const args = { release: "", manifestPath: "", freeze: false, approved: false, correctFrozen: false, correctionReason: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--release") args.release = argv[++index] || "";
    else if (argument === "--manifest") args.manifestPath = argv[++index] || "";
    else if (argument === "--freeze") args.freeze = true;
    else if (argument === "--approved") args.approved = true;
    else if (argument === "--correct-frozen") args.correctFrozen = true;
    else if (argument === "--reason") args.correctionReason = argv[++index] || "";
    else fail("INVALID_ARGUMENT", `Неизвестный аргумент: ${argument}`);
  }
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/u.test(args.release)) fail("INVALID_ARGUMENT", "Нужен --release CODE-N");
  if (!args.manifestPath) fail("INVALID_ARGUMENT", "Нужен --manifest <json>");
  return args;
}

export async function run(argv = process.argv.slice(2)) {
  if (["publish", "check", "amend"].includes(argv[0])) {
    const { runPublication } = await import("./release-publication.mjs");
    return runPublication(argv);
  }
  const args = parseArgs(argv);
  if (args.freeze) fail("RELEASE_PUBLICATION_REQUIRED", "Завершение релиза требует changelog и подтверждения deploy. Используй task:release-manifest -- publish --help.");
  const manifest = JSON.parse(await readFile(args.manifestPath, "utf8"));
  const config = await loadConfig();
  const result = await syncReleaseManifest(
    new NotionClient({ token: config.token }),
    config,
    args.release,
    manifest,
    {
      freeze: args.freeze,
      approved: args.approved,
      correctFrozen: args.correctFrozen,
      correctionReason: args.correctionReason,
    },
  );
  process.stdout.write(`${args.release}: поставок ${result.results.length}; релиз ${result.frozen ? `заморожен ${result.releaseDate}` : "формируется"}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run().catch((error) => {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    process.exitCode = 1;
  });
}
