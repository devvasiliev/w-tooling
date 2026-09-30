import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  NotionClient, TaskNotionError, loadConfig, inspectBacklogWorkspace,
  queryAllPages, listAllChildren, resolveDataSource, pageTaskCode, pageTaskType,
  pageStatus, pageParentIds, pageTitle, pageReleaseDate, createTaskItem,
  buildReleaseStoryTemplate, blockText, ensureReleaseViews, formatReleaseTitleRu, formatReleaseDateRu,
  discoverBusinessSchema, validateReleaseViews,
} from "./notion-workflow-lib.mjs";
import {
  discoverDeliverySchema, deliveryProperties, createDataPage,
  ensureReleaseInfrastructure, assertFrozenDeliveryUnchanged,
  validatePreviousDelivery, releaseBranchForVersion,
} from "./task-release-manifest.mjs";

const BASELINE = "Начало истории поставок";
const SET = "Набор релиза";
const INTENT = "Манифест публикации";
const PUBLISHED = "Публикация SHA-256";
const AMENDMENT = "Дополнение публикации";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function fail(code, message) { throw new TaskNotionError(code, message); }
function textProperty(page, name) {
  const p = page?.properties?.[name];
  return (p?.rich_text || p?.title || []).map(x => x.plain_text ?? x.text?.content ?? "").join("");
}
function relation(page, name) { return (page?.properties?.[name]?.relation || []).map(x => x.id); }
function rich(content) { return { rich_text: [{ type: "text", text: { content } }] }; }

function checkedChanges(changes, repository) {
  if (!Array.isArray(changes) || !changes.length || changes.some(x => typeof x !== "string" || !x.trim() || x.length > 1800))
    fail("DELIVERY_CHANGELOG_REQUIRED", `Для ${repository} нужен человекочитаемый changelog поставки.`);
  return changes.map(x => x.trim());
}

function deliveryBlocks(changes) {
  return [{ object: "block", type: "heading_2", heading_2: rich("Изменения") },
    ...changes.map(content => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: rich(content) }))];
}

function assertBlockPrefix(actual, expected, allowPrefix) {
  const signature = blocks => blocks.map(b => [b.type, blockText(b)]);
  if ((!allowPrefix && actual.length !== expected.length) || actual.length > expected.length ||
      canonicalJson(signature(actual)) !== canonicalJson(signature(expected.slice(0, actual.length))))
    fail("DELIVERY_CHANGELOG_MISMATCH", "Содержимое страницы отличается от changelog поставки.");
}

/** Проверяет каждую страницу поставки; общий changelog не заменяет её содержание. */
async function verifyDeliveryContents(client, plan, publication, { allowPrefix = false } = {}) {
  if (publication.schemaVersion === 1) return;
  for (const item of plan) {
    if (!item.existing) { if (allowPrefix) continue; fail("PUBLICATION_INCOMPLETE", "Нет страницы поставки."); }
    assertBlockPrefix(await listAllChildren(client, item.existing.id), deliveryBlocks(item.desired.changes), allowPrefix);
  }
}

/** После потерянного ответа перечитывает страницу и дописывает только отсутствующий хвост. */
async function appendSuffix(client, pageId, expected, { release = false } = {}) {
  const actual = (await listAllChildren(client, pageId)).filter(b => !release || !["child_database", "divider"].includes(b.type));
  if (release) expected = expected.filter(b => b.type !== "divider");
  if (release && actual[0]?.type === "callout") expected = [actual[0], ...expected.slice(1)];
  assertBlockPrefix(actual, expected, true);
  const missing = expected.slice(actual.length);
  let anchor = actual.at(-1)?.id;
  for (let start = 0; start < missing.length; start += 100) {
    const result = await client.request(`/blocks/${pageId}/children`, { method: "PATCH", body: { children: missing.slice(start, start + 100),
      ...(release ? { position: { type: "after_block", after_block: { id: anchor } } } : {}) } });
    anchor = result.results?.at(-1)?.id;
  }
}

async function writeDeliveryContents(client, plan, publication) {
  if (publication.schemaVersion === 1) return;
  for (const item of plan) await appendSuffix(client, item.existing.id, deliveryBlocks(item.desired.changes));
}

