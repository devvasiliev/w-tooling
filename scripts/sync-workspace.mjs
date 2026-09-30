#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { workspaceTargets } from "./workspace-layout.mjs";
import { loadProject } from "./project-config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const defaultToolingRoot = resolve(dirname(currentFile), "..");
const defaultWorkspaceRoot = resolve(defaultToolingRoot, "..");
const MAX_AGENTS_LINES = 100;
const REGULAR_FILE_MODE = 0o644;
const EXECUTABLE_FILE_MODE = 0o755;
const RULE_LINK_PATTERN = /\]\(\.codex\/rules\/([^)]+\.md)\)/gu;
const SKILL_REFERENCE_PATTERN = /\$([a-z0-9]+(?:-[a-z0-9]+)*)/gu;
const CUSTOM_AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CUSTOM_AGENT_FIELDS = Object.freeze([
  "name",
  "description",
  "sandbox_mode",
  "developer_instructions",
]);
const AGENT_TOML_PARSER = `
import json
import sys
import tomllib

document = tomllib.loads(sys.stdin.buffer.read().decode("utf-8"))
fields = ("name", "description", "sandbox_mode", "developer_instructions")
payload = {field: document.get(field) for field in fields}
payload["__keys"] = sorted(document.keys())
print(json.dumps(payload, ensure_ascii=False))
`;

