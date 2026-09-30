import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATUS_FLOW, TASK_TYPES, SIZES, PRIORITIES, CALLOUT_ICON, TaskNotionError } from "./notion-workflow-lib.mjs";
import { deliveryDatabaseBody } from "./task-release-manifest.mjs";
import { normalizePublication, validateDeployment, publishRelease, checkPublication, publicationDigest, releaseDay, publishHistory, amendPublication } from "./release-publication.mjs";

const clone = x => structuredClone(x);
const text = value => [{ type: "text", text: { content: value } }];
const rich = value => ({ rich_text: text(value) });
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function sample(set = "release-a") {
  const input = { schemaVersion: 2, releaseSetId: set, releaseEpic: "W-280",
    changes: ["Исправлено сохранение статуса заявки после обновления страницы."],
    deliveries: ["sample-api", "sample-web"].map((repository, index) => ({
      repository, service: index ? "Web-клиент" : "Сервис заявок", version: "1.2.0",
      initial: true, baseSha: "", headSha: String(index + 1).repeat(40),
      changes: [index ? "Форма сохраняет статус заявки." : "API возвращает обновлённый статус заявки."],
      deployedAt: "2026-09-12T22:30:00Z", taskCodes: ["W-000"],
    })) };
  const deployment = { schemaVersion: 1, outcome: "deployed", runId: "20260912T223000Z-123",
    releaseSetId: set, deployedAt: "2026-09-12T22:30:00Z", evidence: { kind: "runner" },
    deliveries: input.deliveries.map(d => ({ repository: d.repository, version: d.version,
      headSha: d.headSha, verifiedAt: d.deployedAt, imageId: `sha256:${"a".repeat(64)}`, archiveSha256: "b".repeat(64) })) };
  return { input, deployment };
}

/** Хранит страницы и частичные записи, чтобы retry проверял реальное промежуточное состояние. */
class NotionMemory {
  constructor() {
    this.sequence = 400;
    this.mutations = [];
    this.failAtDelivery = 0;
    this.deliveryWrites = 0;
    this.failAtFinalize = false;
    const select = options => ({ type: "select", select: { options: options.map(name => ({ name })) } });
    const plain = type => ({ type, [type]: {} });
    this.sources = {
      backlog: { id: "backlog", object: "data_source", properties: {
        Название: plain("title"), ID: plain("unique_id"),
        Статус: { type: "status", status: { options: STATUS_FLOW.map(name => ({ name })) } },
        Тип: select(TASK_TYPES), Приоритет: select(PRIORITIES), Размер: select(SIZES),
        "Технический долг": plain("checkbox"), "Дата релиза": plain("date"),
        "Parent item": plain("relation"), Релиз: plain("relation"), "Баг релиза": plain("relation"),
        "Входящие задачи": plain("relation"), "Релиз-процесс": select(["v1"]),
      } },
      deliveries: { id: "deliveries", object: "data_source", properties: Object.fromEntries(
        Object.entries({ ...deliveryDatabaseBody(uuid(280), "backlog").initial_data_source.properties,
          "Предыдущая поставка": { relation: {} } }).map(([key, value]) => [key, { type: Object.keys(value)[0], ...value }])) },
      business: { id: "business", object: "data_source", properties: {
        Название: plain("title"), "Parent item": plain("relation"), "Sub-item": plain("relation"),
      } },
    };
    this.pages = {
      backlog: [{ object: "page", id: uuid(280), properties: {
        ID: { unique_id: { prefix: "W", number: 280 } }, Название: { title: text("Релизы продукта") },
        Тип: { select: { name: "Эпик" } }, "Parent item": { relation: [] },
      } }],
      deliveries: [], business: [{ object: "page", id: uuid(281), icon: { type: "emoji", emoji: CALLOUT_ICON }, properties: {
        Название: { title: text("История релизов") }, "Parent item": { relation: [] }, "Sub-item": { relation: [] },
      } }],
    };
    this.blocks = { [uuid(280)]: [{ type: "child_database", id: "deliveries", child_database: { title: "Поставки релиза" } }], [uuid(281)]: [] };
    this.views = {};
  }

