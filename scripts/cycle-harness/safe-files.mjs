import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  canonicalJson,
  CycleHarnessError,
  escapesRoot,
  pathForDisplay,
  prettyJson,
  REGULAR_MODE,
  SCHEMA_VERSION,
  sha256,
  validateIntegrityRecord,
} from "./core.mjs";

/** Возвращает metadata обычного пути или null при ENOENT, не следуя логике fallback. */
export function optionalLstat(path) {
  return lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

/**
 * Единственный владелец безопасного I/O досье: запрещает symlink/special paths,
 * пишет mutable-файлы атомарно и append-only records через O_EXCL.
 */
export async function validateDirectory(path, stage, label) {
  const metadata = await optionalLstat(path);
  if (metadata === null) {
    throw new CycleHarnessError({
      code: "MISSING_PATH",
      stage,
      path,
      message: `${label} отсутствует: ${path}`,
      expected: "directory",
      actual: "missing",
      next: `Восстанови ${label} и повтори команду.`,
    });
  }
  if (metadata.isSymbolicLink()) {
    throw new CycleHarnessError({
      code: "SYMLINK_PATH",
      stage,
      path,
      message: `${label} не может быть symbolic link: ${path}`,
      expected: "обычный directory",
      actual: "symbolic link",
      next: "Замени ссылку обычным каталогом внутри workspace.",
    });
  }
  if (!metadata.isDirectory()) {
    throw new CycleHarnessError({
      code: "UNEXPECTED_PATH_TYPE",
      stage,
      path,
      message: `${label} не является directory: ${path}`,
      expected: "directory",
      actual: "другой тип",
      next: `Освободи путь ${path} для каталога.`,
    });
  }
}

export async function validateExistingPathChain(root, target, { stage, finalType, label }) {
  if (target === root || escapesRoot(root, target)) {
    throw new CycleHarnessError({
      code: "PATH_OUTSIDE_ROOT",
      stage,
      path: target,
      message: `${label} выходит за пределы repository root: ${target}`,
      expected: root,
      actual: target,
      next: "Используй managed path внутри repository root.",
    });
  }
  let current = root;
  const parts = relative(root, target).split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const metadata = await optionalLstat(current);
    if (metadata === null) {
      throw new CycleHarnessError({
        code: "MISSING_PATH",
        stage,
        path: current,
        message: `${label} отсутствует: ${current}`,
        expected: index === parts.length - 1 ? finalType : "directory",
        actual: "missing",
        next: `Восстанови ${label} и повтори команду.`,
      });
    }
    if (metadata.isSymbolicLink()) {
      throw new CycleHarnessError({
        code: "SYMLINK_PATH",
        stage,
        path: current,
        message: `${label} содержит symbolic link: ${current}`,
        expected: index === parts.length - 1 ? finalType : "directory",
        actual: "symbolic link",
        next: "Замени ссылку обычным managed path внутри репозитория.",
      });
    }
    const expectedType = index === parts.length - 1 ? finalType : "directory";
    const typeMatches = expectedType === "file" ? metadata.isFile() : metadata.isDirectory();
    if (!typeMatches) {
      throw new CycleHarnessError({
        code: "UNEXPECTED_PATH_TYPE",
        stage,
        path: current,
        message: `${label} содержит путь неподдерживаемого типа: ${current}`,
        expected: expectedType,
        actual: "другой тип",
        next: "Освободи managed path и восстанови ожидаемый тип.",
      });
    }
  }
}