/** Нормализует порядок ключей, чтобы Node и серверная проверка получили один digest. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Связывает подтверждение публикации с точным содержимым документа. */
export function publicationDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Возвращает календарный день production-выпуска в часовом поясе оператора. */
export function releaseDay(value, timeZone = "UTC") {
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value || "") || !Number.isFinite(Date.parse(value))) {
    fail("RELEASE_TIMESTAMP_INVALID", "Нужны фактические дата и время развёртывания с часовым поясом.");
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value)).map(x => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Проверяет changelog до обращения к Notion; технические коды остаются в истории Git. */
export function normalizePublication(input, { allowLegacy = false } = {}) {
  if (![1, 2].includes(input?.schemaVersion) || (!allowLegacy && input.schemaVersion !== 2) || !ID.test(input?.releaseSetId || "")) fail("PUBLICATION_MANIFEST_INVALID", "Нужны schemaVersion=2 и стабильный releaseSetId.");
  if (!/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/u.test(input.releaseEpic || "")) fail("RELEASE_EPIC_REQUIRED", "Укажи releaseEpic из подключённой базы задач.");
  const changes = (input.changes || []).map(x => String(x).trim());
  if (!changes.length || changes.some(x => !x || x.length > 1800)) fail("RELEASE_CHANGELOG_REQUIRED", "Нужен непустой человекочитаемый changelog; один пункт должен помещаться в блок Notion.");
  if (!Array.isArray(input.deliveries) || !input.deliveries.length) fail("RELEASE_DELIVERIES_REQUIRED", "Нужен полный состав выпущенных сервисов.");
  const deliveries = input.deliveries.map(d => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(d.repository || "") || !String(d.service || "").trim()) fail("DELIVERY_REPOSITORY_REQUIRED", "Укажи репозиторий и русское название сервиса.");
    releaseBranchForVersion(d.version);
    if (!SHA.test(d.headSha || "") || (!SHA.test(d.baseSha || "") && !(d.initial === true && d.baseSha === ""))) fail("DELIVERY_GIT_POINT_REQUIRED", `У ${d.repository} нужны полные SHA; первая поставка явно отмечается initial.`);
    releaseDay(d.deployedAt, input.timeZone);
    const taskCodes = [...new Set((d.taskCodes || []).map(x => String(x).toUpperCase()))].filter(x => !/^[A-Z][A-Z0-9]*-0+$/u.test(x)).sort();
    if (taskCodes.some(x => !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/u.test(x))) fail("DELIVERY_TASK_CODE_INVALID", "Некорректный код входящей задачи.");
    const deliveryChanges = input.schemaVersion === 2 ? checkedChanges(d.changes, d.repository) : undefined;
    return { repository: d.repository, service: d.service.trim(), version: d.version,
      baseSha: d.baseSha, headSha: d.headSha, initial: d.initial === true,
      deployedAt: new Date(d.deployedAt).toISOString(), taskCodes,
      ...(deliveryChanges ? { changes: deliveryChanges } : {}) };
  }).sort((a, b) => a.repository.localeCompare(b.repository, "en"));
  if (new Set(deliveries.map(x => x.repository)).size !== deliveries.length) fail("DELIVERY_REPOSITORY_DUPLICATED", "Репозиторий повторяется в составе релиза.");
  const timeZone = input.timeZone || "UTC";
  const releaseDate = releaseDay(deliveries.map(x => x.deployedAt).sort().at(-1), timeZone);
  return { schemaVersion: input.schemaVersion, releaseSetId: input.releaseSetId, timeZone, releaseDate,
    releaseEpic: input.releaseEpic, changes, deliveries };
}

/** Сверяет changelog с полным подтверждённым deployment, включая независимые версии сервисов. */
export function validateDeployment(publication, deployment, { allowRepeat = false } = {}) {
  if (deployment?.schemaVersion !== 1 || deployment.outcome !== "deployed" || !RUN_ID.test(deployment.runId || "")) fail("DEPLOYMENT_NOT_CONFIRMED", "Нет подтверждения завершённого production-развёртывания.");
  if (deployment.releaseSetId !== publication.releaseSetId) fail("DEPLOYMENT_RELEASE_MISMATCH", "Evidence относится к другому набору релиза.");
  if (!["runner", "historical"].includes(deployment.evidence?.kind)) fail("DEPLOYMENT_PROVENANCE_REQUIRED", "Не указан источник подтверждения production-развёртывания.");
  if (deployment.evidence.kind === "historical" && (!deployment.evidence.sources?.length || !deployment.evidence.assessment)) fail("DEPLOYMENT_PROVENANCE_REQUIRED", "Исторический выпуск требует источников и заключения о фактическом результате.");
  const expected = publication.deliveries.map(x => [x.repository, x.version, x.headSha]);
  const actual = (deployment.deliveries || []).map(x => [x.repository, x.version, x.headSha]).sort((a, b) => a[0].localeCompare(b[0], "en"));
  if (canonicalJson(expected) !== canonicalJson(actual)) fail("DEPLOYMENT_COMPOSITION_MISMATCH", "Changelog и подтверждение deploy содержат разные поставки.");
  releaseDay(deployment.deployedAt, publication.timeZone);
  for (const delivery of deployment.deliveries) {
    const declared = publication.deliveries.find(x => x.repository === delivery.repository);
    // Повторный deploy может быть позднее первого выпуска, но не раньше него.
    const actualDate = Date.parse(delivery.verifiedAt || deployment.deployedAt);
    const declaredDate = Date.parse(declared.deployedAt);
    if (!Number.isFinite(actualDate) || (allowRepeat ? actualDate < declaredDate : actualDate !== declaredDate)) fail("DEPLOYMENT_DATE_MISMATCH", "Дата поставки расходится с подтверждением развёртывания.");
    if (deployment.evidence.kind === "runner" && (!DIGEST.test(delivery.archiveSha256 || "") || !/^sha256:[a-f0-9]{64}$/u.test(delivery.imageId || ""))) fail("DEPLOYMENT_IDENTITY_INVALID", "В подтверждении runner отсутствуют immutable image/archive SHA-256.");
  }
  return publicationDigest(deployment);
}

