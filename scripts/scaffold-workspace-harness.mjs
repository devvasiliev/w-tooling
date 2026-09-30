#!/usr/bin/env node

import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { syncWorkspace } from "./sync-workspace.mjs";
import { loadProject, SetupError } from "./project-config.mjs";
import { workspaceTargets } from "./workspace-layout.mjs";

const currentFile = fileURLToPath(import.meta.url);
const defaultToolingRoot = resolve(dirname(currentFile), "..");
const defaultTemplateRoot = join(defaultToolingRoot, "templates", "workspace-harness");
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TEMPLATE_LAYOUT = Object.freeze([
  Object.freeze({ source: "SKILL.md.tpl", destination: "SKILL.md" }),
  Object.freeze({ source: join("agents", "openai.yaml.tpl"), destination: join("agents", "openai.yaml") }),
  Object.freeze({ source: join("evals", "matrix.json.tpl"), destination: join("evals", "matrix.json") }),
  Object.freeze({ source: join("tests", "contract.json.tpl"), destination: join("tests", "contract.json") }),
]);
const USAGE = `Создание полного workspace skill+agent bundle

  npm run create-workspace-harness -- \\
    --name owner-auditor \\
    --display-name "Owner Auditor" \\
    --description "Проверяет владельца поведения и границы изменений" \\
    [--dry-run]
`;

/** Ошибка scaffold со стабильной причиной, этапом и следующим действием. */
export class WorkspaceHarnessScaffoldError extends Error {
  constructor({ code, stage, path = "", message, expected = "", actual = "", next = "", details = {} }) {
    super(message);
    this.name = "WorkspaceHarnessScaffoldError";
    this.code = code;
    this.stage = stage;
    this.path = path;
    this.expected = expected;
    this.actual = actual;
    this.next = next;
    this.details = Object.freeze({ ...details });
  }
}

