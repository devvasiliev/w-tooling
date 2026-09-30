import { resolveDataSource } from "../notion-workflow-lib.mjs";
import { fail } from "./errors.mjs";

const RESULT_OPTIONS = [
  ["Не оценено", "gray"],
  ["Нужны данные", "yellow"],
  ["Оценено", "green"],
  ["Частично оценено", "blue"],
  ["Ошибка", "red"],
];

const quoteFormula = (value) => JSON.stringify(String(value));

export function businessValueFormulas({ modelVersion, baselineVersion, botName }) {
  const current = `and(or(prop("BV результат") == "Оценено", prop("BV результат") == "Частично оценено"), prop("BV версия модели") == ${quoteFormula(modelVersion)}, prop("BV baseline") == ${quoteFormula(baselineVersion)}, name(prop("BV изменил")) == ${quoteFormula(botName)}, not empty(prop("BV рассчитан")), abs(dateBetween(prop("BV изменено"), prop("BV рассчитан"), "seconds")) <= 15)`;
  const status = `ifs(empty(prop("BV результат")), "Не оценено", prop("BV актуален"), prop("BV результат"), or(prop("BV результат") == "Оценено", prop("BV результат") == "Частично оценено"), "Устарело", prop("BV результат"))`;
  const visibleValue = `if(prop("BV актуален"), prop("BV значение"), toNumber(""))`;
  return { current, status, visibleValue };
}

export function expectedBusinessValueProperties(modelConfig, botName) {
  const formulas = businessValueFormulas({
    modelVersion: modelConfig.modelVersion,
    baselineVersion: modelConfig.baselineVersion,
    botName,
  });
  return {
    "BV значение": { number: { format: "number" } },
    "BV результат": {
      select: {
        options: RESULT_OPTIONS.map(([name, color]) => ({ name, color })),
      },
    },
    "BV уверенность": { number: { format: "percent" } },
    "BV baseline": { rich_text: {} },
    "BV версия модели": { rich_text: {} },
    "BV рассчитан": { date: {} },
    "BV fingerprint": { rich_text: {} },
    "BV изменено": { last_edited_time: {} },
    "BV изменил": { last_edited_by: {} },
    "BV актуален": { formula: { expression: formulas.current } },
    "BV статус": { formula: { expression: formulas.status } },
    "Business Value": { formula: { expression: formulas.visibleValue } },
  };
}

const expectedType = (definition) => Object.keys(definition)[0];

const assertCompatibleProperty = (name, existing, expected) => {
  const type = expectedType(expected);
  if (existing.type !== type) {
    fail(
      "NOTION_BV_SCHEMA_MISMATCH",
      `Свойство «${name}» имеет тип ${existing.type}, ожидается ${type}`,
      { property: name, expectedType: type, actualType: existing.type },
    );
  }
  if (
    type === "formula" &&
    existing.formula?.expression !== expected.formula.expression
  ) {
    fail(
      "NOTION_BV_SCHEMA_MISMATCH",
      `Формула свойства «${name}» не совпадает с текущей версией`,
      { property: name },
    );
  }
  if (type === "number" && existing.number?.format !== expected.number.format) {
    fail(
      "NOTION_BV_SCHEMA_MISMATCH",
      `Формат свойства «${name}» не совпадает`,
      { property: name },
    );
  }
  if (type === "select") {
    const existingNames = new Set((existing.select?.options || []).map((item) => item.name));
    const missing = expected.select.options
      .map((item) => item.name)
      .filter((option) => !existingNames.has(option));
    if (missing.length) {
      fail(
        "NOTION_BV_SCHEMA_MISMATCH",
        `В «${name}» отсутствуют варианты: ${missing.join(", ")}`,
        { property: name, missingOptions: missing },
      );
    }
  }
};

