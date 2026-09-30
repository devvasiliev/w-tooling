#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  checkPythonServiceConformance,
  loadConformanceManifest,
} from "./check-python-service-conformance.mjs";

const currentFile = fileURLToPath(import.meta.url);
const toolingRoot = resolve(dirname(currentFile), "..");
const defaultManifestPath = join(
  toolingRoot,
  "config",
  "python-service-conformance.json",
);
const USAGE = `Добавление capability в существующий Python-сервис

  npm run create-python-capability -- \\
    --target ../task-example \\
    --package project_example \\
    --capability publishing \\
    --bounded-context Example \\
    --requirement "Notion: master specification" \\
    [--http] [--persistence] [--dry-run] [--verify]
`;
const booleanOptions = new Set([
  "dry-run",
  "http",
  "persistence",
  "verify",
]);
const valueOptions = new Set([
  "bounded-context",
  "capability",
  "conformance-manifest",
  "package",
  "requirement",
  "target",
]);

function parseArgs(argv) {
  const values = new Map();
  const enabled = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) {
      throw new Error(`Неизвестный аргумент: ${argument || "<пусто>"}`);
    }
    const name = argument.slice(2);
    if (booleanOptions.has(name)) {
      enabled.add(name);
      continue;
    }
    if (!valueOptions.has(name)) throw new Error(`Неизвестный параметр: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Для --${name} нужно значение`);
    }
    if (values.has(name)) throw new Error(`Параметр --${name} указан дважды`);
    values.set(name, value);
    index += 1;
  }

  const options = {
    target: values.get("target"),
    packageName: values.get("package"),
    capability: values.get("capability"),
    boundedContext: values.get("bounded-context"),
    requirement: values.get("requirement"),
    conformanceManifest: values.get("conformance-manifest"),
    dryRun: enabled.has("dry-run"),
    withHttp: enabled.has("http"),
    withPersistence: enabled.has("persistence"),
    verify: enabled.has("verify"),
  };
  for (const [name, value] of [
    ["target", options.target],
    ["package", options.packageName],
    ["capability", options.capability],
    ["bounded-context", options.boundedContext],
    ["requirement", options.requirement],
  ]) {
    if (!value) throw new Error(`Обязателен --${name}`);
  }
  return options;
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

function validateSingleLine(name, value) {
  if (!value.trim() || /[\r\n]/u.test(value)) {
    throw new Error(`${name} должен быть одной непустой строкой`);
  }
}

function validateNames({ packageName, capability, boundedContext, requirement }) {
  if (!/^[a-z][a-z0-9_]*$/u.test(packageName)) {
    throw new Error("package должен быть допустимым именем Python в snake_case");
  }
  if (!/^[a-z][a-z0-9_]*$/u.test(capability)) {
    throw new Error("capability должна быть в snake_case без префикса сервиса");
  }
  validateSingleLine("bounded-context", boundedContext);
  validateSingleLine("requirement", requirement);
}

function capabilityDocument({ capability, boundedContext, requirement }) {
  return `# ${capability}\n\n` +
    `- Bounded context: ${boundedContext}\n` +
    `- Business requirement / master specification: ${requirement}\n\n` +
    "До реализации поведения заполни оставшуюся трассировку. Генератор не " +
    "создаёт use case или invariant без предметного решения.\n\n" +
    "## Use cases\n\n- Не определены.\n\n" +
    "## Invariants\n\n- Не определены.\n\n" +
    "## Contracts\n\n- Не определены.\n\n" +
    "## Persistence\n\n- Не определено.\n\n" +
    "## Acceptance tests\n\n- Не определены.\n";
}

function plannedFiles(options) {
  const { packageName, capability } = options;
  const files = new Map([
    [
      join("docs", "capabilities", `${capability}.md`),
      capabilityDocument(options),
    ],
    [
      join("src", packageName, "domain", capability, "__init__.py"),
      `\"\"\"Domain boundary for ${capability}.\"\"\"\n`,
    ],
    [
      join("src", packageName, "application", capability, "__init__.py"),
      `\"\"\"Application boundary for ${capability}.\"\"\"\n`,
    ],
    [
      join("tests", "unit", capability, "__init__.py"),
      `\"\"\"Unit tests for ${capability}.\"\"\"\n`,
    ],
  ]);
  if (options.withHttp) {
    files.set(
      join(
        "src",
        packageName,
        "adapters",
        "inbound",
        "http",
        `${capability}.py`,
      ),
      `\"\"\"HTTP adapter for ${capability}.\"\"\"\n`,
    );
  }
  if (options.withPersistence) {
    files.set(
      join(
        "src",
        packageName,
        "adapters",
        "outbound",
        "persistence",
        `${capability}.py`,
      ),
      `\"\"\"Persistence adapter for ${capability}.\"\"\"\n`,
    );
  }
  return files;
}