function fail(input) {
  throw new WorkspaceHarnessScaffoldError(input);
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function oneLine(value, field, { min = 1, max = 240 } = {}) {
  const normalized = String(value ?? "").trim();
  if (
    normalized.length < min
    || normalized.length > max
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.includes("'''")
  ) {
    fail({
      code: "INVALID_INPUT",
      stage: "input_validation",
      path: field,
      message: `Некорректное значение ${field}.`,
      expected: `одна строка длиной ${min}–${max} символов без управляющих символов и тройной кавычки`,
      actual: normalized || "пусто",
      next: `Исправь --${field} и повтори команду.`,
      details: { field },
    });
  }
  return normalized;
}

function normalizedInput({ name, displayName, description }) {
  const normalizedName = oneLine(name, "name", { max: 64 });
  if (!NAME_PATTERN.test(normalizedName)) {
    fail({
      code: "INVALID_NAME",
      stage: "input_validation",
      path: "name",
      message: `Некорректное имя workspace bundle: ${normalizedName}.`,
      expected: "kebab-case: owner-auditor",
      actual: normalizedName,
      next: "Используй строчные латинские буквы, цифры и одиночные дефисы.",
    });
  }
  const normalizedDescription = oneLine(description, "description", { min: 25, max: 240 });
  if (/[<>]/u.test(normalizedDescription)) {
    fail({
      code: "INVALID_DESCRIPTION",
      stage: "input_validation",
      path: "description",
      message: "Описание skill содержит угловую скобку.",
      expected: "обычный текст без < и >",
      actual: normalizedDescription,
      next: "Замени placeholder обычным текстом и повтори команду.",
    });
  }
  return {
    name: normalizedName,
    displayName: oneLine(displayName, "display-name", { max: 64 }),
    description: normalizedDescription,
  };
}

function shortDescription(description) {
  if (description.length <= 64) return description;
  const prefix = description.slice(0, 61);
  const boundary = prefix.lastIndexOf(" ");
  const compact = boundary >= 25 ? prefix.slice(0, boundary) : prefix;
  return `${compact}...`;
}

function templateValues({ name, displayName, description }) {
  const confirmed = `PROFILE_BINDING: ${name}`;
  const fallback = `PROFILE_BINDING: unavailable (${name})`;
  const encoded = (value) => JSON.stringify(value);
  return Object.freeze({
    NAME: name,
    NAME_JSON: encoded(name),
    NAME_TOML: encoded(name),
    DISPLAY_NAME: displayName,
    DISPLAY_NAME_JSON: encoded(displayName),
    DISPLAY_NAME_YAML: encoded(displayName),
    DESCRIPTION: description,
    DESCRIPTION_JSON: encoded(description),
    DESCRIPTION_TOML: encoded(description),
    DESCRIPTION_YAML: encoded(description),
    SHORT_DESCRIPTION_YAML: encoded(shortDescription(description)),
    DEFAULT_PROMPT_YAML: encoded(`Use $${name} to review the provided task within its declared scope.`),
    PROFILE_CONFIRMED_JSON: encoded(confirmed),
    PROFILE_FALLBACK_JSON: encoded(fallback),
  });
}

function renderTemplate(content, values, source) {
  const rendered = content.replace(/__([A-Z_]+)__/gu, (token, key) => {
    if (!(key in values)) {
      fail({
        code: "UNKNOWN_TEMPLATE_TOKEN",
        stage: "template_render",
        path: source,
        message: `Template содержит неизвестный token: ${token}.`,
        expected: "зарегистрированный token scaffold",
        actual: token,
        next: "Исправь канонический template и повтори команду.",
      });
    }
    return values[key];
  });
  const unresolved = rendered.match(/__[A-Z_]+__/u)?.[0];
  if (unresolved) {
    fail({
      code: "UNRESOLVED_TEMPLATE_TOKEN",
      stage: "template_render",
      path: source,
      message: `После render остался token: ${unresolved}.`,
      expected: "полностью отрендеренный файл",
      actual: unresolved,
      next: "Добавь token в renderer или исправь template.",
    });
  }
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

/** Запрещает запись через symbolic link или каталог вне canonical tooling root. */
async function requireSafeDirectory(toolingRoot, target, label) {
  const [rootMetadata, targetMetadata] = await Promise.all([
    optionalLstat(toolingRoot),
    optionalLstat(target),
  ]);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail({
      code: "UNSAFE_DIRECTORY",
      stage: "path_validation",
      path: toolingRoot,
      message: "Tooling root отсутствует, не является каталогом или подменён ссылкой.",
      expected: "обычный каталог w-tooling",
      actual: rootMetadata ? "неподдерживаемый тип" : "отсутствует",
      next: "Запусти команду из штатного checkout w-tooling.",
    });
  }
  if (!targetMetadata?.isDirectory() || targetMetadata.isSymbolicLink()) {
    fail({
      code: "UNSAFE_DIRECTORY",
      stage: "path_validation",
      path: target,
      message: `${label} отсутствует, не является каталогом или подменён ссылкой.`,
      expected: "обычный каталог внутри w-tooling",
      actual: targetMetadata ? "неподдерживаемый тип" : "отсутствует",
      next: "Восстанови каноническую структуру templates и повтори команду.",
    });
  }
  const [realRoot, realTarget] = await Promise.all([realpath(toolingRoot), realpath(target)]);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    fail({
      code: "PATH_OUTSIDE_TOOLING",
      stage: "path_validation",
      path: target,
      message: `${label} выходит за пределы w-tooling.`,
      expected: realRoot,
      actual: realTarget,
      next: "Убери перенаправление каталога и повтори команду.",
    });
  }
}

function bundlePaths(toolingRoot, name) {
  const skillRoot = join(toolingRoot, "templates", "workspace-skills", name);
  const agentPath = join(toolingRoot, "templates", "workspace-agents", `${name}.toml`);
  const projectSkillRoot = join(toolingRoot, ".codex", "skills", name);
  return {
    skillRoot,
    agentPath,
    projectSkillRoot,
    required: [
      join(skillRoot, "SKILL.md"),
      join(skillRoot, "agents", "openai.yaml"),
      join(skillRoot, "evals", "matrix.json"),
      join(skillRoot, "tests", "contract.json"),
      agentPath,
    ],
  };
}

