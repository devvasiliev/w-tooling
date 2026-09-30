import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFrozenDeliveryUnchanged,
  deliveryDatabaseBody,
  deliveryTitle,
  deliveryViewBody,
  legacyDeliveryMigrationProperties,
  normalizeReleaseManifest,
  repositoryName,
  releaseBranchForVersion,
  releaseDateFromDeliveries,
  storedRepositoryMigrationProperties,
  validatePreviousDelivery,
} from "./task-release-manifest.mjs";

const manifest = {
  deliveries: [
    {
      service: "Модуль платежей",
      repository: "orders-api",
      version: "1.4.0",
      baseSha: "1111111",
      headSha: "2222222",
      deployedAt: "2026-08-14T12:10:00+03:00",
      state: "Развёрнута",
      taskCodes: ["w-88", "W-88"],
    },
    {
      service: "Web-клиент",
      repository: "orders-web",
      version: "2.0.0-beta",
      baseSha: "aaaaaaa",
      headSha: "bbbbbbb",
      deployedAt: "2026-08-14T12:40:00+03:00",
      state: "Развёрнута",
      taskCodes: [],
    },
  ],
};

test("манифест включает только перечисленные изменённые репозитории", () => {
  const normalized = normalizeReleaseManifest(manifest);
  assert.equal(normalized.deliveries.length, 2);
  assert.deepEqual(normalized.deliveries[0].taskCodes, ["W-88"]);
  assert.equal(normalized.deliveries[0].releaseBranch, "release/1.4.0");
  assert.equal(releaseDateFromDeliveries(normalized.deliveries), "2026-08-14");
});

test("версия, ветка и заголовок поставки имеют канонический формат", () => {
  assert.equal(releaseBranchForVersion("0.5.0a"), "release/0.5.0a");
  assert.equal(releaseBranchForVersion("0.5.0-beta"), "release/0.5.0-beta");
  assert.equal(deliveryTitle("git@example.org/product/identity-service.git"), "identity-service");
  assert.equal(repositoryName("simulation/orders-api"), "orders-api");
  assert.throws(() => releaseBranchForVersion("api-v0.5.0"), (error) => error.code === "DELIVERY_VERSION_INVALID");
  assert.throws(() => releaseBranchForVersion("v0.5.0"), (error) => error.code === "DELIVERY_VERSION_INVALID");
});

test("релиз нельзя заморозить с формирующейся поставкой", () => {
  const normalized = normalizeReleaseManifest({
    deliveries: [{ ...manifest.deliveries[0], state: "Формируется", deployedAt: "" }],
  });
  assert.throws(
    () => releaseDateFromDeliveries(normalized.deliveries),
    (error) => error.code === "RELEASE_NOT_DEPLOYED",
  );
});

test("схема создаёт одну базу и связанный вид поставок", () => {
  const deliveries = deliveryDatabaseBody("epic", "backlog");
  assert.equal(deliveries.icon.type, "emoji");
  assert.equal(deliveries.initial_data_source.properties.Релиз.relation.data_source_id, "backlog");
  assert.equal(deliveries.initial_data_source.properties.Сервис.rich_text instanceof Object, true);
  assert.equal("Репозиторий" in deliveries.initial_data_source.properties, false);
  assert.equal("Дистрибутив" in deliveries.initial_data_source.properties, false);
  const metadata = {
    properties: {
      Поставка: { id: "title" },
      Сервис: { id: "service" },
      "Версия / тег": { id: "version" },
      Состояние: { id: "state" },
      "Дата развёртывания": { id: "date" },
    },
  };
  const view = deliveryViewBody("deliveries", metadata, "release");
  assert.deepEqual(view.filter, { property: "Релиз", relation: { contains: "release" } });
  assert.deepEqual(view.configuration.properties.map((item) => item.property_id), ["title", "service", "version", "state", "date"]);
});