/** Читает страницы и схему до записи, чтобы конфликт поздней поставки не оставил частичный релиз. */
async function readContext(client, config, publication, releaseCode = "") {
  const { source, schema } = await inspectBacklogWorkspace(client, config, { requireTyped: true });
  const pages = await queryAllPages(client, source.id);
  const epic = pages.find(p => pageTaskCode(p, schema.idName) === publication.releaseEpic);
  if (!epic || pageTaskType(epic, schema) !== "Эпик") fail("RELEASE_EPIC_REQUIRED", "Не найден эпик релизов.");
  const matches = pages.filter(p => textProperty(p, SET) === publication.releaseSetId || (releaseCode && pageTaskCode(p, schema.idName) === releaseCode));
  if (matches.length > 1) fail("PUBLICATION_AMBIGUOUS", "Набору релиза соответствует несколько страниц.");
  const page = matches[0];
  if (page && (pageTaskType(page, schema) !== "История" || canonicalJson(pageParentIds(page, schema)) !== canonicalJson([epic.id]))) fail("PUBLICATION_PARENT_MISMATCH", "Страница должна быть историей выбранного release-эпика.");
  if (page && textProperty(page, SET) && textProperty(page, SET) !== publication.releaseSetId) fail("PUBLICATION_IDENTITY_CONFLICT", "Страница уже принадлежит другому набору релиза.");
  const databases = (await listAllChildren(client, epic.id)).filter(b => b.type === "child_database" && b.child_database.title === "Поставки релиза");
  if (databases.length !== 1) fail("RELEASE_INFRA_REQUIRED", "В release-эпике должна быть одна база поставок.");
  const deliveries = await resolveDataSource(client, databases[0].id);
  const deliverySchema = discoverDeliverySchema(deliveries.metadata);
  const deliveryPages = await queryAllPages(client, deliveries.id);
  return { source, schema, pages, epic, page, deliveries, deliverySchema, deliveryPages, adopting: Boolean(releaseCode) };
}