/** Ошибка sync с машинно-стабильной причиной и локализацией этапа. */
export class WorkspaceSyncError extends Error {
  constructor({ code, stage, path, message, details = {} }) {
    super(message);
    this.name = "WorkspaceSyncError";
    this.code = code;
    this.stage = stage;
    this.path = path;
    this.details = Object.freeze({ ...details });
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function listFiles(root, prefix = "") {
  const directory = join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push(child);
    else {
      throw new WorkspaceSyncError({
        code: "UNSAFE_ENTRY",
        stage: "canonical_tree_entry",
        path: join(root, child),
        message: `Canonical tree содержит symbolic link или special entry: ${child}`,
      });
    }
  }
  return files.sort();
}

async function listTreeEntries(root, prefix = "") {
  if (!(await exists(root))) return [];
  const directory = join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    const child = join(prefix, entry.name);
    if (entry.isDirectory()) {
      items.push({ path: child, type: "directory" });
      items.push(...(await listTreeEntries(root, child)));
    } else {
      items.push({ path: child, type: entry.isFile() ? "file" : "other" });
    }
  }
  return items.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Снимает no-follow snapshot managed-дерева до первой записи и запрещает
 * ссылки или special entries, которые нельзя безопасно считать generated.
 */
async function snapshotManagedExactTree(checkoutRoot, targetRoot) {
  await validateManagedTarget(checkoutRoot, targetRoot);
  const entries = await listTreeEntries(targetRoot);
  const unsafeEntry = entries.find(({ type }) => type === "other");
  if (unsafeEntry) {
    const path = join(targetRoot, unsafeEntry.path);
    throw new WorkspaceSyncError({
      code: "UNSAFE_ENTRY",
      stage: "managed_tree_entry",
      path,
      message: `Managed tree содержит symbolic link или special entry: ${path}`,
    });
  }
  return entries;
}

function parentDirectories(path) {
  const parts = path.split(/[\\/]/u);
  return parts.slice(0, -1).map((_, index) => join(...parts.slice(0, index + 1)));
}

async function lstatOptional(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function normalizedGitFileMode(mode) {
  return (mode & 0o111) === 0 ? REGULAR_FILE_MODE : EXECUTABLE_FILE_MODE;
}

/** Сохраняет bytes и единственный поддерживаемый Git permission-bit. */
async function readFileSnapshot(path) {
  const [content, metadata] = await Promise.all([readFile(path), lstat(path)]);
  return { content, mode: normalizedGitFileMode(metadata.mode) };
}

function escapesRoot(root, target) {
  const path = relative(root, target);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function validateDirectoryRoot(root, label, stage) {
  const metadata = await lstatOptional(root);
  if (metadata === null) {
    throw new WorkspaceSyncError({
      code: "MISSING_PATH",
      stage,
      path: root,
      message: `${label} отсутствует: ${root}`,
    });
  }
  if (metadata.isSymbolicLink()) {
    throw new WorkspaceSyncError({
      code: "SYMLINK_PATH",
      stage,
      path: root,
      message: `${label} содержит symbolic link: ${root}`,
    });
  }
  if (!metadata.isDirectory()) {
    throw new WorkspaceSyncError({
      code: "UNEXPECTED_PATH_TYPE",
      stage,
      path: root,
      message: `${label} не является directory: ${root}`,
      details: { expectedType: "directory" },
    });
  }
}

/** Запрещает подмену зарегистрированного checkout внешним каталогом. */
async function validateWorkspaceTarget(workspaceRoot, targetRoot, targetName) {
  if (targetRoot !== workspaceRoot && escapesRoot(workspaceRoot, targetRoot)) {
    throw new WorkspaceSyncError({
      code: "PATH_OUTSIDE_ROOT",
      stage: "workspace_target",
      path: targetRoot,
      message: `Target ${targetName} выходит за пределы workspace: ${targetRoot}`,
      details: { root: workspaceRoot, targetName },
    });
  }
  await validateDirectoryRoot(targetRoot, `Target ${targetName}`, "workspace_target");
  const workspaceReal = await realpath(workspaceRoot);
  const targetReal = await realpath(targetRoot);
  if (targetRoot !== workspaceRoot && escapesRoot(workspaceReal, targetReal)) {
    throw new WorkspaceSyncError({
      code: "PATH_RESOLVES_OUTSIDE_ROOT",
      stage: "workspace_target",
      path: targetRoot,
      message: `Target ${targetName} разрешается за пределы workspace: ${targetRoot}`,
      details: { root: workspaceRoot, targetName },
    });
  }
}

/** Запрещает managed-пути, способные перенаправить sync за пределы checkout. */
async function validateManagedTarget(checkoutRoot, targetRoot) {
  if (targetRoot === checkoutRoot || escapesRoot(checkoutRoot, targetRoot)) {
    throw new WorkspaceSyncError({
      code: "PATH_OUTSIDE_ROOT",
      stage: "managed_target",
      path: targetRoot,
      message: `Managed target выходит за пределы checkout: ${targetRoot}`,
      details: { root: checkoutRoot },
    });
  }
  const checkoutReal = await realpath(checkoutRoot);
  const relativeTarget = relative(checkoutRoot, targetRoot);
  let current = checkoutRoot;
  for (const part of relativeTarget.split(/[\\/]/u)) {
    current = join(current, part);
    const metadata = await lstatOptional(current);
    if (metadata === null) break;
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceSyncError({
        code: "SYMLINK_PATH",
        stage: "managed_target",
        path: current,
        message: `Managed target содержит symbolic link: ${current}`,
      });
    }
    if (!metadata.isDirectory()) {
      throw new WorkspaceSyncError({
        code: "UNEXPECTED_PATH_TYPE",
        stage: "managed_target",
        path: current,
        message: `Managed target содержит не-directory компонент: ${current}`,
        details: { expectedType: "directory" },
      });
    }
    const currentReal = await realpath(current);
    if (escapesRoot(checkoutReal, currentReal)) {
      throw new WorkspaceSyncError({
        code: "PATH_RESOLVES_OUTSIDE_ROOT",
        stage: "managed_target",
        path: current,
        message: `Managed target разрешается за пределы checkout: ${current}`,
        details: { root: checkoutRoot },
      });
    }
  }
}

/** Проверяет, что каноническое дерево принадлежит tooling и не подменено ссылкой. */
async function validateCanonicalTreeRoot(toolingRoot, sourceRoot) {
  if (sourceRoot === toolingRoot || escapesRoot(toolingRoot, sourceRoot)) {
    throw new WorkspaceSyncError({
      code: "PATH_OUTSIDE_ROOT",
      stage: "canonical_tree",
      path: sourceRoot,
      message: `Canonical tree root выходит за пределы tooling: ${sourceRoot}`,
      details: { root: toolingRoot },
    });
  }
  const metadata = await lstatOptional(sourceRoot);
  if (metadata === null) {
    throw new WorkspaceSyncError({
      code: "MISSING_PATH",
      stage: "canonical_tree",
      path: sourceRoot,
      message: `Canonical tree root отсутствует: ${sourceRoot}`,
    });
  }
  if (metadata.isSymbolicLink()) {
    throw new WorkspaceSyncError({
      code: "SYMLINK_PATH",
      stage: "canonical_tree",
      path: sourceRoot,
      message: `Canonical tree root содержит symbolic link: ${sourceRoot}`,
    });
  }
  if (!metadata.isDirectory()) {
    throw new WorkspaceSyncError({
      code: "UNEXPECTED_PATH_TYPE",
      stage: "canonical_tree",
      path: sourceRoot,
      message: `Canonical tree root не является directory: ${sourceRoot}`,
      details: { expectedType: "directory" },
    });
  }
  await validateManagedTarget(toolingRoot, sourceRoot);
}

/** Проверяет одиночный канонический файл до начала синхронизации. */
async function validateCanonicalFile(toolingRoot, source) {
  if (source === toolingRoot || escapesRoot(toolingRoot, source)) {
    throw new WorkspaceSyncError({
      code: "PATH_OUTSIDE_ROOT",
      stage: "canonical_file",
      path: source,
      message: `Canonical file выходит за пределы tooling: ${source}`,
      details: { root: toolingRoot },
    });
  }
  const parent = dirname(source);
  if (parent !== toolingRoot) {
    await validateManagedTarget(toolingRoot, parent);
  }
  const metadata = await lstatOptional(source);
  if (metadata === null) {
    throw new WorkspaceSyncError({
      code: "MISSING_PATH",
      stage: "canonical_file",
      path: source,
      message: `Canonical file отсутствует: ${source}`,
    });
  }
  if (metadata.isSymbolicLink()) {
    throw new WorkspaceSyncError({
      code: "SYMLINK_PATH",
      stage: "canonical_file",
      path: source,
      message: `Canonical file содержит symbolic link: ${source}`,
    });
  }
  if (!metadata.isFile()) {
    throw new WorkspaceSyncError({
      code: "UNEXPECTED_PATH_TYPE",
      stage: "canonical_file",
      path: source,
      message: `Canonical file не является обычным файлом: ${source}`,
      details: { expectedType: "file" },
    });
  }
}

/** Проверяет родительские каталоги и не следует через symlink конечного файла. */
async function validateManagedFile(checkoutRoot, destination) {
  if (destination === checkoutRoot || escapesRoot(checkoutRoot, destination)) {
    throw new WorkspaceSyncError({
      code: "PATH_OUTSIDE_ROOT",
      stage: "managed_file",
      path: destination,
      message: `Managed file выходит за пределы checkout: ${destination}`,
      details: { root: checkoutRoot },
    });
  }
  const parent = dirname(destination);
  if (parent !== checkoutRoot) {
    await validateManagedTarget(checkoutRoot, parent);
  }
  const metadata = await lstatOptional(destination);
  if (metadata?.isSymbolicLink()) {
    throw new WorkspaceSyncError({
      code: "SYMLINK_PATH",
      stage: "managed_file",
      path: destination,
      message: `Managed file содержит symbolic link: ${destination}`,
    });
  }
  if (metadata !== null && !metadata.isFile()) {
    throw new WorkspaceSyncError({
      code: "UNEXPECTED_PATH_TYPE",
      stage: "managed_file",
      path: destination,
      message: `Managed file не является обычным файлом: ${destination}`,
      details: { expectedType: "file" },
    });
  }
  return metadata;
}

async function syncBuffer(expected, destination, { write, drifts, checkoutRoot }) {
  const metadata = await validateManagedFile(checkoutRoot, destination);
  const actual = metadata === null ? null : await readFile(destination);
  const contentMatches = actual?.equals(expected.content) ?? false;
  const modeMatches =
    metadata !== null && normalizedGitFileMode(metadata.mode) === expected.mode;
  if (contentMatches && modeMatches) return;
  drifts.push(destination);
  if (!write) return;
  await mkdir(dirname(destination), { recursive: true });
  if (!contentMatches) await writeFile(destination, expected.content);
  await chmod(destination, expected.mode);
}

async function syncText(expected, destination, { write, drifts, checkoutRoot }) {
  const metadata = await validateManagedFile(checkoutRoot, destination);
  const actual = metadata === null ? null : await readFile(destination);
  const contentMatches = actual?.toString("utf8") === expected;
  const modeMatches =
    metadata !== null && normalizedGitFileMode(metadata.mode) === REGULAR_FILE_MODE;
  if (contentMatches && modeMatches) return;
  drifts.push(destination);
  if (!write) return;
  await mkdir(dirname(destination), { recursive: true });
  if (!contentMatches) await writeFile(destination, expected, "utf8");
  await chmod(destination, REGULAR_FILE_MODE);
}

/**
 * Синхронизирует generated-дерево целиком, чтобы удалённая инструкция не
 * продолжала действовать после исчезновения её канонического файла.
 */
async function syncExactTree(
  sourceRoots,
  sourceFiles,
  sourceContents,
  targetRoot,
  targetEntries,
  { write, drifts, checkoutRoot, toolingRoot },
) {
  for (const sourceRoot of sourceRoots) {
    await validateCanonicalTreeRoot(toolingRoot, sourceRoot);
  }
  await validateManagedTarget(checkoutRoot, targetRoot);
  const expectedFiles = new Set(sourceFiles);
  const expectedDirectories = new Set(sourceFiles.flatMap(parentDirectories));
  const invalidDirectories = [];
  const invalidFiles = new Set();

  for (const entry of targetEntries) {
    if (invalidDirectories.some((path) => entry.path.startsWith(`${path}/`))) continue;
    const expectedType = expectedFiles.has(entry.path)
      ? "file"
      : expectedDirectories.has(entry.path)
        ? "directory"
        : "";
    if (entry.type === expectedType) continue;

    const target = join(targetRoot, entry.path);
    drifts.push(target);
    if (entry.type === "directory" || expectedType === "directory") {
      invalidDirectories.push(entry.path);
    } else {
      invalidFiles.add(entry.path);
    }
    if (write) {
      await rm(target, { recursive: entry.type === "directory", force: true });
    }
  }

  for (const sourceFile of sourceFiles) {
    const blocked = invalidFiles.has(sourceFile)
      || invalidDirectories.some(
        (path) => sourceFile === path || sourceFile.startsWith(`${path}/`),
      );
    if (blocked && !write) continue;
    await syncBuffer(sourceContents.get(sourceFile), join(targetRoot, sourceFile), {
      write,
      drifts,
      checkoutRoot,
    });
  }
}

function mergeCanonicalTrees(primary, workspaceOnly) {
  const collision = workspaceOnly.files.find((workspacePath) =>
    primary.files.some(
      (projectPath) =>
        workspacePath === projectPath
        || workspacePath.startsWith(`${projectPath}/`)
        || projectPath.startsWith(`${workspacePath}/`),
    ),
  );
  if (collision) {
    throw new WorkspaceSyncError({
      code: "CANONICAL_TREE_COLLISION",
      stage: "canonical_tree_merge",
      path: collision,
      message: `Workspace-only skill конфликтует с project skill: ${collision}`,
    });
  }
  return {
    files: [...primary.files, ...workspaceOnly.files].sort(),
    contents: new Map([...primary.contents, ...workspaceOnly.contents]),
  };
}

function parseWorkspaceAgentToml(content, path) {
  try {
    const output = execFileSync("python3", ["-c", AGENT_TOML_PARSER], {
      input: content,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(output);
  } catch (error) {
    throw new WorkspaceSyncError({
      code: "INVALID_AGENT_DEFINITION",
      stage: "custom_agent_definition",
      path,
      message: `Custom agent содержит невалидный TOML: ${path}`,
      details: {
        reason: "invalid_toml",
        parser: error?.stderr?.toString("utf8").trim() || error.message,
      },
    });
  }
}

function requireAgentString(document, field, path) {
  const value = document[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkspaceSyncError({
      code: "INVALID_AGENT_DEFINITION",
      stage: "custom_agent_definition",
      path,
      message: `Custom agent должен содержать непустое строковое поле ${field}: ${path}`,
      details: { field, occurrences: value === null || value === undefined ? 0 : 1 },
    });
  }
  return value;
}

/**
 * Полностью разбирает TOML стандартным parser и затем проверяет узкий
 * контракт задачи консультативных custom agents.
 */
function validateWorkspaceAgentDefinitions(agentFiles, snapshots, agentRoot) {
  for (const [index, agentFile] of agentFiles.entries()) {
    const path = join(agentRoot, agentFile);
    if (dirname(agentFile) !== "." || !agentFile.endsWith(".toml")) {
      throw new WorkspaceSyncError({
        code: "INVALID_AGENT_PATH",
        stage: "custom_agent_definition",
        path,
        message: `Custom agent должен быть отдельным TOML-файлом в корне каталога: ${path}`,
      });
    }
    const content = snapshots[index].content.toString("utf8");
    const document = parseWorkspaceAgentToml(content, path);
    const unknownFields = document.__keys.filter((field) => !CUSTOM_AGENT_FIELDS.includes(field));
    if (unknownFields.length) {
      throw new WorkspaceSyncError({
        code: "INVALID_AGENT_DEFINITION",
        stage: "custom_agent_definition",
        path,
        message: `Custom agent содержит неподдерживаемые поля: ${unknownFields.join(", ")}.`,
        details: { field: unknownFields[0], reason: "unknown_field", unknownFields },
      });
    }
    const name = requireAgentString(document, "name", path);
    requireAgentString(document, "description", path);
    const sandboxMode = requireAgentString(document, "sandbox_mode", path);
    requireAgentString(document, "developer_instructions", path);
    if (!CUSTOM_AGENT_NAME_PATTERN.test(name) || `${name}.toml` !== agentFile) {
      throw new WorkspaceSyncError({
        code: "INVALID_AGENT_DEFINITION",
        stage: "custom_agent_definition",
        path,
        message: `Custom agent имеет несовместимые filename и name: ${path}`,
        details: { field: "name", name, filename: agentFile },
      });
    }
    if (sandboxMode !== "read-only") {
      throw new WorkspaceSyncError({
        code: "INVALID_AGENT_DEFINITION",
        stage: "custom_agent_definition",
        path,
        message: `Консультативный custom agent должен быть read-only: ${path}`,
        details: { field: "sandbox_mode", actual: sandboxMode },
      });
    }
  }
}

function validateAgentsRouter({ shared, appendix, ruleFiles, ruleHeadings, targetName }) {
  const links = [...shared.matchAll(RULE_LINK_PATTERN)].map((match) => match[1]);
  const linkedRules = new Set(links);
  const expectedRules = new Set(ruleFiles);

  for (const ruleFile of ruleFiles) {
    if (!linkedRules.has(ruleFile)) {
      throw new WorkspaceSyncError({
        code: "MISSING_RULE_REFERENCE",
        stage: "agents_router",
        path: ruleFile,
        message: `AGENTS router не ссылается на .codex/rules/${ruleFile}`,
        details: { targetName },
      });
    }
  }
  for (const linkedRule of linkedRules) {
    if (!expectedRules.has(linkedRule)) {
      throw new WorkspaceSyncError({
        code: "UNKNOWN_RULE_REFERENCE",
        stage: "agents_router",
        path: linkedRule,
        message: `AGENTS router ссылается на отсутствующий rule-модуль: ${linkedRule}`,
        details: { targetName },
      });
    }
  }

  const agents = `${shared}\n\n${appendix}\n`;
  const lineCount = agents.split("\n").length - 1;
  if (lineCount > MAX_AGENTS_LINES) {
    throw new WorkspaceSyncError({
      code: "AGENTS_TOO_LARGE",
      stage: "agents_router",
      path: targetName,
      message: `AGENTS.md для ${targetName} содержит ${lineCount} строк при лимите ${MAX_AGENTS_LINES}`,
      details: { lineCount, maxLines: MAX_AGENTS_LINES },
    });
  }
  for (const heading of ruleHeadings) {
    if (agents.split("\n").includes(heading)) {
      throw new WorkspaceSyncError({
        code: "DUPLICATE_RULE_HEADING",
        stage: "agents_router",
        path: targetName,
        message: `В compact AGENTS.md возвращён вынесенный раздел: ${heading}`,
        details: { heading },
      });
    }
  }
  return agents;
}

/**
 * Останавливает синхронизацию, если инструкция требует отсутствующий skill:
 * иначе все репозитории получат обязательное правило, которое нельзя выполнить.
 */
function validateRuleSkillReferences({ ruleContents, skillFiles }) {
  const availableSkills = new Set(
    skillFiles
      .filter((path) => path.endsWith("/SKILL.md"))
      .map((path) => path.split(/[\\/]/u)[0]),
  );
  const referencedSkills = new Set(
    ruleContents.flatMap((content) =>
      [...content.matchAll(SKILL_REFERENCE_PATTERN)].map((match) => match[1]),
    ),
  );
  for (const skill of referencedSkills) {
    if (!availableSkills.has(skill)) {
      throw new WorkspaceSyncError({
        code: "UNKNOWN_SKILL_REFERENCE",
        stage: "rule_skill_reference",
        path: skill,
        message: `Rule-модуль ссылается на отсутствующий project skill: $${skill}`,
      });
    }
  }
}

export async function syncWorkspace({
  workspaceRoot,
  toolingRoot = defaultToolingRoot,
  write = false,
  layout,
} = {}) {
  if (!layout) {
    const project = loadProject(process.env.W_PROJECT_CONFIG || join(toolingRoot, "config/project.json"));
    layout = workspaceTargets(project);
    workspaceRoot ??= project.workspace;
  }
  workspaceRoot ??= defaultWorkspaceRoot;
  await validateDirectoryRoot(workspaceRoot, "Workspace root", "workspace_root");
  await validateDirectoryRoot(toolingRoot, "Tooling root", "tooling_root");
  const targets = layout.map(({ name, relativeRoot, appendixName }) => ({
    name,
    targetRoot: resolve(workspaceRoot, relativeRoot),
    appendixName,
  }));
  await Promise.all(
    targets.map(({ name, targetRoot }) =>
      validateWorkspaceTarget(workspaceRoot, targetRoot, name),
    ),
  );

  const ruleRoot = join(toolingRoot, "templates", "agent-rules");
  const skillRoot = join(toolingRoot, ".codex", "skills");
  const workspaceSkillRoot = join(toolingRoot, "templates", "workspace-skills");
  const workspaceAgentRoot = join(toolingRoot, "templates", "workspace-agents");
  await validateCanonicalTreeRoot(toolingRoot, ruleRoot);
  await validateCanonicalTreeRoot(toolingRoot, skillRoot);
  await validateCanonicalTreeRoot(toolingRoot, workspaceSkillRoot);
  await validateCanonicalTreeRoot(toolingRoot, workspaceAgentRoot);
  const sharedPath = join(toolingRoot, "templates", "AGENTS.shared.md");
  const appendixPaths = targets.map(({ appendixName }) =>
    join(toolingRoot, "templates", "agents", appendixName),
  );
  await Promise.all(
    [sharedPath, ...appendixPaths].map(
      (source) => validateCanonicalFile(toolingRoot, source),
    ),
  );

  const ruleFiles = await listFiles(ruleRoot);
  const skillFiles = await listFiles(skillRoot);
  const workspaceSkillFiles = await listFiles(workspaceSkillRoot);
  const workspaceAgentFiles = await listFiles(workspaceAgentRoot);
  const treeSources = [
    ...ruleFiles.map((path) => join(ruleRoot, path)),
    ...skillFiles.map((path) => join(skillRoot, path)),
    ...workspaceSkillFiles.map((path) => join(workspaceSkillRoot, path)),
    ...workspaceAgentFiles.map((path) => join(workspaceAgentRoot, path)),
  ];
  await Promise.all(
    treeSources.map((source) => validateCanonicalFile(toolingRoot, source)),
  );
  const [
    sharedSnapshot,
    appendixSnapshots,
    ruleSnapshots,
    skillSnapshots,
    workspaceSkillSnapshots,
    workspaceAgentSnapshots,
  ] =
    await Promise.all([
      readFileSnapshot(sharedPath),
      Promise.all(appendixPaths.map((path) => readFileSnapshot(path))),
      Promise.all(ruleFiles.map((path) => readFileSnapshot(join(ruleRoot, path)))),
      Promise.all(skillFiles.map((path) => readFileSnapshot(join(skillRoot, path)))),
      Promise.all(
        workspaceSkillFiles.map((path) => readFileSnapshot(join(workspaceSkillRoot, path))),
      ),
      Promise.all(
        workspaceAgentFiles.map((path) => readFileSnapshot(join(workspaceAgentRoot, path))),
      ),
    ]);
  const shared = sharedSnapshot.content.toString("utf8").trimEnd();
  const appendices = new Map(
    targets.map(({ name }, index) => [
      name,
      appendixSnapshots[index].content.toString("utf8").trim(),
    ]),
  );
  const ruleContents = ruleSnapshots.map(({ content }) => content.toString("utf8"));
  const ruleContentsByPath = new Map(
    ruleFiles.map((path, index) => [path, ruleSnapshots[index]]),
  );
  const skillContentsByPath = new Map(
    skillFiles.map((path, index) => [path, skillSnapshots[index]]),
  );
  const workspaceSkillContentsByPath = new Map(
    workspaceSkillFiles.map((path, index) => [path, workspaceSkillSnapshots[index]]),
  );
  const workspaceAgentContentsByPath = new Map(
    workspaceAgentFiles.map((path, index) => [path, workspaceAgentSnapshots[index]]),
  );
  validateWorkspaceAgentDefinitions(
    workspaceAgentFiles,
    workspaceAgentSnapshots,
    workspaceAgentRoot,
  );
  const combinedSkills = mergeCanonicalTrees(
    { files: skillFiles, contents: skillContentsByPath },
    { files: workspaceSkillFiles, contents: workspaceSkillContentsByPath },
  );
  const ruleHeadings = ruleContents.flatMap((content) =>
    content
      .split("\n")
      .filter((line) => line.startsWith("## ")),
  );
  validateRuleSkillReferences({ ruleContents, skillFiles });
  const renderedAgents = new Map(
    targets.map(({ name }) => [
      name,
      validateAgentsRouter({
        shared,
        appendix: appendices.get(name),
        ruleFiles,
        ruleHeadings,
        targetName: name,
      }),
    ]),
  );
  const drifts = [];

  const targetPlans = await Promise.all(
    targets.map(async ({ name, targetRoot }) => {
      const rulesRoot = join(targetRoot, ".codex", "rules");
      const skillsRoot = join(targetRoot, ".codex", "skills");
      const workspaceSkillsRoot = join(targetRoot, ".agents", "skills");
      const agentsRoot = join(targetRoot, ".codex", "agents");
      const [rulesEntries, skillsEntries, workspaceSkillsEntries, agentsEntries] = await Promise.all([
        snapshotManagedExactTree(targetRoot, rulesRoot),
        targetRoot === toolingRoot
          ? Promise.resolve(null)
          : snapshotManagedExactTree(targetRoot, skillsRoot),
        workspaceSkillsRoot === null
          ? Promise.resolve(null)
          : snapshotManagedExactTree(targetRoot, workspaceSkillsRoot),
        agentsRoot === null
          ? Promise.resolve(null)
          : snapshotManagedExactTree(targetRoot, agentsRoot),
      ]);
      await validateManagedFile(targetRoot, join(targetRoot, "AGENTS.md"));
      return {
        name,
        targetRoot,
        rulesRoot,
        rulesEntries,
        skillsRoot,
        skillsEntries,
        workspaceSkillsRoot,
        workspaceSkillsEntries,
        agentsRoot,
        agentsEntries,
      };
    }),
  );


  for (const {
    name,
    targetRoot,
    rulesRoot,
    rulesEntries,
    skillsRoot,
    skillsEntries,
    workspaceSkillsRoot,
    workspaceSkillsEntries,
    agentsRoot,
    agentsEntries,
  } of targetPlans) {
    await syncText(renderedAgents.get(name), join(targetRoot, "AGENTS.md"), {
      write,
      drifts,
      checkoutRoot: targetRoot,
    });

    await syncExactTree(
      [ruleRoot],
      ruleFiles,
      ruleContentsByPath,
      rulesRoot,
      rulesEntries,
      {
        write,
        drifts,
        checkoutRoot: targetRoot,
        toolingRoot,
      },
    );

    if (targetRoot !== toolingRoot) {
      await syncExactTree(
        [skillRoot],
        skillFiles,
        skillContentsByPath,
        skillsRoot,
        skillsEntries,
        {
          write,
          drifts,
          checkoutRoot: targetRoot,
          toolingRoot,
        },
      );
    }

    if (workspaceSkillsRoot !== null) {
      await syncExactTree(
        [skillRoot, workspaceSkillRoot],
        combinedSkills.files,
        combinedSkills.contents,
        workspaceSkillsRoot,
        workspaceSkillsEntries,
        {
          write,
          drifts,
          checkoutRoot: targetRoot,
          toolingRoot,
        },
      );
    }

    if (agentsRoot !== null) {
      await syncExactTree(
        [workspaceAgentRoot],
        workspaceAgentFiles,
        workspaceAgentContentsByPath,
        agentsRoot,
        agentsEntries,
        {
          write,
          drifts,
          checkoutRoot: targetRoot,
          toolingRoot,
        },
      );
    }
  }

  return [...new Set(drifts)].map((path) => relative(workspaceRoot, path) || ".");
}

async function main(argv) {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    throw new WorkspaceSyncError({
      code: "INVALID_MODE",
      stage: "cli_mode",
      path: "sync-workspace",
      message: "Укажи ровно один режим: --check или --write",
      details: { check, write },
    });
  }
  const drifts = await syncWorkspace({ write });
  if (!drifts.length) {
    process.stdout.write("Workspace-инструкции, skills и agents синхронизированы.\n");
    return 0;
  }
  if (write) {
    process.stdout.write(`Обновлено файлов: ${drifts.length}.\n`);
    return 0;
  }
  process.stderr.write(`Найдены несинхронизированные файлы:\n${drifts.map((path) => `- ${path}`).join("\n")}\n`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
