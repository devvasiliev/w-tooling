#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fail } from "./errors.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const DEFAULT_RUNTIME = resolve(ROOT, ".project/business-value-runtime");
const MANIFEST_NAME = ".business-value-manifest.json";
const BUILD_MANIFEST_PATH = ".project/business-value-build-manifest.json";
const COPY_PATHS = [
  "templates/n8n/business-value/README.md",
  "templates/n8n/business-value/compose.yaml",
  "templates/n8n/business-value/workflow.json",
];
const SOURCE_ROOTS = [
  "config",
  "scripts/business-value",
  "templates/n8n/business-value",
];
const SOURCE_FILES = [
  "package.json",
  "package-lock.json",
  "scripts/business-value.mjs",
  "scripts/notion-workflow-lib.mjs",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const manifestDigest = (files) =>
  sha256(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)))));

const collectFiles = async (root, path) => {
  const absolute = resolve(root, path);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, relative(root, child))));
    else if (entry.isFile()) files.push(relative(root, child));
  }
  return files;
};

const selectedSourcePaths = async (root) => {
  const discovered = (
    await Promise.all(SOURCE_ROOTS.map((path) => collectFiles(root, path)))
  ).flat();
  return [...new Set([...SOURCE_FILES, ...discovered])]
    .filter((path) => {
      if (path.startsWith("config/")) {
        return /business-value|config\/prompts\/business-value/u.test(path);
      }
      return true;
    })
    .sort();
};

const hashPaths = async (root, paths) =>
  Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))]),
    ),
  );

const installedName = (sourcePath) => sourcePath.split("/").at(-1);

export async function buildRuntimeManifest({ repositoryRoot = ROOT } = {}) {
  const sourceFiles = await hashPaths(
    repositoryRoot,
    await selectedSourcePaths(repositoryRoot),
  );
  const installedFiles = Object.fromEntries(
    COPY_PATHS.map((path) => [installedName(path), sourceFiles[path]]),
  );
  return {
    schemaVersion: 1,
    sourceDigest: manifestDigest(sourceFiles),
    installedDigest: manifestDigest(installedFiles),
    sourceFiles,
    installedFiles,
  };
}

const atomicCopy = async (source, target) => {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await copyFile(source, temporary);
  await rename(temporary, target);
};

const atomicJson = async (target, value) => {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
};

export async function deployRuntime({
  repositoryRoot = ROOT,
  runtimeDirectory = DEFAULT_RUNTIME,
} = {}) {
  const runtime = resolve(runtimeDirectory);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  for (const sourcePath of COPY_PATHS) {
    await atomicCopy(
      resolve(repositoryRoot, sourcePath),
      resolve(runtime, installedName(sourcePath)),
    );
  }
  const manifest = await buildRuntimeManifest({ repositoryRoot });
  await mkdir(dirname(resolve(repositoryRoot, BUILD_MANIFEST_PATH)), {
    recursive: true,
    mode: 0o700,
  });
  await atomicJson(resolve(repositoryRoot, BUILD_MANIFEST_PATH), {
    schemaVersion: 1,
    sourceDigest: manifest.sourceDigest,
    installedDigest: manifest.installedDigest,
  });
  await atomicJson(resolve(runtime, MANIFEST_NAME), manifest);
  return { runtimeDirectory: runtime, ...manifest };
}

export async function checkRuntimeManifest({
  repositoryRoot = ROOT,
  runtimeDirectory = DEFAULT_RUNTIME,
} = {}) {
  const runtime = resolve(runtimeDirectory);
  let stored;
  try {
    stored = JSON.parse(await readFile(resolve(runtime, MANIFEST_NAME), "utf8"));
  } catch {
    fail("RUNTIME_MANIFEST_DRIFT", "Runtime manifest отсутствует или повреждён");
  }
  const current = await buildRuntimeManifest({ repositoryRoot });
  const installedFiles = await hashPaths(runtime, Object.keys(current.installedFiles));
  const installedDigest = manifestDigest(installedFiles);
  if (
    stored.sourceDigest !== current.sourceDigest ||
    stored.installedDigest !== current.installedDigest ||
    installedDigest !== current.installedDigest
  ) {
    fail("RUNTIME_MANIFEST_DRIFT", "Installed Workflow расходится с canonical source", {
      sourceMatches: stored.sourceDigest === current.sourceDigest,
      installedMatches: installedDigest === current.installedDigest,
    });
  }
  return {
    ok: true,
    reasonCode: "RUNTIME_MANIFEST_CURRENT",
    runtimeDirectory: runtime,
    sourceDigest: current.sourceDigest,
    installedDigest,
  };
}

const cli = async () => {
  const [command = "", directory = DEFAULT_RUNTIME] = process.argv.slice(2);
  const result = command === "deploy"
    ? await deployRuntime({ runtimeDirectory: directory })
    : command === "check"
      ? await checkRuntimeManifest({ runtimeDirectory: directory })
      : fail("RUNTIME_COMMAND_INVALID", "Команды: deploy, check");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  cli().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      reasonCode: error.code || "RUNTIME_COMMAND_FAILED",
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}

export { BUILD_MANIFEST_PATH, DEFAULT_RUNTIME, MANIFEST_NAME };