/** Вычисляет весь план строк и проверяет заморозку до первой мутации в Notion. */
function planDeliveries(context, publication, { amendment = false } = {}) {
  const { page, pages, schema, deliveryPages, deliverySchema: ds } = context;
  const current = page ? deliveryPages.filter(p => relation(p, ds.release).includes(page.id)) : [];
  const fingerprint = publicationDigest(publication);
  if (!amendment && page && textProperty(page, INTENT) && textProperty(page, INTENT) !== fingerprint) fail("PUBLICATION_INTENT_CONFLICT", "Содержание публикации отличается от сохранённого намерения.");
  if (!amendment && page && textProperty(page, PUBLISHED) && textProperty(page, PUBLISHED) !== fingerprint) fail("PUBLICATION_FROZEN", "Опубликованный changelog неизменяем.");
  const legacyFrozen = page && !textProperty(page, INTENT) && current.some(p => p.properties[ds.state]?.select?.name === "Развёрнута");
  if (current.some(p => !publication.deliveries.some(d => d.repository === textProperty(p, ds.title)))) fail("PUBLICATION_MEMBERSHIP_CONFLICT", "Страница содержит поставку, отсутствующую в changelog.");
  if (legacyFrozen && current.length !== publication.deliveries.length) fail("RELEASE_FROZEN", "Состав ранее выпущенного релиза изменять нельзя.");
  return publication.deliveries.map(item => {
    const taskIds = item.taskCodes.map(code => {
      const task = pages.find(p => pageTaskCode(p, schema.idName) === code);
      if (!task) fail("DELIVERY_TASK_NOT_FOUND", `Задача ${code} не найдена.`);
      if (!["Задача", "Баг"].includes(pageTaskType(task, schema))) fail("DELIVERY_TASK_TYPE_INVALID", `${code} должен быть задачей или багом.`);
      if (pageStatus(task, schema) !== "Закрыто") fail("DELIVERY_TASK_UNCLOSED", `${code} должен быть закрыт до поставки.`);
      if (deliveryPages.some(p => relation(p, ds.tasks).includes(task.id) && !relation(p, ds.release).includes(page?.id))) fail("DELIVERY_TASK_OTHER_RELEASE", `${code} уже связан с другим релизом.`);
      return task.id;
    });
    const existing = current.filter(p => textProperty(p, ds.title) === item.repository);
    if (existing.length > 1) fail("DELIVERY_AMBIGUOUS", `Несколько поставок ${item.repository} в одном релизе.`);
    const previous = deliveryPages.filter(p => textProperty(p, ds.title) === item.repository && !relation(p, ds.release).includes(page?.id) && p.properties[ds.state]?.select?.name === "Развёрнута" && textProperty(p, ds.headSha) === item.baseSha && Date.parse(p.properties[ds.deployedAt]?.date?.start) <= Date.parse(item.deployedAt))
      .sort((a, b) => Date.parse(b.properties[ds.deployedAt].date.start) - Date.parse(a.properties[ds.deployedAt].date.start))[0];
    const baseline = (textProperty(page, BASELINE) || "").split(",").includes(item.repository);
    if (!item.initial && !previous && !legacyFrozen && !context.adopting && !baseline) fail("DELIVERY_PREVIOUS_NOT_FOUND", `Для ${item.repository} не найдена предыдущая поставка с SHA ${item.baseSha}.`);
    const desired = { ...item, state: "Развёрнута", releaseId: page?.id || "", taskIds,
      previousDeliveryId: previous?.id || "" };
    validatePreviousDelivery(deliveryPages, desired, ds);
    if (existing[0]) assertFrozenDeliveryUnchanged(existing[0], amendment ? { ...desired, taskIds: relation(existing[0], ds.tasks) } : desired, ds);
    return { existing: existing[0], desired };
  });
}

/** Проверяет весь опубликованный текст и поля; одна ссылка на Notion не подтверждает завершение. */
function assertPageContent(page, blocks, publication, schema) {
  if (pageTitle(page, schema.titleName) !== formatReleaseTitleRu(publication.releaseDate) || pageReleaseDate(page, schema) !== publication.releaseDate) fail("PUBLICATION_DATE_MISMATCH", "Название или дата релиза в Notion отличаются от фактического выпуска.");
  const textBlocks = blocks.filter(b => b.type !== "child_database");
  const expected = buildReleaseStoryTemplate({ releaseDate: publication.releaseDate, changes: publication.changes });
  // Сохраняем оба исторических формата даты, сверяя их полное содержимое.
  const dates = [Number.NaN, Number(publication.releaseDate.slice(0, 4))].map(currentYear =>
    `Дата релиза — ${formatReleaseDateRu(publication.releaseDate, { currentYear })}`);
  if (!dates.includes(blockText(textBlocks[0]))) fail("PUBLICATION_DATE_MISMATCH", "Дата в видимом callout расходится с выпуском.");
  const signature = xs => xs.slice(1).map(b => [b.type, blockText(b)]);
  if (textBlocks[0]?.type !== "callout" || canonicalJson(signature(textBlocks)) !== canonicalJson(signature(expected))) fail("PUBLICATION_CHANGELOG_MISMATCH", "Changelog в Notion отличается от проверенного текста.");
}

async function ensurePublicationSchema(client, source) {
  const properties = {};
  for (const key of [SET, INTENT, PUBLISHED, BASELINE, AMENDMENT]) {
    const actual = source.metadata.properties[key];
    if (actual && actual.type !== "rich_text") fail("PUBLICATION_SCHEMA_INVALID", `Свойство ${key} должно иметь тип rich_text.`);
    if (!actual) properties[key] = { rich_text: {} };
  }
  if (Object.keys(properties).length) await client.request(`/data_sources/${source.id}`, { method: "PATCH", body: { properties } });
}

