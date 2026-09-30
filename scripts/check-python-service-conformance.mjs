#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const TOOLING_ROOT = resolve(SCRIPT_ROOT, "..");
const DEFAULT_MANIFEST = join(TOOLING_ROOT, "config", "python-service-conformance.json");

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}

function renderTemplate(value, service) {
  return normalizeNewlines(value)
    .replaceAll("__SERVICE_NAME__", service.service)
    .replaceAll("__SERVICE_PACKAGE__", service.package)
    .replaceAll("__SERVICE_ENV_PREFIX__", service.environmentPrefix)
    .replaceAll("__SERVICE_PORT__", String(service.port));
}

function normalizeServiceText(value, service) {
  return normalizeNewlines(value)
    .replaceAll(service.package, "__SERVICE_PACKAGE__")
    .replaceAll(service.service, "__SERVICE_NAME__")
    .replaceAll(service.environmentPrefix, "__SERVICE_ENV_PREFIX__")
    .replaceAll(String(service.port), "__SERVICE_PORT__");
}

function normalizeDockerfile(value, service) {
  const capabilityCopies = new Set(service.dockerfileCapabilityCopies ?? []);
  const lines = normalizeServiceText(value, service)
    .replace(/^ARG SERVICE_VERSION=.*$/mu, "ARG SERVICE_VERSION=__SERVICE_VERSION__")
    .split("\n")
    .filter((line) => !capabilityCopies.has(line));
  const releaseCopies = lines
    .filter((line) => /^COPY scripts\/release\/[^ ]+\.py /u.test(line))
    .sort();
  let releaseIndex = 0;
  return lines
    .map((line) => (
      /^COPY scripts\/release\/[^ ]+\.py /u.test(line)
        ? releaseCopies[releaseIndex++]
        : line
    ))
    .join("\n");
}

function parsePins(value) {
  const pins = new Map();
  for (const match of value.matchAll(/^[ \t]*["']?([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?==([^"'\s,\\]+)/gmu)) {
    pins.set(match[1].toLowerCase(), match[2]);
  }
  return pins;
}

function configLines(value) {
  return normalizeNewlines(value)
    .split("\n")
    .map((line) => line.split("#", 1)[0].trim())
    .filter(Boolean);
}

function environmentNames(value) {
  return configLines(value).map((line) => line.split("=", 1)[0].trim());
}

function requireExactList(actual, expected, path, description, errors) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(
      `${path}: ${description} must be ${expected.length ? expected.join(", ") : "empty"}`,
    );
  }
}

async function listDirectories(root) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "__pycache__") continue;
      const path = join(current, entry.name);
      found.push(relative(root, path));
      await visit(path);
    }
  }
  await visit(root);
  return found.sort();
}

async function listInitFiles(root) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile() && entry.name === "__init__.py") found.push(path);
    }
  }
  await visit(root);
  return found;
}

async function listImmediatePythonFiles(root) {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
    .map((entry) => entry.name)
    .sort();
}

function initBody(value) {
  return normalizeNewlines(value)
    .replace(/^\s*(?:"""[\s\S]*?"""|'''[\s\S]*?''')\s*/u, "")
    .replace(/^\s*from __future__ import annotations\s*/u, "")
    .replace(/^\s*#[^\n]*(?:\n|$)/gmu, "")
    .trim();
}

async function read(path, errors) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    errors.push(`${path}: missing canonical file (${error.code ?? error.message})`);
    return null;
  }
}

function requireFragment(source, fragment, path, errors) {
  if (!source.includes(fragment)) errors.push(`${path}: missing canonical fragment ${JSON.stringify(fragment)}`);
}

export function missingReleaseHookActions(source, requiredActions) {
  const normalized = normalizeNewlines(source);
  return requiredActions.filter((action) => {
    const escaped = action.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return !new RegExp(`^\\s*${escaped}\\)`, "mu").test(normalized);
  });
}

export async function loadConformanceManifest(path = DEFAULT_MANIFEST) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Выбирает точный bootstrap-шаблон; исключение требует известного профиля и причины. */
export function apiBootstrapTemplate(service, toolingRoot = TOOLING_ROOT) {
  const profile = service.apiBootstrapProfile;
  if (profile === undefined) {
    return join(toolingRoot, "templates/python-service/src/__SERVICE_PACKAGE__/bootstrap/api.py");
  }
  if (profile?.name !== "auth-client-ip" || typeof profile.reason !== "string" || !profile.reason.trim()) {
    throw Object.assign(new Error("Неизвестный или необоснованный bootstrap-профиль"), {
      code: "INVALID_BOOTSTRAP_PROFILE",
      repository: service.repository,
    });
  }
  return join(toolingRoot, "templates/python-http-profiles/auth-client-ip.py.tpl");
}