  async request(path, { method = "GET", body } = {}) {
    if (method !== "GET" && !path.endsWith("/query")) this.mutations.push({ path, method, body: clone(body) });
    let match;
    if ((match = path.match(/^\/data_sources\/([^/]+)$/u))) {
      const source = this.sources[match[1]];
      if (!source) throw new TaskNotionError("NOTION_HTTP_404", "source missing");
      if (method === "PATCH") for (const [key, value] of Object.entries(body.properties)) source.properties[key] = { type: Object.keys(value)[0], ...value };
      return clone(source);
    }
    if ((match = path.match(/^\/data_sources\/([^/]+)\/query$/u))) return { results: clone(this.pages[match[1]]), has_more: false };
    if ((match = path.match(/^\/blocks\/([^/]+)\/children/u))) {
      const blocks = this.blocks[match[1]] ||= [];
      if (method === "PATCH") {
        const additions = clone(body.children).map(b => ({ ...b, id: uuid(++this.sequence) }));
        if (body.position) { const index = blocks.findIndex(b => b.id === body.position.after_block.id); assert.ok(index >= 0); blocks.splice(index + 1, 0, ...additions); }
        else blocks.push(...additions);
        if (this.failAfterAppend) { this.failAfterAppend = false; throw new TaskNotionError("NOTION_WRITE_OUTCOME_UNKNOWN", "response lost"); }
      }
      return { results: clone(blocks), has_more: false };
    }
    if (path === "/pages" && method === "POST") {
      const source = body.parent.data_source_id;
      if (source === "deliveries" && ++this.deliveryWrites === this.failAtDelivery) throw new TaskNotionError("NOTION_HTTP_503", "injected failure");
      const number = ++this.sequence;
      const page = { object: "page", id: uuid(number), properties: clone(body.properties) };
      if (source === "backlog") page.properties.ID = { unique_id: { prefix: "W", number } };
      this.pages[source].push(page);
      this.blocks[page.id] = clone(body.children || []).map(b => ({ ...b, id: uuid(++this.sequence) }));
      return clone(page);
    }
    if ((match = path.match(/^\/pages\/([^/]+)$/u))) {
      const page = Object.values(this.pages).flat().find(x => x.id === match[1]);
      assert.ok(page, path);
      if (method === "PATCH") {
        if (body.properties["Публикация SHA-256"] && this.failAtFinalize) throw new TaskNotionError("NOTION_HTTP_503", "injected finalize failure");
        Object.assign(page.properties, clone(body.properties));
      }
      return clone(page);
    }
    if (path === "/views" && method === "POST") {
      const id = uuid(++this.sequence), database = uuid(++this.sequence);
      this.views[id] = { id, ...clone(body), database_id: database };
      const parent = body.create_database.parent.page_id;
      (this.blocks[parent] ||= []).push({ type: "child_database", id: database, child_database: { title: "Untitled" } });
      return clone(this.views[id]);
    }
    if (path.startsWith("/views?")) {
      const database = new URL(`https://notion.test${path}`).searchParams.get("database_id");
      return { results: Object.values(this.views).filter(x => x.database_id === database).map(x => ({ id: x.id })) };
    }
    if ((match = path.match(/^\/views\/([^/]+)$/u))) {
      if (method === "PATCH") Object.assign(this.views[match[1]], clone(body));
      return clone(this.views[match[1]]);
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  }
}

const config = { databaseId: "backlog", businessDatabaseId: "business" };

test("пустой changelog последней поставки отклоняется до записей", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  input.deliveries.at(-1).changes = [];
  await assert.rejects(publishRelease(client, config, input, deployment), { code: "DELIVERY_CHANGELOG_REQUIRED" });
  assert.equal(client.mutations.length, 0);
});