/** Публикует полный релиз и возобновляет только то же намерение после внешнего сбоя. */
export async function publishRelease(client, config, input, deployment, { releaseCode = "" } = {}) {
  const publication = normalizePublication(input);
  const deploymentSha256 = validateDeployment(publication, deployment, { allowRepeat: true });
  const fingerprint = publicationDigest(publication);
  let context = await readContext(client, config, publication, releaseCode);
  validateDeployment(publication, deployment, { allowRepeat: Boolean(context.page && textProperty(context.page, PUBLISHED)) });
  const plan = planDeliveries(context, publication);
  if (context.page) assertPageContent(context.page, await listAllChildren(client, context.page.id), publication, context.schema);
  await verifyDeliveryContents(client, plan, publication, { allowPrefix: true });
  await ensurePublicationSchema(client, context.source);
  let page = context.page;
  if (!page) {
    const created = await createTaskItem(client, config, { type: "История", releaseHistory: true, estimatedCodeLines: 0,
      parentCode: publication.releaseEpic, releaseDate: publication.releaseDate,
      changes: publication.changes, releaseSetId: publication.releaseSetId, publicationIntent: fingerprint });
    page = created.page;
  } else if (!textProperty(page, INTENT) || context.adopting) {
    page = await client.request(`/pages/${page.id}`, { method: "PATCH", body: { properties: {
      [SET]: rich(publication.releaseSetId), [INTENT]: rich(fingerprint),
      [BASELINE]: rich(plan.filter(x => !x.desired.initial && !x.desired.previousDeliveryId).map(x => x.desired.repository).sort().join(",")),
    } } });
  }
  const code = pageTaskCode(page, context.schema.idName);
  await ensureReleaseInfrastructure(client, config, code);
  await ensureReleaseViews(client, config, { source: context.source, schema: context.schema, releasePage: page });
  for (const item of plan) {
    const desired = { ...item.desired, releaseId: page.id };
    if (!item.existing) item.existing = await createDataPage(client, context.deliveries.id, deliveryProperties(context.deliverySchema, desired));
    else if (item.existing.properties[context.deliverySchema.state]?.select?.name !== "Развёрнута") await client.request(`/pages/${item.existing.id}`, { method: "PATCH", body: { properties: deliveryProperties(context.deliverySchema, desired) } });
  }
  await writeDeliveryContents(client, plan, publication);
  // Завершение записывается только после полного read-back. До него добавление
  // недостающих строк разрешено лишь для исходного fingerprint всего манифеста.
  context = await readContext(client, config, publication);
  verifyReadBack(context, await listAllChildren(client, page.id), publication);
  await verifyDeliveryContents(client, planDeliveries(context, publication), publication);
  await client.request(`/pages/${page.id}`, { method: "PATCH", body: { properties: { [PUBLISHED]: rich(fingerprint) } } });
  const receipt = { schemaVersion: 2, status: "published", releaseSetId: publication.releaseSetId,
    runId: deployment.runId, deploymentSha256, publicationSha256: fingerprint,
    changelogSha256: publicationDigest(publication.changes),
    deliveryChangelogSha256: publicationDigest(publication.deliveries.map(d => [d.repository, d.changes])),
    predecessorsSha256: publicationDigest(plan.map(x => [x.desired.repository, x.desired.previousDeliveryId])), releasePageId: page.id,
    releaseUrl: `https://www.notion.so/${page.id.replaceAll("-", "")}`,
    releaseCode: code, verifiedAt: new Date().toISOString() };
  await checkPublication(client, config, publication, deployment, receipt);
  return { publication, receipt };
}

function verifyReadBack(context, blocks, publication) {
  if (!context.page || textProperty(context.page, SET) !== publication.releaseSetId || textProperty(context.page, INTENT) !== publicationDigest(publication)) fail("PUBLICATION_NOT_FOUND", "Notion не подтвердил идентичность публикации.");
  assertPageContent(context.page, blocks, publication, context.schema);
  const plan = planDeliveries(context, publication);
  if (plan.some(x => !x.existing || x.existing.properties[context.deliverySchema.state]?.select?.name !== "Развёрнута")) fail("PUBLICATION_INCOMPLETE", "В Notion записан неполный состав релиза.");
  for (const x of plan) {
    if (textProperty(x.existing, context.deliverySchema.service) !== x.desired.service) fail("PUBLICATION_SERVICE_MISMATCH", "Название сервиса в Notion отличается от манифеста.");
  }
}