test("старые relation и поле репозитория сворачиваются в заголовок поставки", () => {
  const page = {
    properties: {
      Поставка: { title: [{ plain_text: "Демо · Backend API · api-v0.5.0-demo" }] },
      Дистрибутив: { relation: [{ id: "legacy-service" }] },
      "Версия / тег": { rich_text: [{ plain_text: "0.4.0" }] },
    },
  };
  const properties = legacyDeliveryMigrationProperties(
    page,
    new Map([["legacy-service", { service: "Модуль платежей", repository: "orders-api" }]]),
  );
  assert.equal(properties.Поставка.title[0].text.content, "orders-api");
  assert.equal(properties.Сервис.rich_text[0].text.content, "Модуль платежей");
  assert.equal("Репозиторий" in properties, false);
  const stored = storedRepositoryMigrationProperties({
    properties: {
      Поставка: { title: [{ plain_text: "Backend API (0.4.0)" }] },
      Репозиторий: { rich_text: [{ plain_text: "simulation/orders-api" }] },
    },
  });
  assert.equal(stored.Поставка.title[0].text.content, "orders-api");
});

test("развёрнутая поставка неизменяема", () => {
  const existing = {
    properties: {
      Поставка: { title: [{ plain_text: "orders-api" }] },
      Сервис: { rich_text: [{ plain_text: "Модуль платежей" }] },
      "Версия / тег": { rich_text: [{ plain_text: "1.4.0" }] },
      "Начальный SHA": { rich_text: [{ plain_text: "111" }] },
      "Конечный SHA": { rich_text: [{ plain_text: "222" }] },
      "Дата развёртывания": { date: { start: "2026-08-14" } },
      Состояние: { select: { name: "Развёрнута" } },
      "Входящие задачи": { relation: [{ id: "task" }] },
      "Предыдущая поставка": { relation: [] },
    },
  };
  const desired = {
    service: "Модуль платежей",
    repository: "orders-api",
    version: "1.4.0",
    baseSha: "111",
    headSha: "222",
    previousDeliveryId: "",
    deployedAt: "2026-08-14",
    taskIds: ["task"],
  };
  assert.equal(assertFrozenDeliveryUnchanged(existing, desired), true);
  assert.equal(
    assertFrozenDeliveryUnchanged(
      {
        ...existing,
        properties: {
          ...existing.properties,
          "Дата развёртывания": { date: { start: "2026-08-14T12:10:00.000+03:00" } },
        },
      },
      { ...desired, deployedAt: "2026-08-14T12:10:00+03:00" },
    ),
    true,
  );
  assert.throws(
    () => assertFrozenDeliveryUnchanged(existing, { ...desired, headSha: "333" }),
    (error) => error.code === "DELIVERY_FROZEN",
  );
  assert.equal(
    assertFrozenDeliveryUnchanged(
      existing,
      { ...desired, version: "1.4.1" },
      undefined,
      { approvedCorrection: true, correctionReason: "Исправление тестовых данных" },
    ),
    false,
  );
});

test("предыдущая поставка замыкает SHA-цепочку того же репозитория", () => {
  const previous = {
    id: "11111111-1111-1111-1111-111111111111",
    properties: {
      Поставка: { title: [{ plain_text: "orders-api" }] },
      "Конечный SHA": { rich_text: [{ plain_text: "abc123" }] },
      Состояние: { select: { name: "Развёрнута" } },
    },
  };
  const desired = {
    repository: "orders-api",
    baseSha: "abc123",
    previousDeliveryId: "11111111111111111111111111111111",
  };
  assert.equal(validatePreviousDelivery([previous], desired), previous);
  assert.throws(
    () => validatePreviousDelivery([previous], { ...desired, repository: "orders-web" }),
    (error) => error.code === "DELIVERY_PREVIOUS_REPOSITORY_MISMATCH",
  );
  assert.throws(
    () => validatePreviousDelivery([previous], { ...desired, baseSha: "def456" }),
    (error) => error.code === "DELIVERY_BASE_SHA_MISMATCH",
  );
  assert.throws(
    () => validatePreviousDelivery([], desired),
    (error) => error.code === "DELIVERY_PREVIOUS_NOT_FOUND",
  );
});