test("дополнение сохраняет identity и возобновляет вставку после потери ответа", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  const original = await publishRelease(client, config, input, deployment);
  const next = clone(input); next.changes.push("Добавлен просмотр журнала обработки.");
  next.deliveries[1].changes.push("В журнале видны время обработки и результат.");
  const changed = clone(next); changed.deliveries[0].headSha = "c".repeat(40);
  const count = client.mutations.length;
  await assert.rejects(amendPublication(client, config, changed, deployment, original), { code: "PUBLICATION_AMENDMENT_IDENTITY" });
  assert.equal(client.mutations.length, count);
  client.failAfterAppend = true;
  await assert.rejects(amendPublication(client, config, next, deployment, original), { code: "NOTION_WRITE_OUTCOME_UNKNOWN" });
  const amended = await amendPublication(client, config, next, deployment, original);
  await checkPublication(client, config, next, deployment, amended.receipt);
  assert.equal(amended.receipt.previousPublicationSha256, original.receipt.publicationSha256);
  assert.equal(client.pages.deliveries.length, 2);
  await amendPublication(client, config, next, deployment, original);
  const web = client.pages.deliveries.find(p => Object.values(p.properties).some(v => v.title?.[0]?.text?.content === "sample-web"));
  client.blocks[web.id][1].bulleted_list_item.rich_text = text("Изменения другого сервиса");
  await assert.rejects(checkPublication(client, config, next, deployment, amended.receipt), { code: "DELIVERY_CHANGELOG_MISMATCH" });
});

test("schema1 может быть проверена и дополнена, новая публикация требует schema2", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  const original = await publishRelease(client, config, input, deployment);
  const legacy = clone(original.publication); legacy.schemaVersion = 1;
  for (const d of legacy.deliveries) delete d.changes;
  const hash = publicationDigest(legacy);
  const receipt = { ...original.receipt, schemaVersion: 1, publicationSha256: hash };
  delete receipt.deliveryChangelogSha256;
  const release = client.pages.backlog.at(-1);
  release.properties["Манифест публикации"] = rich(hash);
  release.properties["Публикация SHA-256"] = rich(hash);
  for (const p of client.pages.deliveries) client.blocks[p.id] = [];
  await checkPublication(client, config, legacy, deployment, receipt);
  await assert.rejects(publishRelease(client, config, legacy, deployment), { code: "PUBLICATION_MANIFEST_INVALID" });
  const result = await amendPublication(client, config, input, deployment, { publication: legacy, receipt });
  await checkPublication(client, config, input, deployment, result.receipt);
});

test("повтор дополнения отклоняет удаление исходного тела после сохранения intent", async () => {
  for (const target of ["release", "delivery"]) {
    const client = new NotionMemory(); const { input, deployment } = sample();
    const original = await publishRelease(client, config, input, deployment);
    const next = clone(input); next.changes.push("Дополнена история обработки заявок.");
    next.deliveries[0].changes.push("Сохранена история обработки заявки.");
    client.failAfterAppend = true;
    await assert.rejects(amendPublication(client, config, next, deployment, original), { code: "NOTION_WRITE_OUTCOME_UNKNOWN" });
    if (target === "delivery") client.blocks[client.pages.deliveries[0].id] = [];
    else client.blocks[original.receipt.releasePageId] = client.blocks[original.receipt.releasePageId].filter(b => b.type !== "bulleted_list_item");
    const before = client.mutations.length;
    await assert.rejects(amendPublication(client, config, next, deployment, original), { code: "PUBLICATION_AMENDMENT_CONFLICT" });
    assert.equal(client.mutations.length, before);
  }
});

test("W-000 требует changelog и не создаёт ссылку на фиктивную задачу", () => {
  const { input, deployment } = sample();
  assert.deepEqual(normalizePublication(input).deliveries[0].taskCodes, []);
  const custom = structuredClone(input);
  custom.releaseEpic = "OPS-42";
  custom.deliveries[0].taskCodes = ["OPS-000", "OPS-8"];
  assert.deepEqual(normalizePublication(custom).deliveries[0].taskCodes, ["OPS-8"]);
  assert.throws(() => normalizePublication({ ...input, releaseEpic: undefined }), { code: "RELEASE_EPIC_REQUIRED" });
  assert.equal(normalizePublication(input).releaseDate, "2026-09-12");
  assert.equal(releaseDay("2026-09-12T22:30:00Z"), "2026-09-12");
  assert.throws(() => normalizePublication({ ...input, changes: [] }), { code: "RELEASE_CHANGELOG_REQUIRED" });
  assert.throws(() => validateDeployment(normalizePublication(input), { ...deployment, deliveries: deployment.deliveries.slice(1) }), { code: "DEPLOYMENT_COMPOSITION_MISMATCH" });
  assert.throws(() => validateDeployment(normalizePublication(input), { ...deployment, outcome: "rolled_back" }), { code: "DEPLOYMENT_NOT_CONFIRMED" });
});