/** Сверяет receipt с текущими данными Notion и точным production-run. */
export async function checkPublication(client, config, input, deployment, receipt) {
  const publication = normalizePublication(input, { allowLegacy: true });
  const deploymentSha256 = validateDeployment(publication, deployment, { allowRepeat: true });
  if (receipt?.schemaVersion !== publication.schemaVersion || receipt.status !== "published" || receipt.runId !== deployment.runId || receipt.releaseSetId !== publication.releaseSetId || receipt.deploymentSha256 !== deploymentSha256 || receipt.publicationSha256 !== publicationDigest(publication) || receipt.changelogSha256 !== publicationDigest(publication.changes)) fail("PUBLICATION_RECEIPT_MISMATCH", "Подтверждение относится к другому запуску, составу или changelog.");
  if (publication.schemaVersion === 2 && receipt.deliveryChangelogSha256 !== publicationDigest(publication.deliveries.map(d => [d.repository, d.changes]))) fail("PUBLICATION_RECEIPT_MISMATCH", "Receipt не подтверждает changelog каждой поставки.");
  const context = await readContext(client, config, publication);
  if (!context.page || receipt.releasePageId !== context.page.id || receipt.releaseUrl !== `https://www.notion.so/${context.page.id.replaceAll("-", "")}` || textProperty(context.page, PUBLISHED) !== receipt.publicationSha256) fail("PUBLICATION_NOT_CONFIRMED", "Notion не подтвердил завершённую публикацию указанного релиза.");
  verifyReadBack(context, await listAllChildren(client, context.page.id), publication);
  if (receipt.predecessorsSha256 !== publicationDigest(planDeliveries(context, publication).map(x => [x.desired.repository, x.desired.previousDeliveryId]))) fail("PUBLICATION_PREDECESSOR_MISMATCH", "Связи с предыдущими поставками отличаются от подтверждения.");
  await verifyDeliveryContents(client, planDeliveries(context, publication), publication);
  const businessSource = await resolveDataSource(client, config.businessDatabaseId);
  const businessSchema = discoverBusinessSchema(businessSource.metadata, config);
  const historyPages = (await queryAllPages(client, businessSource.id)).filter(p => pageTitle(p, businessSchema.titleName) === "История релизов");
  if (historyPages.length !== 1) fail("RELEASE_HISTORY_BUSINESS_AMBIGUOUS", "Нужна одна страница истории релизов.");
  const historyPage = historyPages[0];
  if (!historyPage) fail("RELEASE_HISTORY_BUSINESS_AMBIGUOUS", "Не найдена страница истории релизов.");
  await validateReleaseViews(client, { source: context.source, schema: context.schema, releasePage: context.page, historyPage });
  const views = [];
  for (const database of (await listAllChildren(client, context.page.id)).filter(x => x.type === "child_database")) {
    const result = await client.request(`/views?database_id=${encodeURIComponent(database.id)}&page_size=100`);
    for (const view of result.results || []) views.push(await client.request(`/views/${view.id}`));
  }
  const deliveryViews = views.filter(x => x.name === "Поставки релиза");
  if (deliveryViews.length !== 1 || deliveryViews[0].data_source_id !== context.deliveries.id || deliveryViews[0].filter?.relation?.contains !== context.page.id) fail("PUBLICATION_DELIVERY_VIEW_INVALID", "Представление поставок не показывает текущий релиз.");
  return receipt;
}

