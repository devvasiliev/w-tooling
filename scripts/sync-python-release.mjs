#!/usr/bin/env node

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const TOOLING_ROOT = resolve(SCRIPT_ROOT, "..");
const DEFAULT_MANIFEST = join(TOOLING_ROOT, "config", "python-service-conformance.json");

function render(value, service) {
  return value
    .replaceAll("__SERVICE_NAME__", service.service)
    .replaceAll("__SERVICE_PACKAGE__", service.package)
    .replaceAll("__SERVICE_ENV_PREFIX__", service.environmentPrefix)
    .replaceAll("__SERVICE_PORT__", String(service.port));
}

function parseMode(value) {
  if (!/^[0-7]{4}$/u.test(value)) throw new Error(`Неверный file mode: ${value}`);
  return Number.parseInt(value, 8);
}

export async function syncPythonRelease({
  workspaceRoot = resolve(TOOLING_ROOT, ".."),
  toolingRoot = TOOLING_ROOT,
  manifestPath = DEFAULT_MANIFEST,
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const changed = [];
  for (const service of manifest.services) {
    for (const file of manifest.canonicalReleaseFiles) {
      const source = join(toolingRoot, "templates", "python-service", file.template);
      const destination = join(workspaceRoot, service.repository, file.destination);
      const expected = render(await readFile(source, "utf8"), service);
      let actual = null;
      try {
        actual = await readFile(destination, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await mkdir(dirname(destination), { recursive: true });
      const contentChanged = actual !== expected;
      if (contentChanged) {
        await writeFile(destination, expected, "utf8");
      }
      const expectedMode = parseMode(file.mode);
      const actualMode = (await stat(destination)).mode & 0o777;
      if (contentChanged || actualMode !== expectedMode) {
        changed.push(`${service.repository}/${file.destination}`);
      }
      await chmod(destination, expectedMode);
    }
  }
  return changed;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    const changed = await syncPythonRelease();
    process.stdout.write(
      changed.length
        ? `Синхронизированы release-файлы: ${changed.join(", ")}\n`
        : "Release-файлы уже синхронизированы.\n",
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