function withCapabilityRegistration(profile, repository, options) {
  const service = profile.services?.find(
    (candidate) =>
      candidate.repository === repository &&
      candidate.package === options.packageName,
  );
  if (!service) return { profile, registered: false, changed: false };

  const directories = [
    `application/${options.capability}`,
    `domain/${options.capability}`,
  ];
  const currentDirectories = service.capabilityDirectories ?? [];
  const nextDirectories = [...new Set([...currentDirectories, ...directories])].sort();
  const currentHttp = service.httpModules ?? [];
  const nextHttp = options.withHttp
    ? [...new Set([...currentHttp, `${options.capability}.py`])].sort()
    : currentHttp;
  const changed =
    JSON.stringify(currentDirectories) !== JSON.stringify(nextDirectories) ||
    JSON.stringify(currentHttp) !== JSON.stringify(nextHttp);
  service.capabilityDirectories = nextDirectories;
  service.httpModules = nextHttp;
  return { profile, registered: true, changed };
}

async function prepareRegistration(manifestPath, target, options) {
  if (!manifestPath || !(await exists(manifestPath))) {
    return { registered: false, changed: false, profile: null };
  }
  const profile = await loadConformanceManifest(manifestPath);
  return withCapabilityRegistration(profile, basename(target), options);
}

async function writeManifestAtomically(path, profile) {
  const mode = (await stat(path)).mode & 0o777;
  const temporary = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}`,
  );
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
    encoding: "utf8",
    mode,
  });
  await rename(temporary, path);
}

export async function verifyPythonCapability({
  target,
  packageName,
  conformanceManifest = defaultManifestPath,
  profile = null,
}) {
  const architecture = spawnSync(
    process.env.PYTHON || "python3",
    ["scripts/check_architecture.py", "--package", packageName],
    { cwd: target, encoding: "utf8" },
  );
  if (architecture.status !== 0) {
    throw new Error(
      `Architecture check не пройден:\n${architecture.stderr || architecture.stdout}`,
    );
  }
  if (!profile) return;
  const errors = await checkPythonServiceConformance({
    workspaceRoot: dirname(target),
    toolingRoot,
    manifest: profile,
  });
  if (errors.length) {
    throw new Error(`Conformance check не пройден:\n${errors.join("\n")}`);
  }
  if (conformanceManifest && !(await exists(conformanceManifest))) {
    throw new Error(`Conformance manifest не найден: ${conformanceManifest}`);
  }
}

export async function scaffoldPythonCapability({
  target,
  packageName,
  capability,
  boundedContext,
  requirement,
  withHttp = false,
  withPersistence = false,
  dryRun = false,
  verify = false,
  conformanceManifest = defaultManifestPath,
  allowMissingService = false,
}) {
  const resolvedTarget = resolve(target);
  const options = {
    packageName,
    capability,
    boundedContext,
    requirement,
    withHttp,
    withPersistence,
  };
  validateNames(options);

  if (!allowMissingService) {
    for (const required of [
      join(resolvedTarget, "pyproject.toml"),
      join(resolvedTarget, "src", packageName),
    ]) {
      if (!(await exists(required))) {
        throw new Error(`Target не является сервисом ${packageName}: отсутствует ${required}`);
      }
    }
  }

  const files = plannedFiles(options);
  const relativePaths = [...files.keys()].sort();
  const existing = [];
  if (await exists(resolvedTarget)) {
    for (const path of relativePaths) {
      if (await exists(join(resolvedTarget, path))) existing.push(path);
    }
  }
  const missing = relativePaths.filter((path) => !existing.includes(path));

  const registration = await prepareRegistration(
    conformanceManifest,
    resolvedTarget,
    options,
  );
  if (!dryRun) {
    for (const path of missing) {
      const destination = join(resolvedTarget, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, files.get(path), "utf8");
      await chmod(destination, 0o644);
    }
  }
  if (
    !dryRun &&
    registration.registered &&
    registration.changed &&
    conformanceManifest
  ) {
    await writeManifestAtomically(conformanceManifest, registration.profile);
  }
  if (!dryRun && verify) {
    await verifyPythonCapability({
      target: resolvedTarget,
      packageName,
      conformanceManifest,
      profile: registration.registered ? registration.profile : null,
    });
  }

  return {
    files: relativePaths,
    written: dryRun ? [] : missing,
    existing,
    manifestRegistered: registration.registered,
    manifestChanged: registration.changed,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(USAGE);
  } else try {
    const options = parseArgs(process.argv.slice(2));
    const result = await scaffoldPythonCapability({
      target: options.target,
      packageName: options.packageName,
      capability: options.capability,
      boundedContext: options.boundedContext,
      requirement: options.requirement,
      withHttp: options.withHttp,
      withPersistence: options.withPersistence,
      dryRun: options.dryRun,
      verify: options.verify,
      conformanceManifest:
        options.conformanceManifest || defaultManifestPath,
    });
    if (options.dryRun) {
      process.stdout.write(
        `Dry-run: ${result.files.length - result.existing.length} файлов к созданию.\n`,
      );
    } else if (result.written.length === 0) {
      process.stdout.write("Capability уже существует; файлы не изменены.\n");
    } else {
      process.stdout.write(`Создана capability: ${result.written.length} файлов.\n`);
    }
    if (result.manifestRegistered) {
      process.stdout.write(
        result.manifestChanged
          ? `${options.dryRun ? "Будет обновлён" : "Обновлён"} conformance manifest.\n`
          : "Conformance manifest уже актуален.\n",
      );
    }
    if (options.verify && !options.dryRun) {
      process.stdout.write(
        result.manifestRegistered
          ? "Architecture и conformance checks: OK\n"
          : "Architecture check: OK; сервис ещё не зарегистрирован в cross-service manifest.\n",
      );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