/** Дополняет историю по явному поручению, сохраняя исходную редакцию и production identity. */
export async function amendPublication(client, config, input, deployment, previous) {
  const publication = normalizePublication(input);
  const original = normalizePublication(previous?.publication, { allowLegacy: true });
  const immutable = value => ({ ...value, schemaVersion: 2, changes: [],
    deliveries: value.deliveries.map(({ changes, taskCodes, ...delivery }) => delivery) });
  if (canonicalJson(immutable(publication)) !== canonicalJson(immutable(original)))
    fail("PUBLICATION_AMENDMENT_IDENTITY", "Дополнение не может менять состав, версии, SHA или дату поставки.");
  if (canonicalJson(publication.changes.slice(0, original.changes.length)) !== canonicalJson(original.changes) ||
      original.deliveries.some((d, i) => d.taskCodes.some(code => !publication.deliveries[i].taskCodes.includes(code)) ||
        canonicalJson(publication.deliveries[i].changes.slice(0, (d.changes || []).length)) !== canonicalJson(d.changes || [])))
    fail("PUBLICATION_AMENDMENT_REMOVAL", "Дополнение сохраняет прежний changelog и связи с задачами.");
  const from = publicationDigest(original), to = publicationDigest(publication);
  if (from === to) { await checkPublication(client, config, publication, deployment, previous.receipt); return previous; }
  const deploymentSha256 = validateDeployment(publication, deployment, { allowRepeat: true });
  if (previous.receipt?.publicationSha256 !== from || previous.receipt.deploymentSha256 !== deploymentSha256)
    fail("PUBLICATION_RECEIPT_MISMATCH", "Исходный receipt относится к другой редакции или deploy.");
  let context = await readContext(client, config, publication);
  if (!context.page || context.page.id !== previous.receipt.releasePageId)
    fail("PUBLICATION_NOT_FOUND", "Не найдена исходная страница дополнения.");
  const intent = publicationDigest({ from, to });
  const completed = textProperty(context.page, PUBLISHED) === to;
  const pending = textProperty(context.page, AMENDMENT) === intent;
  if (!completed && !pending) await checkPublication(client, config, original, deployment, previous.receipt);
  if (pending && ![from, to].includes(textProperty(context.page, PUBLISHED)))
    fail("PUBLICATION_AMENDMENT_CONFLICT", "Публикация имеет другую исходную редакцию.");
  const plan = planDeliveries(context, publication, { amendment: true });
  const oldPlan = planDeliveries(context, original, { amendment: true });
  for (let i = 0; i < plan.length; i++) {
    const actual = relation(plan[i].existing, context.deliverySchema.tasks).sort();
    if (![oldPlan[i].desired.taskIds, plan[i].desired.taskIds].some(ids => canonicalJson([...ids].sort()) === canonicalJson(actual)))
      fail("PUBLICATION_AMENDMENT_CONFLICT", "Связи поставки изменились вне дополнения.");
    if (original.schemaVersion === 2) {
      const body = await listAllChildren(client, plan[i].existing.id);
      const minimum = deliveryBlocks(original.deliveries[i].changes);
      if (body.length < minimum.length) fail("PUBLICATION_AMENDMENT_CONFLICT", "Удалена часть исходного changelog поставки.");
      assertBlockPrefix(body.slice(0, minimum.length), minimum, false);
    }
  }
  const blocks = (await listAllChildren(client, context.page.id)).filter(b => b.type !== "child_database");
  // Дата проверяется отдельно, затем разрешён только непрерывный хвост changelog.
  assertPageContent(context.page, [blocks[0], ...buildReleaseStoryTemplate({ releaseDate: original.releaseDate, changes: original.changes }).slice(1)], original, context.schema);
  const expected = buildReleaseStoryTemplate({ releaseDate: publication.releaseDate, changes: publication.changes });
  if (blocks.length < buildReleaseStoryTemplate({ releaseDate: original.releaseDate, changes: original.changes }).length)
    fail("PUBLICATION_AMENDMENT_CONFLICT", "Удалена часть исходного changelog релиза.");
  if (blocks.filter(b => b.type === "divider").length !== 1 || blocks.at(-1)?.type !== "divider") fail("PUBLICATION_CHANGELOG_MISMATCH", "Нарушена структура changelog релиза.");
  assertBlockPrefix(blocks.slice(0, -1), [blocks[0], ...expected.slice(1, -1)], true);
  await verifyDeliveryContents(client, plan, publication, { allowPrefix: true });
  if (!completed) {
    await ensurePublicationSchema(client, context.source);
    if (!pending) await client.request(`/pages/${context.page.id}`, { method: "PATCH", body: { properties: { [AMENDMENT]: rich(intent) } } });
    await appendSuffix(client, context.page.id, expected, { release: true });
    await writeDeliveryContents(client, plan, publication);
    for (const item of plan) if (canonicalJson(relation(item.existing, context.deliverySchema.tasks).sort()) !== canonicalJson([...item.desired.taskIds].sort()))
      await client.request(`/pages/${item.existing.id}`, { method: "PATCH", body: { properties: {
        [context.deliverySchema.tasks]: { relation: item.desired.taskIds.map(id => ({ id })) },
      } } });
    context = await readContext(client, config, publication);
    const actualPlan = planDeliveries(context, publication, { amendment: true });
    await verifyDeliveryContents(client, actualPlan, publication);
    assertPageContent(context.page, await listAllChildren(client, context.page.id), publication, context.schema);
    for (const item of actualPlan) assertFrozenDeliveryUnchanged(item.existing, item.desired, context.deliverySchema);
    await client.request(`/pages/${context.page.id}`, { method: "PATCH", body: { properties: { [INTENT]: rich(to), [PUBLISHED]: rich(to) } } });
  }
  const receipt = { ...previous.receipt, schemaVersion: 2, publicationSha256: to,
    previousPublicationSha256: from, changelogSha256: publicationDigest(publication.changes),
    deliveryChangelogSha256: publicationDigest(publication.deliveries.map(d => [d.repository, d.changes])),
    verifiedAt: new Date().toISOString() };
  await checkPublication(client, config, publication, deployment, receipt);
  return { publication, receipt };
}

