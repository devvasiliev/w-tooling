import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateBusinessValueFreshness,
  expectedBusinessValueProperties,
  setupBusinessValueSchema,
  visibleBusinessValue,
} from "./business-value/notion-setup.mjs";

const model = JSON.parse(
  await readFile(new URL("../config/business-value-model.v1.json", import.meta.url), "utf8"),
);

const metadataProperty = (name, definition) => {
  const type = Object.keys(definition)[0];
  return { id: `id-${name}`, name, type, [type]: definition[type] };
};

const fakeClient = ({
  initial = {},
  duplicateBot = false,
  botName = "W Business Value",
} = {}) => {
  let properties = { ...initial };
  const requests = [];
  return {
    requests,
    async request(path, options = {}) {
      requests.push({ path, options });
      if (path === "/users/me") return { id: "bot-1", name: botName };
      if (path.startsWith("/users?")) {
        return {
          results: [
            { id: "bot-1", name: botName },
            ...(duplicateBot ? [{ id: "user-2", name: botName }] : []),
          ],
          has_more: false,
        };
      }
      if (path === "/data_sources/source-1" && options.method === "PATCH") {
        for (const [nameOrId, definition] of Object.entries(options.body.properties)) {
          if (definition.name && Object.keys(definition).length === 1) {
            const currentName = Object.keys(properties).find(
              (name) => properties[name].id === nameOrId || name === nameOrId,
            );
            const current = properties[currentName];
            delete properties[currentName];
            properties[definition.name] = { ...current, name: definition.name };
          } else {
            properties[nameOrId] = metadataProperty(nameOrId, definition);
          }
        }
        return { id: "source-1", object: "data_source", properties };
      }
      if (path === "/data_sources/source-1") {
        return { id: "source-1", object: "data_source", properties };
      }
      throw new Error(`Unexpected request ${path}`);
    },
  };
};

test("setup dry-run и approved идемпотентны", async () => {
  const client = fakeClient();
  const dryRun = await setupBusinessValueSchema(
    client,
    { databaseId: "source-1" },
    model,
    { dryRun: true },
  );
  assert.equal(dryRun.addedPropertyNames.length, 12);
  assert.equal(client.requests.some((item) => item.options.method === "PATCH"), false);

  const applied = await setupBusinessValueSchema(
    client,
    { databaseId: "source-1" },
    model,
    { approved: true },
  );
  assert.equal(applied.changed, true);
  const repeated = await setupBusinessValueSchema(
    client,
    { databaseId: "source-1" },
    model,
    { approved: true },
  );
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.addedPropertyNames, []);
});

test("legacy number Business Value мигрирует переименованием без потери типа", async () => {
  const legacy = metadataProperty("Business Value", { number: { format: "number" } });
  legacy.id = "legacy-bv-id";
  const client = fakeClient({ initial: { "Business Value": legacy } });
  const dryRun = await setupBusinessValueSchema(
    client,
    { databaseId: "source-1" },
    model,
    { dryRun: true },
  );
  assert.deepEqual(dryRun.renames, [
    {
      propertyId: "legacy-bv-id",
      from: "Business Value",
      to: "BV значение",
    },
  ]);
  assert.ok(dryRun.addedPropertyNames.includes("Business Value"));
  const applied = await setupBusinessValueSchema(
    client,
    { databaseId: "source-1" },
    model,
    { approved: true },
  );
  assert.equal(applied.changed, true);
  const metadata = await client.request("/data_sources/source-1");
  assert.equal(metadata.properties["BV значение"].type, "number");
  assert.equal(metadata.properties["Business Value"].type, "formula");
});

test("setup отклоняет несовместимый тип, формулу и неоднозначного bot", async () => {
  const expected = expectedBusinessValueProperties(model, "W Business Value");
  for (const initial of [
    { "BV значение": { type: "rich_text", rich_text: {} } },
    {
      "BV актуален": {
        type: "formula",
        formula: { expression: "true" },
      },
    },
  ]) {
    await assert.rejects(
      setupBusinessValueSchema(
        fakeClient({ initial }),
        { databaseId: "source-1" },
        model,
        { dryRun: true },
      ),
      (error) => error.code === "NOTION_BV_SCHEMA_MISMATCH",
    );
  }
  assert.ok(expected["Business Value"].formula.expression.includes("BV актуален"));
  await assert.rejects(
    setupBusinessValueSchema(
      fakeClient({ duplicateBot: true }),
      { databaseId: "source-1" },
      model,
      { dryRun: true },
    ),
    (error) => error.code === "NOTION_BOT_NAME_AMBIGUOUS",
  );
  await assert.rejects(
    setupBusinessValueSchema(
      fakeClient({ botName: "W Integration" }),
      { databaseId: "source-1" },
      model,
      { dryRun: true, expectedBotName: "W Business Value" },
    ),
    (error) => error.code === "NOTION_BV_INTEGRATION_REQUIRED",
  );
});

test("freshness скрывает stale edit, model/baseline change и ambiguity", () => {
  const base = {
    rawValue: 192,
    rawResult: "Оценено",
    modelVersion: model.modelVersion,
    baselineVersion: model.baselineVersion,
    calculatedAt: "2026-09-01T12:00:00.000Z",
    lastEditedTime: "2026-09-01T12:00:05.000Z",
    lastEditedBy: { id: "bot-1" },
  };
  const bot = { id: "bot-1", name: "W Business Value" };
  assert.equal(evaluateBusinessValueFreshness(base, model, bot), true);
  assert.equal(visibleBusinessValue(base, model, bot), 192);
  for (const changed of [
    { lastEditedTime: "2026-09-01T12:00:20.000Z" },
    { lastEditedBy: { id: "user-1" } },
    { modelVersion: "BV-MODEL-2" },
    { baselineVersion: "BV-BASE-2" },
    { calculatedAt: "invalid" },
    { lastEditedBy: null },
  ]) {
    const state = { ...base, ...changed };
    assert.equal(evaluateBusinessValueFreshness(state, model, bot), false);
    assert.equal(visibleBusinessValue(state, model, bot), null);
  }
  const afterUserThenGeneralBot = {
    ...base,
    lastEditedTime: "2026-09-01T12:00:06.000Z",
    lastEditedBy: { id: "general-task-bot" },
  };
  assert.equal(
    evaluateBusinessValueFreshness(afterUserThenGeneralBot, model, bot),
    false,
  );
});