async function renderedPlan({ toolingRoot, templateRoot, input }) {
  const values = templateValues(input);
  const paths = bundlePaths(toolingRoot, input.name);
  const plan = await Promise.all(
    TEMPLATE_LAYOUT.map(async ({ source, destination }) => {
      const sourcePath = join(templateRoot, source);
      const metadata = await optionalLstat(sourcePath);
      if (!metadata?.isFile() || metadata.isSymbolicLink()) {
        fail({
          code: "INVALID_TEMPLATE",
          stage: "template_load",
          path: sourcePath,
          message: `Template отсутствует, не является файлом или подменён ссылкой: ${source}.`,
          expected: "обычный template-файл",
          actual: metadata ? "неподдерживаемый тип" : "отсутствует",
          next: "Восстанови templates/workspace-harness и повтори команду.",
        });
      }
      return {
        source: sourcePath,
        destination: join(paths.skillRoot, destination),
        content: renderTemplate(await readFile(sourcePath, "utf8"), values, sourcePath),
      };
    }),
  );
  const agentTemplate = join(templateRoot, "agent.toml.tpl");
  const agentMetadata = await optionalLstat(agentTemplate);
  if (!agentMetadata?.isFile() || agentMetadata.isSymbolicLink()) {
    fail({
      code: "INVALID_TEMPLATE",
      stage: "template_load",
      path: agentTemplate,
      message: "Agent template отсутствует, не является файлом или подменён ссылкой.",
      expected: "обычный agent.toml.tpl",
      actual: agentMetadata ? "неподдерживаемый тип" : "отсутствует",
      next: "Восстанови templates/workspace-harness/agent.toml.tpl.",
    });
  }
  plan.push({
    source: agentTemplate,
    destination: paths.agentPath,
    content: renderTemplate(await readFile(agentTemplate, "utf8"), values, agentTemplate),
  });
  return { paths, plan };
}

async function assertDestinationsAbsent(paths) {
  const collisions = [];
  if (await optionalLstat(paths.skillRoot)) collisions.push(paths.skillRoot);
  if (await optionalLstat(paths.agentPath)) collisions.push(paths.agentPath);
  if (await optionalLstat(paths.projectSkillRoot)) collisions.push(paths.projectSkillRoot);
  if (collisions.length) {
    fail({
      code: "ARTIFACT_EXISTS",
      stage: "destination_preflight",
      path: collisions[0],
      message: `Workspace bundle уже существует: ${collisions[0]}.`,
      expected: "свободное имя среди workspace/project skills и workspace agents",
      actual: collisions.join(", "),
      next: "Выбери другое имя или изменяй существующий bundle отдельной задачей.",
      details: { collisions },
    });
  }
}