/** Сохраняет receipt атомарно, чтобы прерывание не оставило ложное подтверждение завершения. */
async function saveJson(path, document) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** Проверяет все входные файлы истории до записи и продолжает публикацию по durable receipts. */
export async function publishHistory(client, config, historyPath, { checkOnly = false, amend = false, progress = () => {} } = {}) {
  const root = dirname(resolve(historyPath));
  const index = JSON.parse(await readFile(resolve(historyPath), "utf8"));
  if (!Array.isArray(index.releaseSets) || !index.releaseSets.length) fail("RELEASE_HISTORY_INVALID", "История должна содержать releaseSets.");
  const items = [];
  const ids = new Set();
  for (const entry of index.releaseSets) {
    if (!entry.publication || !entry.evidence || ids.has(entry.id)) fail("RELEASE_HISTORY_INVALID", "Нужны уникальные release sets и пути publication/evidence.");
    ids.add(entry.id);
    const input = normalizePublication(JSON.parse(await readFile(resolve(root, entry.publication), "utf8")));
    const deployment = JSON.parse(await readFile(resolve(root, entry.evidence), "utf8"));
    if (entry.id !== input.releaseSetId) fail("RELEASE_HISTORY_INVALID", "Идентификатор раздела расходится с манифестом.");
    validateDeployment(input, deployment, { allowRepeat: true });
    items.push({ input, deployment, receiptPath: resolve(root, entry.id, "receipt.json"), releaseCode: entry.adoptReleaseCode || "" });
  }
  const receipts = [];
  for (const item of items) {
    let saved;
    try { saved = JSON.parse(await readFile(item.receiptPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    progress(`Проверка ${item.input.releaseSetId}: ${receipts.length}/${items.length} завершено.`);
    try {
      if (saved && amend && saved.receipt.publicationSha256 !== publicationDigest(item.input)) {
        const archive = resolve(dirname(item.receiptPath), `receipt-${saved.receipt.publicationSha256}.json`);
        await saveJson(archive, saved);
        saved = await amendPublication(client, config, item.input, item.deployment, saved);
        await saveJson(item.receiptPath, saved);
      } else if (saved) await checkPublication(client, config, item.input, item.deployment, saved.receipt);
      else if (checkOnly) fail("PUBLICATION_RECEIPT_REQUIRED", "Для этого выпуска отсутствует receipt.");
      else {
        saved = await publishRelease(client, config, item.input, item.deployment, { releaseCode: item.releaseCode });
        await saveJson(item.receiptPath, saved);
      }
    } catch (error) {
      const code = error.code || "PUBLICATION_FAILED";
      throw new TaskNotionError(code, `${item.input.releaseSetId}: ${error.message} Подтверждено ${receipts.length}/${items.length}. Сохранённые receipt находятся рядом с манифестами. Продолжи ту же команду после устранения причины.`, { external: Boolean(error.external), cause: error });
    }
    receipts.push(saved.receipt);
    progress(`${saved.receipt.releaseCode}: ${saved.receipt.releaseUrl}`);
  }
  progress(`История подтверждена: ${receipts.length} выпусков, ${items.reduce((sum, item) => sum + item.input.deliveries.length, 0)} поставок.`);
  return receipts;
}

/** Даёт оператору единый путь публикации и повторной проверки после сбоя Notion. */
export async function runPublication(argv) {
  if (argv.includes("--help")) {
    process.stdout.write("task:release-manifest -- publish|check --manifest publication.json --evidence deployment.json --receipt receipt.json [--release CODE-N]\nДля истории: publish|check --history release-history.json\n");
    return;
  }
  const [command, ...args] = argv;
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--manifest", "--evidence", "--receipt", "--release", "--history"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) fail("INVALID_ARGUMENT", "Нужны --manifest, --evidence и --receipt.");
    flags[args[i].slice(2)] = args[i + 1];
  }
  if (flags.history) {
    if (Object.keys(flags).length !== 1) fail("INVALID_ARGUMENT", "--history используется отдельно от манифеста одного выпуска.");
    const config = await loadConfig();
    await publishHistory(new NotionClient({ token: config.token }), config, flags.history,
      { checkOnly: command === "check", amend: command === "amend", progress: message => process.stdout.write(`${message}\n`) });
    return;
  }
  if (!flags.manifest || !flags.evidence || !flags.receipt) fail("INVALID_ARGUMENT", "Нужны --manifest, --evidence и --receipt.");
  const input = JSON.parse(await readFile(resolve(flags.manifest), "utf8"));
  const deployment = JSON.parse(await readFile(resolve(flags.evidence), "utf8"));
  const config = await loadConfig();
  const client = new NotionClient({ token: config.token });
  let receipt;
  if (command === "amend") {
    const saved = JSON.parse(await readFile(resolve(flags.receipt), "utf8"));
    await saveJson(resolve(dirname(flags.receipt), `receipt-${saved.receipt.publicationSha256}.json`), saved);
    const result = await amendPublication(client, config, input, deployment, saved);
    receipt = result.receipt;
    await saveJson(resolve(flags.receipt), result);
  } else if (command === "publish") {
    const result = await publishRelease(client, config, input, deployment, { releaseCode: flags.release || "" });
    receipt = result.receipt;
    await saveJson(resolve(flags.receipt), { publication: result.publication, receipt });
  } else {
    const saved = JSON.parse(await readFile(resolve(flags.receipt), "utf8"));
    receipt = await checkPublication(client, config, input, deployment, saved.receipt);
  }
  process.stdout.write(`${receipt.releaseCode}: changelog, дата и состав подтверждены в Notion. ${receipt.releaseUrl}\nПодтверждение: ${resolve(flags.receipt)}\n`);
}
