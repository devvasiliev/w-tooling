#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkPythonServiceConformance, loadConformanceManifest } from "./check-python-service-conformance.mjs";
import { scaffoldPythonCapability } from "./scaffold-python-capability.mjs";

const currentFile = fileURLToPath(import.meta.url);
const toolingRoot = resolve(dirname(currentFile), "..");
const defaultTemplateRoot = join(toolingRoot, "templates", "python-service");
const ALLOWED_EXISTING = new Set([".git", ".idea", ".codex", "AGENTS.md"]);
const USAGE = `Создание независимого Python-сервиса

  npm run create-python-service -- \\
    --target ../task-example \\
    --service-name task-example \\
    --package project_example \\
    --port 8080 \\
    --bounded-context Example \\
    --requirement "Notion: master specification" \\
    --capability example [--capability second] [--dry-run] [--verify]
`;

const booleanOptions = new Set(["dry-run", "verify"]);
const repeatableOptions = new Set(["capability"]);
const valueOptions = new Set([
  "bounded-context",
  "capability",
  "package",
  "port",
  "requirement",
  "service-name",
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
    if (repeatableOptions.has(name)) {
      values.set(name, [...(values.get(name) ?? []), value]);
    } else {
      if (values.has(name)) throw new Error(`Параметр --${name} указан дважды`);
      values.set(name, value);
    }
    index += 1;
  }
  const target = values.get("target");
  const serviceName = values.get("service-name");
  const packageName = values.get("package");
  const port = values.get("port");
  const boundedContext = values.get("bounded-context");
  const requirement = values.get("requirement");
  const capabilities = values.get("capability") ?? [];
  if (
    !target ||
    !serviceName ||
    !packageName ||
    !port ||
    !boundedContext ||
    !requirement ||
    capabilities.length === 0
  ) {
    throw new Error(
      "Обязательны --target, --service-name, --package, --port, " +
      "--bounded-context, --requirement и хотя бы один --capability",
    );
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(serviceName)) {
    throw new Error("service-name должен быть в kebab-case");
  }
  if (!/^[a-z][a-z0-9_]*$/u.test(packageName)) {
    throw new Error("package должен быть допустимым именем Python в snake_case");
  }
  if (!/^[0-9]{2,5}$/u.test(port) || Number(port) > 65535) {
    throw new Error("port должен быть допустимым TCP-портом");
  }
  for (const capability of capabilities) {
    if (!/^[a-z][a-z0-9_]*$/u.test(capability)) {
      throw new Error("capability должна быть в snake_case без префикса сервиса");
    }
  }
  for (const [name, value] of [
    ["bounded-context", boundedContext],
    ["requirement", requirement],
  ]) {
    if (!value.trim() || /[\r\n]/u.test(value)) {
      throw new Error(`${name} должен быть одной непустой строкой`);
    }
  }
  return {
    target: resolve(target),
    serviceName,
    packageName,
    port,
    boundedContext,
    requirement,
    capabilities: [...new Set(capabilities)].sort(),
    dryRun: enabled.has("dry-run"),
    verify: enabled.has("verify"),
  };
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

async function listTemplateFiles(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listTemplateFiles(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

function render(
  value,
  {
    serviceName,
    packageName,
    environmentPrefix,
    port,
    boundedContext,
    requirement,
  },
) {
  return value
    .replaceAll("__SERVICE_NAME__", serviceName)
    .replaceAll("__SERVICE_PACKAGE__", packageName)
    .replaceAll("__SERVICE_ENV_PREFIX__", environmentPrefix)
    .replaceAll("__SERVICE_PORT__", port)
    .replaceAll("__BOUNDED_CONTEXT__", boundedContext)
    .replaceAll("__BUSINESS_REQUIREMENT__", requirement);
}

function destinationPath(target, templatePath, values) {
  const rendered = render(templatePath, values).replace(/\.tpl$/u, "");
  const destination = resolve(target, rendered);
  const targetPrefix = `${target}/`;
  if (destination !== target && !destination.startsWith(targetPrefix)) {
    throw new Error(`Template path выходит за target: ${templatePath}`);
  }
  return destination;
}

export async function scaffoldPythonService({
  target,
  serviceName,
  packageName,
  port,
  boundedContext = serviceName,
  requirement = "Не задано. Production-поведение заблокировано до трассировки.",
  capabilities = [],
  dryRun = false,
  verify = false,
  templateRoot = defaultTemplateRoot,
}) {
  const resolvedTarget = resolve(target);
  if (!boundedContext.trim() || /[\r\n]/u.test(boundedContext)) {
    throw new Error("boundedContext должен быть одной непустой строкой");
  }
  if (!requirement.trim() || /[\r\n]/u.test(requirement)) {
    throw new Error("requirement должен быть одной непустой строкой");
  }
  const normalizedCapabilities = [...new Set(capabilities)].sort();
  for (const capability of normalizedCapabilities) {
    if (!/^[a-z][a-z0-9_]*$/u.test(capability)) {
      throw new Error("capability должна быть в snake_case без префикса сервиса");
    }
  }
  const existing = (await exists(resolvedTarget)) ? await readdir(resolvedTarget) : [];
  const unknown = existing.filter((name) => !ALLOWED_EXISTING.has(name));
  if (unknown.length) {
    throw new Error(`Target содержит service-файлы: ${unknown.sort().join(", ")}`);
  }

  const values = {
    serviceName,
    packageName,
    environmentPrefix: `${packageName.toUpperCase()}_`,
    port: String(port),
    boundedContext,
    requirement,
  };
  const files = await listTemplateFiles(templateRoot);
  const destinations = files.map((file) =>
    destinationPath(resolvedTarget, file, values),
  );
  for (const destination of destinations) {
    if (await exists(destination)) {
      throw new Error(`Файл уже существует: ${relative(resolvedTarget, destination)}`);
    }
  }

  if (!dryRun) {
    await mkdir(resolvedTarget, { recursive: true });
    for (let index = 0; index < files.length; index += 1) {
      const source = join(templateRoot, files[index]);
      const destination = destinations[index];
      const content = render(await readFile(source, "utf8"), values);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
      await chmod(destination, (await stat(source)).mode & 0o777);
    }
  }

  const capabilityFiles = [];
  for (const capability of normalizedCapabilities) {
    const result = await scaffoldPythonCapability({
      target: resolvedTarget,
      packageName,
      capability,
      boundedContext,
      requirement,
      dryRun,
      conformanceManifest: "",
      allowMissingService: dryRun,
    });
    capabilityFiles.push(...result.files);
  }
  const written = [
    ...destinations.map((path) => relative(resolvedTarget, path)),
    ...capabilityFiles,
  ].sort();
  if (!dryRun && verify) {
    await verifyGeneratedPythonService({
      target: resolvedTarget,
      serviceName,
      packageName,
      port,
      capabilities: normalizedCapabilities,
    });
  }
  return written;
}

export async function verifyGeneratedPythonService({
  target,
  serviceName,
  packageName,
  port,
  capabilities = [],
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
  const commonProfile = await loadConformanceManifest();
  const manifest = {
    schemaVersion: 1,
    canonicalReleaseFiles: [],
    canonicalDirectories: [
      "adapters",
      "adapters/inbound",
      "adapters/inbound/http",
      "adapters/outbound",
      "adapters/outbound/persistence",
      "application",
      "application/ports",
      "bootstrap",
      "domain",
    ],
    commonRuntimePins: commonProfile.commonRuntimePins,
    commonDevelopmentPins: commonProfile.commonDevelopmentPins,
    crossServiceContractCopies: [],
    services: [
      {
        repository: basename(target),
        service: serviceName,
        package: packageName,
        environmentPrefix: `${packageName.toUpperCase()}_`,
        port: Number(port),
        capabilityDirectories: [
          "application/contracts",
          "application/services",
          ...capabilities.flatMap((capability) => [
            `application/${capability}`,
            `domain/${capability}`,
          ]),
        ],
        httpModules: ["dto.py"],
        bootstrapModules: [],
        statefulServices: [],
        statefulRunServices: [],
        statefulModules: [],
        statefulEnvironment: [],
        dockerfileCapabilityCopies: [],
      },
    ],
  };
  const errors = await checkPythonServiceConformance({
    workspaceRoot: dirname(target),
    toolingRoot,
    manifest,
  });
  if (errors.length) {
    throw new Error(`Conformance check не пройден:\n${errors.join("\n")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(USAGE);
  } else try {
    const options = parseArgs(process.argv.slice(2));
    const written = await scaffoldPythonService({
      target: options.target,
      serviceName: options.serviceName,
      packageName: options.packageName,
      port: options.port,
      boundedContext: options.boundedContext,
      requirement: options.requirement,
      capabilities: options.capabilities,
      dryRun: options.dryRun,
      verify: options.verify,
    });
    process.stdout.write(
      options.dryRun
        ? `Dry-run: ${written.length} файлов к созданию.\n`
        : `Создан Python service scaffold: ${written.length} файлов.\n`,
    );
    if (options.verify && !options.dryRun) {
      process.stdout.write("Architecture и conformance checks: OK\n");
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
