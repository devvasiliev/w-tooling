#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { resolve, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { CONFIG_PATH, TOOLING_ROOT, loadProject, validateProject, storedProject, assertSafePath, SetupError } from "./project-config.mjs";
import { workspaceTargets } from "./workspace-layout.mjs";
import { syncWorkspace } from "./sync-workspace.mjs";
import { NotionClient, saveJson, notionToken, notionId, inspectTasks, provisionTasks } from "./notion-tasks.mjs";

const HELP = `Настройка проекта
  ./prepare.sh --code ACME --name "Acme" [--install]
  ./prepare.sh --create-notion --notion-parent PAGE_URL
  ./prepare.sh --notion-database DATABASE_URL --status-property Status
  ./prepare.sh --check

--config FILE             Конфигурация другого checkout
--workspace-root DIR      Общая директория зарегистрированных репозиториев
--releases-root DIR       Checkout релизов внутри workspace
--code CODE               Префикс новых task ID
--name NAME               Название проекта
--create-notion           Создать стандартную базу на --notion-parent
--notion-parent URL       Страница, доступная интеграции
--notion-database URL     Подключить базу/data source или восстановить создание
--title-property NAME    Поле заголовка; обычно определяется автоматически
--code-property NAME     Поле кода unique_id, rich_text, title или number
--status-property NAME   Поле типа status или select
--parent-property NAME   Необязательная relation родителя
--token-stdin             Сохранить токен из stdin в локальный файл 0600
--install                 Установить npm-зависимости через npm ci
--dry-run                 Показать план без записи и запросов Notion
--check                   Проверить настройку и доступ к подключённой базе
Токен можно передать через NOTION_TOKEN. Секрет не печатается.`;

