#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { loadProject, SetupError } from "./project-config.mjs";
import { NotionClient, findTask, notionToken } from "./notion-tasks.mjs";

export const BRANCH_ADJECTIVES = `
agile amber ancient arctic autumn bold brave brisk bright calm
careful clear clever coastal copper cosmic crisp dark deep eager
early emerald fair fast fierce fresh gentle golden grand green
hidden icy ivory keen light lively lucid lunar mellow misty
modern narrow native neat noble northern open pale patient plain
polished proud quiet rapid rare red remote rich round royal
rugged safe sharp silent silver simple small smooth solar steady
stony strong subtle swift tall teal tender tidy tiny tranquil
true urban vast vivid warm wild wise young blue bronze
cloudy cool dry dusky firm frosty glowing humble jolly kind
`.trim().split(/\s+/u);

export const BRANCH_NOUNS = `
anchor apple arrow badger beacon birch blade bloom bridge brook
canyon cedar cloud comet crane creek crown crystal dawn deer
delta dune eagle ember falcon fern field flame forest fox
frost garden gate grove harbor hawk hill horizon island jade
lake leaf lion maple meadow moon moss mountain oak ocean
orbit owl pine plume quartz raven reef ridge river robin
rock sail shore sky sparrow spring star stone storm summit
sun tiger trail valley wave willow wind wolf wood wren
acorn bay bear cliff coral cove drift elm finch glacier
heron iris juniper lantern marsh otter pearl rain salmon thunder
`.trim().split(/\s+/u);

function normalizedCode(code) {
  const value = String(code || "").toLowerCase();
  if (!/^[a-z][a-z0-9]*-[0-9]+$/u.test(value)) {
    throw new Error("Код ветки должен иметь формат CODE-N");
  }
  return value;
}

export function assertBranchCodeAvailable(code, branchNames = []) {
  const normalized = normalizedCode(code);
  const duplicate = branchNames.find((name) =>
    String(name).toLowerCase().split("/").some((part) =>
      part === normalized || part.startsWith(`${normalized}-`),
    ),
  );
  if (duplicate) {
    throw new Error(`Код ${code.toUpperCase()} уже используется веткой ${duplicate}`);
  }
  return true;
}

export function generateBranchName({ type, code, random = Math.random, branchNames = [] }) {
  const prefix = type === "story" ? "story" : type === "bug" ? "bugfix" : "";
  if (!prefix) throw new Error("Тип ветки должен быть story или bug");
  assertBranchCodeAvailable(code, branchNames);
  const sample = () => {
    const value = Number(random());
    return Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 0.9999999999999999)
      : 0;
  };
  const adjective = BRANCH_ADJECTIVES[Math.floor(sample() * BRANCH_ADJECTIVES.length)];
  const noun = BRANCH_NOUNS[Math.floor(sample() * BRANCH_NOUNS.length)];
  return `${prefix}/${normalizedCode(code)}-${adjective}-${noun}`;
}

export function assertBranchTaskType(branchType, taskType) {
  const expected = branchType === "story" ? ["Story", "История"] : branchType === "bug" ? ["Bug", "Баг"] : null;
  if (!expected) throw new Error("Тип ветки должен быть story или bug");
  if (!expected.includes(taskType)) {
    throw new SetupError("BRANCH_TASK_TYPE_MISMATCH",
      `Ветка ${branchType} требует тип ${expected.join(" / ")}, получен тип ${taskType || "не задан"}`,
    );
  }
  return true;
}

/** Читает аргументы CLI в документированном порядке: код задачи, затем тип ветки. */
export function parseBranchArguments(argv = []) {
  const [code, type] = argv;
  return { code, type };
}

function gitBranchNames() {
  return execFileSync(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    { encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { code, type } = parseBranchArguments(process.argv.slice(2));
  try {
    const config = loadProject();
    if (!new RegExp(`^${config.code}-[0-9]+$`, "i").test(code || ""))
      throw new SetupError("INVALID_TASK_CODE", `Нужен код ${config.code}-N.`);
    if (config.notion.databaseId && !/-0+$/.test(code)) {
      const token = await notionToken(resolve(dirname(config.configPath), ".."));
      if (!token) throw new SetupError("NOTION_TOKEN_REQUIRED", "Задай NOTION_TOKEN или выполни prepare-env.");
      await findTask(new NotionClient({ token }), config, code);
    }
    console.log(generateBranchName({ type, code, branchNames: gitBranchNames() }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