test("дата выпуска использует UTC по умолчанию и выбранный часовой пояс", () => {
  const { input } = sample();
  const publication = normalizePublication(input);
  assert.equal(publication.timeZone, "UTC");
  assert.equal(publication.releaseDate, "2026-09-12");
  const configured = normalizePublication({ ...input, timeZone: "Asia/Tokyo" });
  assert.equal(configured.timeZone, "Asia/Tokyo");
  assert.equal(configured.releaseDate, "2026-09-13");
  assert.equal(releaseDay("2026-09-12T22:30:00Z", "Asia/Tokyo"), "2026-09-13");
});

test("полная публикация повторяется без дублей и проверяет живой changelog", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  const first = await publishRelease(client, config, input, deployment);
  assert.equal(client.pages.deliveries.length, 2);
  assert.equal(client.pages.backlog.length, 2);
  const second = await publishRelease(client, config, input, deployment);
  assert.equal(second.receipt.releasePageId, first.receipt.releasePageId);
  assert.equal(client.pages.deliveries.length, 2);
  await checkPublication(client, config, input, deployment, first.receipt);
  const blocks = client.blocks[first.receipt.releasePageId];
  blocks[2].bulleted_list_item.rich_text = text("Посторонний текст");
  await assert.rejects(checkPublication(client, config, input, deployment, first.receipt), { code: "PUBLICATION_CHANGELOG_MISMATCH" });
});

test("обрыв после первой поставки возобновляется по полному сохранённому намерению", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  client.failAtDelivery = 2;
  await assert.rejects(publishRelease(client, config, input, deployment), { code: "NOTION_HTTP_503" });
  assert.equal(client.pages.deliveries.length, 1);
  assert.equal(client.pages.backlog[1].properties["Публикация SHA-256"], undefined);
  await assert.rejects(publishRelease(client, config, { ...input, changes: ["Другой changelog"] }, deployment), { code: "PUBLICATION_INTENT_CONFLICT" });
  client.failAtDelivery = 0;
  await publishRelease(client, config, input, deployment);
  assert.equal(client.pages.deliveries.length, 2);
});

test("обрыв после последней поставки и потеря локального receipt допускают повтор", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  client.failAtFinalize = true;
  await assert.rejects(publishRelease(client, config, input, deployment), { code: "NOTION_HTTP_503" });
  assert.equal(client.pages.deliveries.length, 2);
  client.failAtFinalize = false;
  await publishRelease(client, config, input, deployment);
  const retry = await publishRelease(client, config, input, deployment);
  assert.equal(retry.receipt.publicationSha256, publicationDigest(normalizePublication(input)));
  assert.equal(client.pages.backlog.length, 2);
});

test("разные выпуски одного дня получают отдельные страницы и цепочку поставок", async () => {
  const client = new NotionMemory(); const one = sample();
  await publishRelease(client, config, one.input, one.deployment);
  const two = sample("release-b");
  two.input.deliveries.forEach((d, i) => { d.initial = false; d.baseSha = d.headSha; d.headSha = String(i + 3).repeat(40); d.version = "1.2.1"; });
  two.deployment.deliveries.forEach((d, i) => { d.headSha = two.input.deliveries[i].headSha; d.version = "1.2.1"; });
  const second = await publishRelease(client, config, two.input, two.deployment);
  assert.equal(client.pages.backlog.length, 3);
  assert.equal(client.pages.deliveries.length, 4);
  assert.equal(client.pages.deliveries[2].properties["Предыдущая поставка"].relation[0].id, client.pages.deliveries[0].id);
  client.pages.deliveries[2].properties["Предыдущая поставка"].relation = [];
  await assert.rejects(checkPublication(client, config, two.input, two.deployment, second.receipt), { code: "DELIVERY_FROZEN" });
});

test("ошибка задачи во второй поставке останавливает публикацию до первой записи", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  input.deliveries[1].taskCodes = ["W-777"];
  await assert.rejects(publishRelease(client, config, input, deployment), { code: "DELIVERY_TASK_NOT_FOUND" });
  assert.equal(client.mutations.length, 0);
});

test("receipt чужого run и изменения frozen-состава отклоняются", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  const { receipt } = await publishRelease(client, config, input, deployment);
  await assert.rejects(checkPublication(client, config, input, deployment, { ...receipt, runId: "other" }), { code: "PUBLICATION_RECEIPT_MISMATCH" });
  client.pages.deliveries[1].properties["Конечный SHA"] = rich("f".repeat(40));
  await assert.rejects(checkPublication(client, config, input, deployment, receipt), { code: "DELIVERY_FROZEN" });
});


