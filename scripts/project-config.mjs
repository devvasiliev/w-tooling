import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = resolve(TOOLING_ROOT, "config/project.json");

/** Ошибка конфигурации сохраняет причину и путь для CLI и проверок. */
export class SetupError extends Error {
  constructor(code, message, path = "") { super(message); this.code = code; this.path = path; }
}

/** Проверяет каждый существующий компонент пути до записи или запуска команды. */
export function assertSafePath(path) {
  let cursor = resolve(path);
  while (true) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new SetupError("SYMLINK_PATH", `Симлинк в пути: ${cursor}`, cursor);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

/** Загружает переносимые настройки относительно самого checkout. */
export function loadProject(configPath = process.env.W_PROJECT_CONFIG || CONFIG_PATH) {
  assertSafePath(configPath);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return validateProject(config, configPath);
}

/** Проверяет план настройки до создания каких-либо файлов. */
export function validateProject(config, configPath = CONFIG_PATH) {
  if (config.schemaVersion !== 1 || !/^[A-Z][A-Z0-9]{0,15}$/.test(config.code))
    throw new SetupError("INVALID_PROJECT_CODE", "Код проекта: 1–16 латинских букв или цифр, первая буква.", configPath);
  if (typeof config.name !== "string" || !config.name.trim() || /[\x00-\x1f]/.test(config.name))
    throw new SetupError("INVALID_PROJECT_NAME", "Задай название проекта одной строкой.", configPath);
  const root = resolve(dirname(configPath), "..", config.workspaceRoot || "..");
  assertSafePath(root);
  if (!Array.isArray(config.repositories) || config.repositories.length === 0)
    throw new SetupError("INVALID_REPOSITORIES", "Задай реестр репозиториев.", configPath);
  const names = new Set(); const paths = new Set();
  for (const repository of config.repositories) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(repository.name) || names.has(repository.name))
      throw new SetupError("INVALID_REPOSITORY", "Имена репозиториев должны быть уникальны.", configPath);
    if (typeof repository.path !== "string" || isAbsolute(repository.path) || repository.path.split(/[\\/]/).some(x => x === ".." || x === "."))
      throw new SetupError("INVALID_REPOSITORY_PATH", "Путь репозитория должен находиться внутри workspace.", configPath);
    const target = resolve(root, repository.path);
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || [...paths].some(path => path === target || path.startsWith(target + sep) || target.startsWith(path + sep)))
      throw new SetupError("INVALID_REPOSITORY_PATH", "Пути репозиториев должны быть разными вложенными каталогами.", target);
    assertSafePath(target);
    if (!lstatSync(target).isDirectory()) throw new SetupError("MISSING_REPOSITORY", "Репозиторий отсутствует.", target);
    names.add(repository.name); paths.add(target);
  }
  for (const role of ["tooling", "releases"]) if (config.repositories.filter(repository => repository.role === role).length > 1)
    throw new SetupError("DUPLICATE_REPOSITORY_ROLE", `Роль ${role} должна иметь одного владельца.`, configPath);
  if (!config.notion || !config.notion.properties || typeof config.notion.properties !== "object" || Array.isArray(config.notion.properties))
    throw new SetupError("INVALID_NOTION_CONFIG", "Задай notion.properties.", configPath);
  return { ...config, workspace: realpathSync(root), configPath: resolve(configPath) };
}

/** Возвращает настройки, которые можно сохранить без производных абсолютных путей. */
export function storedProject(config) {
  const { workspace, configPath, ...stored } = config;
  return stored;
}