export async function checkPythonServiceConformance({
  workspaceRoot = resolve(TOOLING_ROOT, ".."),
  toolingRoot = TOOLING_ROOT,
  manifest = null,
} = {}) {
  const profile = manifest ?? await loadConformanceManifest(join(toolingRoot, "config", "python-service-conformance.json"));
  const errors = [];
  const templateRoot = join(toolingRoot, "templates", "python-service");
  const canonicalFiles = [
    ["Makefile.tpl", "Makefile"],
    ["compose.stateful.yaml", "compose.stateful.yaml"],
    ["scripts/check_architecture.py", "scripts/check_architecture.py"],
    ["scripts/check_dependency_locks.py", "scripts/check_dependency_locks.py"],
    ["scripts/compile_requirements.py", "scripts/compile_requirements.py"],
    ["scripts/run-stateful-suite.py", "scripts/run-stateful-suite.py"],
    ["scripts/run-stateful-tests.sh", "scripts/run-stateful-tests.sh"],
    ["scripts/run-tests.sh", "scripts/run-tests.sh"],
    ["src/__SERVICE_PACKAGE__/adapters/inbound/http/protocol.py", "src/__SERVICE_PACKAGE__/adapters/inbound/http/protocol.py"],
    ["src/__SERVICE_PACKAGE__/bootstrap/api.py", "src/__SERVICE_PACKAGE__/bootstrap/api.py"],
    ["src/__SERVICE_PACKAGE__/bootstrap/logging.py", "src/__SERVICE_PACKAGE__/bootstrap/logging.py"],
    ...profile.canonicalReleaseFiles.map((file) => [
      file.template,
      file.destination,
      file.mode,
    ]),
  ];
  const normalizedDockerfiles = [];

  for (const service of profile.services) {
    const repositoryRoot = join(workspaceRoot, service.repository);
    const packageRoot = join(repositoryRoot, "src", service.package);
    const allowedDirectories = new Set([
      ...profile.canonicalDirectories,
      ...service.capabilityDirectories,
    ]);
    let directories = [];
    try {
      directories = await listDirectories(packageRoot);
    } catch (error) {
      errors.push(`${packageRoot}: package tree is unavailable (${error.code ?? error.message})`);
    }
    for (const required of profile.canonicalDirectories) {
      if (!directories.includes(required)) errors.push(`${packageRoot}: required canonical directory is missing: ${required}`);
    }
    for (const directory of directories) {
      if (!allowedDirectories.has(directory)) {
        errors.push(`${packageRoot}: undeclared capability directory: ${directory}`);
      }
    }

    for (const directory of [".", "adapters", "adapters/inbound", "adapters/outbound", "application"]) {
      const path = directory === "." ? packageRoot : join(packageRoot, directory);
      const files = await listImmediatePythonFiles(path).catch(() => []);
      const unexpected = files.filter((file) => file !== "__init__.py");
      if (unexpected.length) {
        errors.push(`${path}: structural container must not contain implementation modules: ${unexpected.join(", ")}`);
      }
    }
    const bootstrapPath = join(packageRoot, "bootstrap");
    const bootstrapFiles = await listImmediatePythonFiles(bootstrapPath).catch(() => []);
    const expectedBootstrapFiles = [
      "__init__.py",
      "api.py",
      "container.py",
      "logging.py",
      "settings.py",
      "worker.py",
      ...(service.bootstrapModules ?? []),
    ].sort();
    if (JSON.stringify(bootstrapFiles) !== JSON.stringify(expectedBootstrapFiles)) {
      errors.push(`${bootstrapPath}: process/bootstrap modules must be ${expectedBootstrapFiles.join(", ")}`);
    }
    const httpPath = join(packageRoot, "adapters", "inbound", "http");
    const httpFiles = await listImmediatePythonFiles(httpPath).catch(() => []);
    const expectedHttpFiles = [
      "__init__.py",
      "app.py",
      "protocol.py",
      ...(service.httpModules ?? []),
    ].sort();
    if (JSON.stringify(httpFiles) !== JSON.stringify(expectedHttpFiles)) {
      errors.push(`${httpPath}: HTTP adapter modules must match the declared capability set: ${expectedHttpFiles.join(", ")}`);
    }

    for (const initPath of await listInitFiles(packageRoot).catch(() => [])) {
      if (initPath === join(packageRoot, "__init__.py")) continue;
      const source = await read(initPath, errors);
      if (source !== null && initBody(source)) {
        errors.push(`${initPath}: layer __init__.py must not re-export implementation symbols`);
      }
    }

    for (const [templatePath, repositoryPath, expectedMode] of canonicalFiles) {
      const sourcePath = repositoryPath === "src/__SERVICE_PACKAGE__/bootstrap/api.py"
        ? apiBootstrapTemplate(service, toolingRoot)
        : join(templateRoot, templatePath);
      const expectedSource = await read(sourcePath, errors);
      const actualPath = join(
        repositoryRoot,
        repositoryPath.replaceAll("__SERVICE_PACKAGE__", service.package),
      );
      const actualSource = await read(actualPath, errors);
      if (expectedSource !== null && actualSource !== null) {
        const expected = renderTemplate(expectedSource, service);
        if (normalizeNewlines(actualSource) !== expected) {
          errors.push(`${actualPath}: file drifts from the canonical tooling template`);
        }
        if (expectedMode) {
          const actualMode = (await stat(actualPath)).mode & 0o777;
          const canonicalMode = Number.parseInt(expectedMode, 8);
          if (actualMode !== canonicalMode) {
            errors.push(
              `${actualPath}: file mode must be ${expectedMode}, got ${actualMode.toString(8).padStart(4, "0")}`,
            );
          }
        }
      }
    }

    if (service.releaseHookPath) {
      const releaseHookPath = join(repositoryRoot, service.releaseHookPath);
      const releaseHook = await read(releaseHookPath, errors);
      if (releaseHook !== null) {
        for (const action of missingReleaseHookActions(
          releaseHook,
          profile.requiredReleaseHookActions ?? [],
        )) {
          errors.push(`${releaseHookPath}: release hook must dispatch action ${action}`);
        }
      }
    }

    const statefulServicesPath = join(repositoryRoot, "tests", "stateful-services.txt");
    const statefulServices = await read(statefulServicesPath, errors);
    if (statefulServices !== null) {
      requireExactList(
        configLines(statefulServices),
        [
          ...(service.statefulServices ?? []),
          ...(service.statefulRunServices ?? []).map((name) => `run:${name}`),
        ],
        statefulServicesPath,
        "stateful services",
        errors,
      );
    }

    const statefulModulesPath = join(repositoryRoot, "tests", "stateful-modules.txt");
    const statefulModules = await read(statefulModulesPath, errors);
    if (statefulModules !== null) {
      requireExactList(
        configLines(statefulModules),
        service.statefulModules ?? [],
        statefulModulesPath,
        "stateful modules",
        errors,
      );
    }

    const statefulEnvironmentPath = join(repositoryRoot, "tests", "stateful.env");
    const statefulEnvironment = await read(statefulEnvironmentPath, errors);
    if (statefulEnvironment !== null) {
      requireExactList(
        environmentNames(statefulEnvironment),
        service.statefulEnvironment ?? [],
        statefulEnvironmentPath,
        "stateful environment names",
        errors,
      );
    }

    const pyprojectPath = join(repositoryRoot, "pyproject.toml");
    const pyproject = await read(pyprojectPath, errors);
    if (pyproject !== null) {
      for (const fragment of [
        'requires = ["setuptools==75.8.2"]',
        'requires-python = ">=3.12,<3.13"',
        `${service.service}-api = "${service.package}.bootstrap.api:main"`,
        `${service.service}-worker = "${service.package}.bootstrap.worker:main"`,
        'target-version = "py312"',
        "line-length = 100",
        'select = ["B", "E", "F", "I", "RUF", "UP"]',
        "strict = true",
        `packages = ["${service.package}"]`,
        'mypy_path = "src"',
      ]) requireFragment(pyproject, fragment, pyprojectPath, errors);
      const pins = parsePins(pyproject);
      for (const [dependency, version] of Object.entries(profile.commonRuntimePins)) {
        if (pins.get(dependency) !== version) {
          errors.push(`${pyprojectPath}: ${dependency} must be pinned to ${version}`);
        }
      }
    }

    const devLockPath = join(repositoryRoot, "requirements-dev.lock");
    const devLock = await read(devLockPath, errors);
    if (devLock !== null) {
      const pins = parsePins(devLock);
      for (const [dependency, version] of Object.entries(profile.commonDevelopmentPins)) {
        if (pins.get(dependency) !== version) errors.push(`${devLockPath}: ${dependency} must be pinned to ${version}`);
      }
    }

    const settingsPath = join(packageRoot, "bootstrap", "settings.py");
    const settings = await read(settingsPath, errors);
    if (settings !== null) {
      for (const fragment of [
        "class DatabaseSettings(BaseSettings):",
        "class ApiSettings(DatabaseSettings):",
        "class WorkerSettings(DatabaseSettings):",
        'validation_alias="W_SERVICE_VERSION"',
        'validation_alias="W_SERVICE_REVISION"',
        'host: str = "0.0.0.0"',
        `port: int = Field(default=${service.port}`,
        "workers: int = Field(default=1",
      ]) requireFragment(settings, fragment, settingsPath, errors);
    }

    const appPath = join(packageRoot, "adapters", "inbound", "http", "app.py");
    const app = await read(appPath, errors);
    if (app !== null) {
      const httpBoundary = (
        await Promise.all(
          httpFiles.map((file) => read(join(httpPath, file), errors)),
        )
      ).filter((source) => source !== null).join("\n");
      requireFragment(httpBoundary, "service_version: str = __version__", httpPath, errors);
      requireFragment(app, "version=dependencies.service_version", appPath, errors);
      if (app.includes("version=__version__")) errors.push(`${appPath}: runtime API version bypasses injected image metadata`);
    }

    const containerPath = join(packageRoot, "bootstrap", "container.py");
    const container = await read(containerPath, errors);
    if (container !== null) {
      requireFragment(container, "service_version=settings.service_version", containerPath, errors);
      requireFragment(container, "commit_sha=settings.service_revision", containerPath, errors);
    }

    const dockerfilePath = join(repositoryRoot, "Dockerfile");
    const dockerfile = await read(dockerfilePath, errors);
    if (dockerfile !== null) {
      for (const fragment of [
        'W_SERVICE_VERSION="${SERVICE_VERSION}"',
        'W_SERVICE_REVISION="${SERVICE_REVISION}"',
        " AS build",
        "python -m pip wheel --no-cache-dir --no-deps --no-build-isolation --wheel-dir /wheels .",
        "COPY --from=build /wheels /wheels",
        "python -m pip install --no-cache-dir --no-deps --no-index /wheels/*.whl",
        `CMD ["${service.service}-api"]`,
        "FROM runtime AS test",
        'CMD ["python", "-m", "unittest", "discover", "-s", "tests", "-v"]',
      ]) requireFragment(dockerfile, fragment, dockerfilePath, errors);
      if (dockerfile.match(/RUN chmod -R a\+rX \/app\nUSER task/g)?.length !== 2) {
        errors.push(`${dockerfilePath}: runtime and test must make copied files readable before USER task`);
      }
      if (dockerfile.includes("PYTHONPATH=")) errors.push(`${dockerfilePath}: production must execute the installed distribution`);
      normalizedDockerfiles.push([dockerfilePath, normalizeDockerfile(dockerfile, service)]);
    }
  }

  const dockerBaseline = normalizedDockerfiles[0]?.[1];
  for (const [path, value] of normalizedDockerfiles.slice(1)) {
    if (value !== dockerBaseline) errors.push(`${path}: Dockerfile drifts from the cross-service release skeleton`);
  }
  for (const copies of profile.crossServiceContractCopies ?? []) {
    const sources = [];
    for (const path of copies) {
      const source = await read(join(workspaceRoot, path), errors);
      if (source !== null) sources.push([path, normalizeNewlines(source)]);
    }
    const baseline = sources[0]?.[1];
    for (const [path, source] of sources.slice(1)) {
      if (source !== baseline) errors.push(`${path}: local contract vector drifts from its producer/consumer copy`);
    }
  }
  return errors;
}

async function main() {
  const workspaceIndex = process.argv.indexOf("--workspace-root");
  const workspaceRoot = workspaceIndex === -1
    ? resolve(TOOLING_ROOT, "..")
    : resolve(process.argv[workspaceIndex + 1]);
  const errors = await checkPythonServiceConformance({ workspaceRoot });
  if (errors.length) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Python service conformance: OK\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