/** Проверяет доступность локального runtime без установки и запуска инфраструктуры. */
export function dependencyReport() {
  return ["node", "npm", "python3", "git", "docker"].map(command => {
    try { return { command, available: true, version: execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
    catch { return { command, available: false }; }
  });
}

/** Выполняет проверенный локальный план и по явному флагу настраивает Notion. */
export async function prepare(argv, { clientFactory = token => new NotionClient({ token }), stdin = process.stdin } = {}) {
  const strings = ["config", "code", "name", "workspace-root", "releases-root", "notion-parent", "notion-database", "title-property", "code-property", "status-property", "parent-property"];
  const booleans = ["create-notion", "token-stdin", "install", "dry-run", "check", "help"];
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: Object.fromEntries([...strings.map(key => [key, { type: "string" }]), ...booleans.map(key => [key, { type: "boolean" }])]) });
  if (values.help) { console.log(HELP); return { help: true }; }
  if (positionals.length) throw new SetupError("INVALID_ARGUMENT", "Неизвестный позиционный аргумент.");
  if (values.check && (values.install || values["create-notion"] || values["token-stdin"] || values["dry-run"] || strings.some(key => !["config", "releases-root"].includes(key) && values[key]))) throw new SetupError("INVALID_MODE", "--check проверяет сохранённую конфигурацию.");
  const configPath = resolve(values.config || process.env.W_PROJECT_CONFIG || CONFIG_PATH);
  const toolingRoot = resolve(dirname(configPath), "..");
  let project = storedProject(loadProject(configPath));
  if (Object.keys(values).every(key => key === "releases-root") && stdin.isTTY) {
    const prompt = createInterface({ input: stdin, output: process.stdout });
    try {
      values.code = (await prompt.question(`Код проекта [${project.code}]: `)) || project.code;
      values.name = (await prompt.question(`Название [${project.name}]: `)) || project.name;
      const mode = (await prompt.question("Notion: create, connect или later [later]: ")).trim() || "later";
      if (mode === "create") { values["create-notion"] = true; values["notion-parent"] = await prompt.question("URL родительской страницы: "); }
      else if (mode === "connect") values["notion-database"] = await prompt.question("URL базы или data source: ");
      else if (mode !== "later") throw new SetupError("INVALID_MODE", "Выбери create, connect или later.");
    } finally { prompt.close(); }
  }
  if (values.code) project.code = values.code.trim().toUpperCase();
  if (values.name) project.name = values.name.trim();
  if (values["workspace-root"]) project.workspaceRoot = relative(toolingRoot, resolve(values["workspace-root"])) || ".";
  const workspaceRoot = resolve(toolingRoot, project.workspaceRoot);
  if (values["releases-root"]) {
    const item = project.repositories.find(repository => repository.role === "releases");
    if (!item) throw new SetupError("RELEASES_NOT_REGISTERED", "Добавь releases в реестр.");
    if (values.check && resolve(workspaceRoot, item.path) !== resolve(values["releases-root"]))
      throw new SetupError("RELEASES_ROOT_MISMATCH", "Текущий checkout releases отличается от зарегистрированного.");
    item.path = relative(workspaceRoot, resolve(values["releases-root"]));
  }
  if (values["notion-database"]) project.notion.databaseId = notionId(values["notion-database"]);
  for (const key of ["title", "code", "status", "parent"]) if (values[`${key}-property`]) project.notion.properties[key] = values[`${key}-property`];
  project = validateProject(project, configPath);
  const owning = project.repositories.find(repository => repository.role === "tooling");
  if (!owning || resolve(project.workspace, owning.path) !== toolingRoot) throw new SetupError("TOOLING_ROOT_MISMATCH", "Конфигурация должна принадлежать зарегистрированному tooling checkout.");
  if (values["create-notion"] && !values["notion-parent"]) throw new SetupError("NOTION_PARENT_REQUIRED", "Для создания базы нужен --notion-parent.");
  if (values["notion-parent"]) notionId(values["notion-parent"]);
  const releases = project.repositories.find(repository => repository.role === "releases");
  const releaseConfig = releases ? resolve(project.workspace, releases.path, "config/project.json") : null;
  const secretPath = join(toolingRoot, ".project/notion-secret.json");
  const journalPath = join(toolingRoot, ".project/notion-setup.json");
  const lockPath = join(toolingRoot, ".project/prepare.lock");
  for (const path of [configPath, releaseConfig, secretPath, journalPath, lockPath].filter(Boolean)) assertSafePath(path);
  let previousRelease = {};
  if (releaseConfig) {
    try { previousRelease = JSON.parse(await readFile(releaseConfig, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new SetupError("INVALID_RELEASE_CONFIG", `Проверь JSON: ${releaseConfig}`, releaseConfig); }
    if (!previousRelease || typeof previousRelease !== "object" || Array.isArray(previousRelease))
      throw new SetupError("INVALID_RELEASE_CONFIG", "Конфигурация релизов должна быть объектом.", releaseConfig);
  }
  const syncOptions = { toolingRoot, workspaceRoot: project.workspace, layout: workspaceTargets(project) };
  // Снимок всех generated destinations проверяется до любого локального изменения.
  const drift = await syncWorkspace({ ...syncOptions, write: false });
  const dependencies = dependencyReport();
  if (Number(process.versions.node.split(".")[0]) < 22 || dependencies.some(item => ["node", "npm", "python3", "git"].includes(item.command) && !item.available)) throw new SetupError("DEPENDENCY_MISSING", "Нужны Node.js >=22, npm, Python >=3.11 и Git.");
  const pythonVersion = dependencies.find(item => item.command === "python3").version.match(/Python (\d+)\.(\d+)/);
  if (!pythonVersion || Number(pythonVersion[1]) < 3 || (Number(pythonVersion[1]) === 3 && Number(pythonVersion[2]) < 11))
    throw new SetupError("DEPENDENCY_VERSION", "Нужен Python >=3.11.");
  if (values["dry-run"]) return { mode: "plan", project: storedProject(project), generatedFiles: drift.length, dependencies, notionAction: values["create-notion"] ? "create" : project.notion.databaseId ? "inspect" : "configure-later" };
  let token = await notionToken(toolingRoot);
  if (values["token-stdin"]) {
    let buffer = ""; for await (const chunk of stdin) buffer += chunk;
    token = buffer.trim();
    if (!token || /\s/.test(token)) throw new SetupError("INVALID_TOKEN", "stdin должен содержать один токен.");
  }
  const needsNotion = values["create-notion"] || project.notion.databaseId;
  if (needsNotion && !token) throw new SetupError("NOTION_TOKEN_REQUIRED", "Задай NOTION_TOKEN или передай токен через --token-stdin.");
  if (values.check) {
    if (releaseConfig && (previousRelease.code !== project.code || previousRelease.name !== project.name))
      throw new SetupError("RELEASE_CONFIG_DRIFT", "Код или название проекта расходятся с конфигурацией релизов. Выполни ./prepare.sh.", releaseConfig);
    if (drift.length) throw new SetupError("GENERATED_DRIFT", `Требуется prepare.sh: различаются ${drift.length} файлов.`);
    if (needsNotion) await inspectTasks(clientFactory(token), project);
    return { mode: "check", code: project.code, dependencies, notion: needsNotion ? "verified" : "not-configured" };
  }
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new SetupError("PREPARE_LOCKED", `Другой prepare активен. Проверь PID в ${lockPath} перед удалением lock.`, lockPath); throw error; }
  try {
    await lock.writeFile(`${process.pid}\n`);
    if (values["token-stdin"]) await saveJson(secretPath, { token });
    if (values["create-notion"]) project.notion = await provisionTasks(clientFactory(token), project, { parent: values["notion-parent"], existingId: values["notion-database"], journalPath });
    else if (needsNotion) await inspectTasks(clientFactory(token), project);
    if (values.install) execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: toolingRoot, stdio: "inherit" });
    await saveJson(configPath, storedProject(project), 0o644);
    if (releaseConfig) {
      await saveJson(releaseConfig, { schemaVersion: 1, deployRoot: ".runtime", stateRoot: ".state", topologyRevision: "1", lockTimeout: 30, hookTimeout: 300, ...previousRelease, code: project.code, name: project.name }, 0o644);
    }
    await syncWorkspace({ ...syncOptions, write: true });
  } finally { await lock.close(); await unlink(lockPath); }
  return { mode: "prepared", code: project.code, repositories: project.repositories.map(item => item.name), dependencies, notion: needsNotion ? "verified" : "not-configured", next: needsNotion ? "./prepare.sh --check" : "NOTION_TOKEN=... ./prepare.sh --create-notion --notion-parent PAGE_URL" };
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) prepare(process.argv.slice(2)).then(result => { if (!result.help) console.log(JSON.stringify(result, null, 2)); }).catch(error => { console.error(`${error.code || "PREPARE_FAILED"}: ${error.message}`); process.exitCode = 1; });