const listUsers = async (client) => {
  const users = [];
  let cursor;
  do {
    const suffix = new URLSearchParams({ page_size: "100" });
    if (cursor) suffix.set("start_cursor", cursor);
    const response = await client.request(`/users?${suffix.toString()}`);
    users.push(...(response.results || []));
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return users;
};

export async function resolveUniqueBotIdentity(client, { expectedName } = {}) {
  const [bot, users] = await Promise.all([
    client.request("/users/me"),
    listUsers(client),
  ]);
  if (!bot?.id || !bot?.name) {
    fail("NOTION_BOT_IDENTITY_MISSING", "Notion не вернул identity integration bot");
  }
  if (expectedName && bot.name !== expectedName) {
    fail(
      "NOTION_BV_INTEGRATION_REQUIRED",
      `Ожидалась отдельная integration «${expectedName}», получена «${bot.name}»`,
      { expectedName, actualName: bot.name },
    );
  }
  const sameName = users.filter((user) => user?.name === bot.name);
  if (sameName.length !== 1 || sameName[0].id !== bot.id) {
    fail(
      "NOTION_BOT_NAME_AMBIGUOUS",
      `Имя integration bot «${bot.name}» не уникально`,
      { matches: sameName.length },
    );
  }
  return { id: bot.id, name: bot.name };
}

export function buildSetupDiff(existingProperties, expectedProperties) {
  const additions = {};
  for (const [name, expected] of Object.entries(expectedProperties)) {
    const existing = existingProperties?.[name];
    if (!existing) additions[name] = expected;
    else assertCompatibleProperty(name, existing, expected);
  }
  return {
    additions,
    addedPropertyNames: Object.keys(additions),
    unchangedPropertyNames: Object.keys(expectedProperties).filter(
      (name) => !Object.hasOwn(additions, name),
    ),
  };
}

export function buildSetupPlan(existingProperties, expectedProperties) {
  const simulated = { ...(existingProperties || {}) };
  const renames = [];
  const visible = simulated["Business Value"];
  const raw = simulated["BV значение"];
  if (visible?.type === "number" && !raw) {
    renames.push({
      propertyId: visible.id || "Business Value",
      from: "Business Value",
      to: "BV значение",
    });
    delete simulated["Business Value"];
    simulated["BV значение"] = {
      ...visible,
      name: "BV значение",
    };
  }
  const diff = buildSetupDiff(simulated, expectedProperties);
  return { ...diff, renames };
}

export async function setupBusinessValueSchema(
  client,
  config,
  modelConfig,
  { dryRun = false, approved = false, expectedBotName } = {},
) {
  if (dryRun === approved) {
    fail("SETUP_MODE_REQUIRED", "Укажи ровно один режим: --dry-run или --approved");
  }
  const bot = await resolveUniqueBotIdentity(client, {
    expectedName: expectedBotName,
  });
  const resolved = await resolveDataSource(client, config.databaseId);
  const expected = expectedBusinessValueProperties(modelConfig, bot.name);
  let diff = buildSetupPlan(resolved.metadata.properties || {}, expected);
  const plannedRenames = [...diff.renames];
  const plannedAdditions = [...diff.addedPropertyNames];
  if (!dryRun && diff.renames.length > 0) {
    await client.request(`/data_sources/${resolved.id}`, {
      method: "PATCH",
      body: {
        properties: Object.fromEntries(
          diff.renames.map((rename) => [rename.propertyId, { name: rename.to }]),
        ),
      },
    });
    const afterRename = await client.request(`/data_sources/${resolved.id}`);
    diff = buildSetupPlan(afterRename.properties || {}, expected);
  }
  if (!dryRun && diff.addedPropertyNames.length > 0) {
    const ordinaryAdditions = Object.fromEntries(
      Object.entries(diff.additions).filter(([, definition]) => !definition.formula),
    );
    if (Object.keys(ordinaryAdditions).length > 0) {
      await client.request(`/data_sources/${resolved.id}`, {
        method: "PATCH",
        body: { properties: ordinaryAdditions },
      });
    }
    for (const propertyName of ["BV актуален", "BV статус", "Business Value"]) {
      const definition = diff.additions[propertyName];
      if (!definition) continue;
      await client.request(`/data_sources/${resolved.id}`, {
        method: "PATCH",
        body: { properties: { [propertyName]: definition } },
      });
    }
    const readback = await client.request(`/data_sources/${resolved.id}`);
    buildSetupDiff(readback.properties || {}, expected);
  }
  return {
    dryRun,
    changed:
      !dryRun &&
      (plannedRenames.length > 0 || plannedAdditions.length > 0),
    dataSourceId: resolved.id,
    bot,
    ...diff,
    renames: plannedRenames,
    addedPropertyNames: plannedAdditions,
  };
}

const validDate = (value) => {
  const milliseconds = Date.parse(value || "");
  return Number.isFinite(milliseconds) ? milliseconds : null;
};

export function evaluateBusinessValueFreshness(state, modelConfig, botIdentity) {
  try {
    if (!["Оценено", "Частично оценено"].includes(state.rawResult)) return false;
    if (
      state.modelVersion !== modelConfig.modelVersion ||
      state.baselineVersion !== modelConfig.baselineVersion
    ) return false;
    if (!botIdentity?.id || !state.lastEditedBy?.id) return false;
    if (state.lastEditedBy.id !== botIdentity.id) return false;
    const edited = validDate(state.lastEditedTime);
    const calculated = validDate(state.calculatedAt);
    if (edited === null || calculated === null) return false;
    return Math.abs(edited - calculated) <= 15_000;
  } catch {
    return false;
  }
}

export const visibleBusinessValue = (state, modelConfig, botIdentity) =>
  evaluateBusinessValueFreshness(state, modelConfig, botIdentity)
    ? state.rawValue
    : null;