export async function optionalSafeFile(root, target, { stage, label }) {
  if (target === root || escapesRoot(root, target)) {
    throw new CycleHarnessError({
      code: "PATH_OUTSIDE_ROOT",
      stage,
      path: target,
      message: `${label} выходит за пределы repository root: ${target}`,
      expected: root,
      actual: target,
      next: "Используй path внутри repository root.",
    });
  }
  let current = root;
  const parts = relative(root, target).split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const metadata = await optionalLstat(current);
    if (metadata === null) return null;
    if (metadata.isSymbolicLink()) {
      throw new CycleHarnessError({
        code: "SYMLINK_PATH",
        stage,
        path: current,
        message: `${label} содержит symbolic link: ${current}`,
        expected: index === parts.length - 1 ? "file или missing" : "directory",
        actual: "symbolic link",
        next: "Замени ссылку обычным path внутри репозитория.",
      });
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new CycleHarnessError({
        code: "UNEXPECTED_PATH_TYPE",
        stage,
        path: current,
        message: `${label} содержит не-directory parent: ${current}`,
        expected: "directory",
        actual: "другой тип",
        next: "Освободи target path.",
      });
    }
    if (index === parts.length - 1) {
      if (!metadata.isFile()) {
        throw new CycleHarnessError({
          code: "UNEXPECTED_PATH_TYPE",
          stage,
          path: current,
          message: `${label} должен быть обычным file или missing: ${current}`,
          expected: "file или missing",
          actual: "другой тип",
          next: "Освободи target path.",
        });
      }
      return metadata;
    }
  }
  return null;
}

export async function ensureDirectoryChain(root, target) {
  if (target === root || escapesRoot(root, target)) {
    throw new CycleHarnessError({
      code: "PATH_OUTSIDE_ROOT",
      stage: "path_validation",
      path: target,
      message: `Managed path выходит за пределы репозитория: ${target}`,
      expected: root,
      actual: target,
      next: "Используй путь внутри репозитория задачи.",
    });
  }
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = join(current, part);
    let metadata = await optionalLstat(current);
    if (metadata === null) {
      await mkdir(current);
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink()) {
      throw new CycleHarnessError({
        code: "SYMLINK_PATH",
        stage: "path_validation",
        path: current,
        message: `Managed path содержит symbolic link: ${current}`,
        expected: "обычный directory",
        actual: "symbolic link",
        next: "Удали ссылку и создай обычный каталог внутри репозитория.",
      });
    }
    if (!metadata.isDirectory()) {
      throw new CycleHarnessError({
        code: "UNEXPECTED_PATH_TYPE",
        stage: "path_validation",
        path: current,
        message: `Managed path содержит не-directory компонент: ${current}`,
        expected: "directory",
        actual: "другой тип",
        next: "Освободи managed path и повтори команду.",
      });
    }
  }
}

export async function assertSafeTree(root, prefix = "") {
  const directory = join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(prefix, entry.name);
    const absolute = join(root, child);
    if (entry.isDirectory()) {
      await assertSafeTree(root, child);
    } else if (!entry.isFile()) {
      throw new CycleHarnessError({
        code: "UNSAFE_ENTRY",
        stage: "dossier_validation",
        path: absolute,
        message: `Досье содержит symbolic link или special entry: ${absolute}`,
        expected: "обычный file или directory",
        actual: "unsafe entry",
        next: "Удали небезопасную запись и восстанови досье из проверенного checkpoint.",
      });
    }
  }
}