async function exclusiveWrite(path, content) {
  const handle = await open(path, "wx", 0o644);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Создаёт только отсутствующие файлы и при ошибке удаляет лишь созданные пути.
 * Чужое содержимое, появившееся параллельно, рекурсивно не очищается.
 */
async function writePlan(paths, plan) {
  const agent = plan.find(({ destination }) => destination === paths.agentPath);
  const skillFiles = plan.filter(({ destination }) => destination !== paths.agentPath);
  let agentCreated = false;
  const createdFiles = [];
  const createdDirectories = [];
  try {
    await exclusiveWrite(agent.destination, agent.content);
    agentCreated = true;
    await mkdir(paths.skillRoot);
    createdDirectories.push(paths.skillRoot);
    for (const item of skillFiles) {
      const parent = dirname(item.destination);
      if (parent !== paths.skillRoot && !createdDirectories.includes(parent)) {
        await mkdir(parent);
        createdDirectories.push(parent);
      }
      await exclusiveWrite(item.destination, item.content);
      createdFiles.push(item.destination);
    }
  } catch (error) {
    for (const path of createdFiles.reverse()) await unlink(path).catch(() => {});
    for (const path of createdDirectories.reverse()) await rmdir(path).catch(() => {});
    if (agentCreated) await unlink(paths.agentPath).catch(() => {});
    if (error instanceof WorkspaceHarnessScaffoldError) throw error;
    fail({
      code: "WRITE_FAILED",
      stage: "bundle_write",
      path: error?.path || paths.skillRoot,
      message: "Не удалось атомарно создать workspace bundle.",
      expected: "пять новых canonical files",
      actual: error?.code || error?.message || "неизвестная ошибка",
      next: "Исправь права или конфликт пути и повтори команду.",
    });
  }
}

function parseJson(content, path) {
  try {
    return JSON.parse(content);
  } catch (error) {
    fail({
      code: "GENERATED_CONTRACT_INVALID",
      stage: "bundle_verify",
      path,
      message: `Generated JSON не разбирается: ${path}.`,
      expected: "валидный JSON",
      actual: error.message,
      next: "Исправь template и создай bundle заново.",
    });
  }
}

function assertGenerated(condition, { path, expected, actual }) {
  if (condition) return;
  fail({
    code: "GENERATED_CONTRACT_INVALID",
    stage: "bundle_verify",
    path,
    message: `Generated bundle нарушает обязательный контракт: ${path}.`,
    expected,
    actual,
    next: "Исправь scaffold template и повтори проверку.",
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Проверяет полный bundle без запуска агента и без изменения файлов. */
export async function verifyWorkspaceHarness({ toolingRoot = defaultToolingRoot, name }) {
  const normalizedName = normalizedInput({
    name,
    displayName: "Verification profile",
    description: "Проверяет существующий workspace harness contract",
  }).name;
  const paths = bundlePaths(resolve(toolingRoot), normalizedName);
  const contents = new Map();
  for (const path of paths.required) {
    const metadata = await optionalLstat(path);
    assertGenerated(metadata?.isFile() && !metadata.isSymbolicLink(), {
      path,
      expected: "обычный файл",
      actual: metadata ? "неподдерживаемый тип" : "отсутствует",
    });
    contents.set(path, await readFile(path, "utf8"));
  }

  const skillPath = join(paths.skillRoot, "SKILL.md");
  const openaiPath = join(paths.skillRoot, "agents", "openai.yaml");
  const evalPath = join(paths.skillRoot, "evals", "matrix.json");
  const testPath = join(paths.skillRoot, "tests", "contract.json");
  const skill = contents.get(skillPath);
  const openai = contents.get(openaiPath);
  const agent = contents.get(paths.agentPath);
  const evaluation = parseJson(contents.get(evalPath), evalPath);
  const contract = parseJson(contents.get(testPath), testPath);
  const confirmed = `PROFILE_BINDING: ${normalizedName}`;
  const fallback = `PROFILE_BINDING: unavailable (${normalizedName})`;
  const expectedFiles = paths.required.map((path) => relative(resolve(toolingRoot), path)).sort();
  const contractFiles = isRecord(contract) && Array.isArray(contract.required_files)
    ? [...contract.required_files].sort()
    : [];
  const evaluationCases = isRecord(evaluation) && Array.isArray(evaluation.cases)
    ? evaluation.cases
    : [];

  assertGenerated(skill.startsWith("---\n") && skill.includes(`name: ${normalizedName}\n`), {
    path: skillPath,
    expected: `frontmatter name: ${normalizedName}`,
    actual: "name отсутствует или расходится",
  });
  assertGenerated(skill.includes(confirmed) && skill.includes(fallback), {
    path: skillPath,
    expected: `${confirmed} и ${fallback}`,
    actual: "неполный PROFILE_BINDING contract",
  });
  assertGenerated(openai.includes(`$${normalizedName}`) && /allow_implicit_invocation:\s*false/u.test(openai), {
    path: openaiPath,
    expected: "default_prompt с $skill и allow_implicit_invocation: false",
    actual: "неполный openai.yaml contract",
  });
  assertGenerated(
    agent.includes(`name = ${JSON.stringify(normalizedName)}`)
      && agent.includes('sandbox_mode = "read-only"')
      && agent.includes(confirmed)
      && agent.includes(fallback),
    {
      path: paths.agentPath,
      expected: "совпадающее name, read-only sandbox и два PROFILE_BINDING значения",
      actual: "неполный custom agent contract",
    },
  );
  assertGenerated(
    isRecord(contract)
      && contract.schema_version === 1
      && contract.name === normalizedName
      && JSON.stringify(contractFiles) === JSON.stringify(expectedFiles)
      && contract.assertions?.sandbox_mode === "read-only"
      && contract.assertions?.writes_allowed === false
      && contract.assertions?.allow_implicit_invocation === false
      && contract.assertions?.profile_binding?.confirmed === confirmed
      && contract.assertions?.profile_binding?.fallback === fallback,
    {
      path: testPath,
      expected: "schema v1, пять exact paths, read-only и обязательный binding",
      actual: "test contract расходится",
    },
  );
  const cases = new Map(
    evaluationCases
      .filter((item) => isRecord(item) && typeof item.id === "string")
      .map((item) => [item.id, item]),
  );
  assertGenerated(
    isRecord(evaluation)
      && evaluation.schema_version === 1
      && evaluation.name === normalizedName
      && cases.get("named-binding")?.expected_first_line === confirmed
      && cases.get("fallback-binding")?.expected_first_line === fallback
      && cases.get("write-request")?.writes_allowed === false
      && cases.get("implicit-trigger")?.should_invoke === false,
    {
      path: evalPath,
      expected: "named, fallback, write-request и negative-trigger cases",
      actual: "eval matrix неполна",
    },
  );
  return { name: normalizedName, files: expectedFiles };
}

/** Создаёт canonical bundle и распространяет его по проверенному реестру checkout. */
export async function scaffoldWorkspaceHarness({
  name,
  displayName,
  description,
  dryRun = false,
  toolingRoot = defaultToolingRoot,
  workspaceRoot,
  templateRoot,
  sync = true,
  syncWorkspaceFn = syncWorkspace,
}) {
  const input = normalizedInput({ name, displayName, description });
  const resolvedToolingRoot = resolve(toolingRoot);
  const project = loadProject(process.env.W_PROJECT_CONFIG || join(resolvedToolingRoot, "config/project.json"));
  const owner = project.repositories.find(repository => repository.role === "tooling");
  if (!owner || resolve(project.workspace, owner.path) !== resolvedToolingRoot)
    throw new SetupError("TOOLING_ROOT_MISMATCH", "Tooling checkout отличается от владельца в конфигурации.");
  if (workspaceRoot !== undefined && resolve(workspaceRoot) !== project.workspace)
    throw new SetupError("WORKSPACE_ROOT_MISMATCH", "Workspace должен совпадать с конфигурацией проекта.");
  const resolvedWorkspaceRoot = project.workspace;
  const syncOptions = { workspaceRoot: resolvedWorkspaceRoot, toolingRoot: resolvedToolingRoot, layout: workspaceTargets(project) };
  const resolvedTemplateRoot = resolve(templateRoot || join(resolvedToolingRoot, "templates", "workspace-harness"));
  const skillParent = join(resolvedToolingRoot, "templates", "workspace-skills");
  const agentParent = join(resolvedToolingRoot, "templates", "workspace-agents");
  const projectSkillParent = join(resolvedToolingRoot, ".codex", "skills");
  await Promise.all([
    requireSafeDirectory(resolvedToolingRoot, resolvedTemplateRoot, "Workspace harness templates"),
    requireSafeDirectory(resolvedToolingRoot, skillParent, "Workspace skills root"),
    requireSafeDirectory(resolvedToolingRoot, agentParent, "Workspace agents root"),
    requireSafeDirectory(resolvedToolingRoot, projectSkillParent, "Project skills root"),
  ]);
  const { paths, plan } = await renderedPlan({
    toolingRoot: resolvedToolingRoot,
    templateRoot: resolvedTemplateRoot,
    input,
  });
  await assertDestinationsAbsent(paths);
  const planned = plan.map(({ destination }) => relative(resolvedToolingRoot, destination)).sort();
  if (dryRun) {
    return { name: input.name, dryRun: true, planned, created: [], synchronized: [], checks: ["preflight"] };
  }

  if (sync) await syncWorkspaceFn({ ...syncOptions, write: false });
  await writePlan(paths, plan);
  await verifyWorkspaceHarness({ toolingRoot: resolvedToolingRoot, name: input.name });
  let synchronized = [];
  const checks = ["bundle-contract"];
  if (sync) {
    synchronized = await syncWorkspaceFn({
      ...syncOptions,
      write: true,
    });
    const remaining = await syncWorkspaceFn({
      ...syncOptions,
      write: false,
    });
    if (remaining.length) {
      fail({
        code: "SYNC_DRIFT",
        stage: "workspace_sync_verify",
        path: resolvedWorkspaceRoot,
        message: "После workspace sync остался drift.",
        expected: "пустой список drift",
        actual: remaining.join(", "),
        next: "Исправь canonical sync и повтори agents:sync.",
        details: { remaining },
      });
    }
    checks.push("workspace-sync");
  }
  return {
    name: input.name,
    dryRun: false,
    planned,
    created: planned,
    synchronized,
    checks,
  };
}

function parseArgs(argv) {
  const values = new Map();
  let dryRun = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (!argument?.startsWith("--")) {
      fail({
        code: "UNKNOWN_ARGUMENT",
        stage: "cli_parse",
        path: argument || "",
        message: `Неизвестный аргумент: ${argument || "<пусто>"}.`,
        expected: "--name, --display-name, --description или --dry-run",
        actual: argument || "пусто",
        next: "Исправь команду или запусти её с --help.",
      });
    }
    const key = argument.slice(2);
    if (!["name", "display-name", "description"].includes(key)) {
      fail({
        code: "UNKNOWN_OPTION",
        stage: "cli_parse",
        path: key,
        message: `Неизвестный параметр: --${key}.`,
        expected: "--name, --display-name, --description или --dry-run",
        actual: key,
        next: "Исправь команду или запусти её с --help.",
      });
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail({
        code: "OPTION_VALUE_REQUIRED",
        stage: "cli_parse",
        path: key,
        message: `Для --${key} нужно значение.`,
        expected: "непустая строка",
        actual: value || "пусто",
        next: `Передай значение после --${key}.`,
      });
    }
    if (values.has(key)) {
      fail({
        code: "OPTION_DUPLICATED",
        stage: "cli_parse",
        path: key,
        message: `Параметр --${key} указан несколько раз.`,
        expected: "одно значение",
        actual: "несколько значений",
        next: `Оставь один --${key}.`,
      });
    }
    values.set(key, value);
    index += 1;
  }
  if (help) return { help: true };
  for (const key of ["name", "display-name", "description"]) {
    if (!values.has(key)) {
      fail({
        code: "OPTION_REQUIRED",
        stage: "cli_parse",
        path: key,
        message: `Обязателен --${key}.`,
        expected: "переданный параметр",
        actual: "отсутствует",
        next: `Добавь --${key} или открой --help.`,
      });
    }
  }
  return {
    help: false,
    name: values.get("name"),
    displayName: values.get("display-name"),
    description: values.get("description"),
    dryRun,
  };
}

function renderResult(result) {
  const files = (result.dryRun ? result.planned : result.created).map((path) => `- ${path}`).join("\n");
  const syncSummary = result.dryRun
    ? "не выполнялся"
    : result.synchronized.length
      ? `${result.synchronized.length} managed paths`
      : "workspace уже совпадал с canonical source";
  return `Workspace bundle ${result.dryRun ? "запланирован" : "создан"}: ${result.name}\n\n` +
    `Файлы:\n${files}\n\n` +
    `Проверки: ${result.checks.join(", ")}\n` +
    `Workspace sync: ${syncSummary}\n` +
    `Следующий шаг: заполни workflow и eval cases, затем запусти agents:sync и npm test.\n`;
}

function renderError(error) {
  return `Ошибка [${error.code || "UNEXPECTED"}]\n` +
    `Этап: ${error.stage || "unknown"}\n` +
    `Путь: ${error.path || "не указан"}\n` +
    `Ожидалось: ${error.expected || "успешное выполнение"}\n` +
    `Фактически: ${error.actual || error.message}\n` +
    `Следующий шаг: ${error.next || "устрани причину и повтори команду"}\n`;
}

/** Печатает короткий итог CLI и сохраняет типизированную диагностику ошибок. */
export async function runWorkspaceHarnessCli(
  argv,
  {
    toolingRoot = defaultToolingRoot,
    workspaceRoot,
    stdout = process.stdout,
    stderr = process.stderr,
    syncWorkspaceFn = syncWorkspace,
  } = {},
) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(USAGE);
      return 0;
    }
    const result = await scaffoldWorkspaceHarness({
      ...options,
      toolingRoot,
      workspaceRoot,
      syncWorkspaceFn,
    });
    stdout.write(renderResult(result));
    return 0;
  } catch (error) {
    stderr.write(renderError(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await runWorkspaceHarnessCli(process.argv.slice(2));
}