test("видимая дата релиза проверяется независимо от свойства", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  const { receipt } = await publishRelease(client, config, input, deployment);
  client.blocks[receipt.releasePageId][0].callout.rich_text = text("Дата релиза — 1 января 2020");
  await assert.rejects(checkPublication(client, config, input, deployment, receipt), { code: "PUBLICATION_DATE_MISMATCH" });
});


test("read-back учитывает минутную точность Date в Notion и сохраняет точный fingerprint", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  input.deliveries.forEach(d => { d.deployedAt = "2026-09-12T22:30:28Z"; });
  deployment.deliveries.forEach(d => { d.verifiedAt = "2026-09-12T22:30:28Z"; });
  const { receipt } = await publishRelease(client, config, input, deployment);
  client.pages.deliveries.forEach(p => { p.properties["Дата развёртывания"].date.start = "2026-09-12T22:30:00.000+00:00"; });
  await checkPublication(client, config, input, deployment, receipt);
  assert.equal(receipt.publicationSha256, publicationDigest(normalizePublication(input)));
  client.pages.deliveries[0].properties["Дата развёртывания"].date.start = "2026-09-12T22:31:00Z";
  await assert.rejects(checkPublication(client, config, input, deployment, receipt), { code: "DELIVERY_FROZEN" });
});


test("повторный deploy сохраняет дату первого выпуска и получает receipt своего run", async () => {
  const client = new NotionMemory(); const { input, deployment } = sample();
  const first = await publishRelease(client, config, input, deployment);
  const repeat = clone(deployment);
  repeat.runId = "20260914T223000Z-456";
  repeat.deployedAt = "2026-09-14T22:30:00Z";
  repeat.deliveries.forEach(d => { d.verifiedAt = repeat.deployedAt; });
  const second = await publishRelease(client, config, input, repeat);
  assert.equal(second.receipt.releasePageId, first.receipt.releasePageId);
  assert.equal(second.receipt.publicationSha256, first.receipt.publicationSha256);
  assert.notEqual(second.receipt.deploymentSha256, first.receipt.deploymentSha256);
  assert.equal(client.pages.deliveries.length, 2);
  await assert.rejects(checkPublication(client, config, input, repeat, first.receipt), { code: "PUBLICATION_RECEIPT_MISMATCH" });
  const fresh = new NotionMemory();
  await assert.rejects(publishRelease(fresh, config, input, repeat), { code: "DEPLOYMENT_DATE_MISMATCH" });
  assert.equal(fresh.mutations.length, 0);
});


test("история проверяет все файлы до записи и возобновляет частичную публикацию", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-history-"));
  try {
    const client = new NotionMemory(); const { input, deployment } = sample();
    const index = join(root, "release-history.json");
    await writeFile(join(root, "publication.json"), JSON.stringify(input));
    await writeFile(join(root, "deployment.json"), JSON.stringify(deployment));
    const entries = [{ id: input.releaseSetId, publication: "publication.json", evidence: "deployment.json" }];
    await writeFile(index, JSON.stringify({ releaseSets: [...entries, { id: "missing", publication: "missing.json", evidence: "deployment.json" }] }));
    await assert.rejects(publishHistory(client, config, index), { code: "ENOENT" });
    assert.equal(client.mutations.length, 0);
    await writeFile(index, JSON.stringify({ releaseSets: entries }));
    client.failAtDelivery = 2;
    await assert.rejects(publishHistory(client, config, index), { code: "NOTION_HTTP_503" });
    client.failAtDelivery = 0;
    const receipts = await publishHistory(client, config, index);
    assert.equal(receipts.length, 1);
    assert.equal(client.pages.deliveries.length, 2);
    const saved = JSON.parse(await readFile(join(root, input.releaseSetId, "receipt.json"), "utf8"));
    assert.equal(saved.receipt.releasePageId, receipts[0].releasePageId);
    const count = client.mutations.length;
    await publishHistory(client, config, index, { checkOnly: true });
    assert.equal(client.mutations.length, count);
  } finally { await rm(root, { recursive: true, force: true }); }
});