export async function atomicWrite(path, content) {
  const destination = await optionalLstat(path);
  if (destination?.isSymbolicLink() || (destination !== null && !destination.isFile())) {
    throw new CycleHarnessError({
      code: destination?.isSymbolicLink() ? "SYMLINK_PATH" : "UNEXPECTED_PATH_TYPE",
      stage: "atomic_write",
      path,
      message: `Нельзя атомарно обновить небезопасный путь: ${path}`,
      expected: "обычный file или missing",
      actual: destination?.isSymbolicLink() ? "symbolic link" : "другой тип",
      next: "Освободи путь и восстанови досье из последнего checkpoint.",
    });
  }
  const temporary = join(dirname(path), `.cycle-tmp-${process.pid}-${randomUUID()}`);
  const handle = await open(temporary, "wx", REGULAR_MODE);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, REGULAR_MODE);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function immutableWrite(path, content, code = "IMMUTABLE_RECORD") {
  let handle;
  try {
    handle = await open(path, "wx", REGULAR_MODE);
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CycleHarnessError({
        code,
        stage: "immutable_write",
        path,
        message: `Неизменяемая запись уже существует: ${path}`,
        expected: "новый уникальный record",
        actual: "record уже существует",
        next: "Используй существующую запись или создай нового кандидата/запуск с новой identity.",
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function integrityExcluded(relativePath) {
  const name = relativePath.split(/[\\/]/u).at(-1);
  return relativePath === "integrity.json" || name === ".cycle.lock" || name.startsWith(".cycle-tmp-");
}

export async function integrityEntries(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const snapshots = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(prefix, entry.name);
    const portablePath = pathForDisplay(child);
    if (integrityExcluded(portablePath)) continue;
    const absolute = join(root, child);
    if (entry.isDirectory()) {
      snapshots.push(...(await integrityEntries(root, child)));
    } else if (entry.isFile()) {
      const [content, metadata] = await Promise.all([readFile(absolute), lstat(absolute)]);
      snapshots.push({
        path: portablePath,
        sha256: sha256(content),
        executable: (metadata.mode & 0o111) !== 0,
      });
    } else {
      throw new CycleHarnessError({
        code: "UNSAFE_ENTRY",
        stage: "integrity_snapshot",
        path: absolute,
        message: `Нельзя хешировать symbolic link или special entry: ${absolute}`,
        expected: "обычный file или directory",
        actual: "unsafe entry",
        next: "Удалить небезопасную запись и восстановить досье.",
      });
    }
  }
  return snapshots;
}

export async function calculateIntegrity(root) {
  const files = await integrityEntries(root);
  return {
    schema_version: SCHEMA_VERSION,
    algorithm: "sha256",
    digest: sha256(canonicalJson(files)),
    files,
  };
}

export async function refreshIntegrity(root) {
  const integrity = await calculateIntegrity(root);
  await atomicWrite(join(root, "integrity.json"), prettyJson(integrity));
  return integrity;
}

export async function verifyIntegrity(root) {
  const path = join(root, "integrity.json");
  const metadata = await optionalLstat(path);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CycleHarnessError({
      code: "MISSING_INTEGRITY",
      stage: "integrity_check",
      path,
      message: `Манифест целостности отсутствует или небезопасен: ${path}`,
      expected: "обычный integrity.json",
      actual: metadata === null ? "missing" : "неподдерживаемый тип",
      next: "Восстанови досье из проверенного checkpoint или создай его заново.",
    });
  }
  const expected = validateIntegrityRecord(await readJson(path, "integrity_load"), path);
  const actual = await calculateIntegrity(root);
  if (expected.digest !== actual.digest) {
    const expectedByPath = new Map((expected.files ?? []).map((item) => [item.path, item.sha256]));
    const actualByPath = new Map(actual.files.map((item) => [item.path, item.sha256]));
    const changedPaths = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])]
      .filter((item) => expectedByPath.get(item) !== actualByPath.get(item))
      .sort();
    throw new CycleHarnessError({
      code: "DOSSIER_INTEGRITY_MISMATCH",
      stage: "integrity_check",
      path: root,
      message: `Целостность досье нарушена: ${root}`,
      expected: expected.digest ?? "валидный digest",
      actual: actual.digest,
      next: "Проверь перечисленные файлы и восстанови их из доверенного checkpoint.",
      details: { changedPaths },
    });
  }
  return actual;
}

export async function readJson(path, stage) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CycleHarnessError({
        code: "INVALID_JSON",
        stage,
        path,
        message: `Некорректный JSON: ${path}`,
        expected: "валидный JSON",
        actual: error.message,
        next: "Исправь JSON или восстанови файл из checkpoint.",
      });
    }
    throw error;
  }
}
