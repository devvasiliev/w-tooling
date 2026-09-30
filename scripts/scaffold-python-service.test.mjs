import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { scaffoldPythonService } from "./scaffold-python-service.mjs";

const python = process.env.PYTHON || "python3";

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("создаёт независимый Python DDD scaffold и ловит запрещённый импорт", async () => {
  const target = await mkdtemp(join(tmpdir(), "task-python-service-"));
  try {
    const written = await scaffoldPythonService({
      target,
      serviceName: "task-sample",
      packageName: "project_sample",
      port: "8080",
    });
    assert.ok(written.includes("src/project_sample/domain/__init__.py"));
    for (const path of [
      "src/project_sample/application/services/__init__.py",
      "src/project_sample/application/contracts/__init__.py",
      "src/project_sample/adapters/inbound/http/app.py",
      "src/project_sample/adapters/inbound/http/dto.py",
      "src/project_sample/adapters/inbound/http/protocol.py",
      "src/project_sample/adapters/outbound/persistence/__init__.py",
      "src/project_sample/bootstrap/api.py",
      "src/project_sample/bootstrap/worker.py",
      "src/project_sample/bootstrap/container.py",
      "src/project_sample/bootstrap/settings.py",
      "src/project_sample/bootstrap/logging.py",
      "docs/traceability.md",
      "requirements/build.in",
      "requirements/lock-tool.in",
      "requirements/runtime.in",
      "requirements/test.in",
      "requirements/dev.in",
      "requirements-build.lock",
      "requirements-lock-tool.lock",
      "scripts/check_dependency_locks.py",
      "scripts/compile_requirements.py",
      "tests/architecture/test_dependency_locks.py",
      "tests/contract/test_http_protocol.py",
    ]) {
      assert.ok(written.includes(path), `не создан ${path}`);
    }
    assert.ok(!written.includes("src/project_sample/bootstrap/main.py"));

    const pyproject = await readFile(join(target, "pyproject.toml"), "utf8");
    assert.match(pyproject, /task-sample-api = "project_sample\.bootstrap\.api:main"/u);
    assert.match(pyproject, /task-sample-worker = "project_sample\.bootstrap\.worker:main"/u);
    assert.match(pyproject, /strict = true/u);
    assert.match(pyproject, /select = \["B", "E", "F", "I", "RUF", "UP"\]/u);
    assert.match(pyproject, /starlette==1\.6\.0/u);

    const devLock = await readFile(join(target, "requirements-dev.lock"), "utf8");
    assert.match(devLock, /mypy==1\.17\.1/u);
    assert.match(devLock, /ruff==0\.12\.11/u);
    assert.match(devLock, /--hash=sha256:[0-9a-f]{64}/u);
    assert.match(
      await readFile(join(target, "requirements-test.lock"), "utf8"),
      /httpx2==2\.12\.0/u,
    );
    assert.match(
      await readFile(join(target, "requirements.lock"), "utf8"),
      /starlette==1\.6\.0/u,
    );
    assert.match(
      await readFile(join(target, "requirements-lock-tool.lock"), "utf8"),
      /pip-tools==7\.5\.0[\s\\]+--hash=sha256:/u,
    );

    const traceability = await readFile(join(target, "docs", "traceability.md"), "utf8");
    assert.match(traceability, /Requirement \/ master specification/u);
    assert.match(traceability, /Legacy evidence and classification/u);
    assert.match(traceability, /Acceptance test/u);

    await appendFile(
      join(target, "src", "project_sample", "domain", "__init__.py"),
      "\nfrom dataclasses import dataclass\n",
    );

    const clean = spawnSync(
      python,
      ["scripts/check_architecture.py", "--package", "project_sample"],
      { cwd: target, encoding: "utf8" },
    );
    assert.equal(clean.status, 0, clean.stderr);

    const compile = spawnSync(
      python,
      ["-m", "compileall", "-q", "src", "tests", "scripts", "migrations"],
      { cwd: target, encoding: "utf8", env: { ...process.env, PYTHONPYCACHEPREFIX: join(target, ".pycache") } },
    );
    assert.equal(compile.status, 0, compile.stderr);

    await appendFile(
      join(target, "src", "project_sample", "domain", "__init__.py"),
      "\nimport fastapi\n",
    );
    const invalid = spawnSync(
      python,
      ["scripts/check_architecture.py", "--package", "project_sample"],
      { cwd: target, encoding: "utf8" },
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /domain may use only the standard library/u);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("фиксирует единый coding profile в scaffold", async () => {
  const target = await mkdtemp(join(tmpdir(), "task-python-service-profile-"));
  try {
    await scaffoldPythonService({
      target,
      serviceName: "task-sample",
      packageName: "project_sample",
      port: "8080",
    });

    const app = await readFile(
      join(target, "src", "project_sample", "adapters", "inbound", "http", "app.py"),
      "utf8",
    );
    assert.match(app, /@dataclass\(frozen=True, slots=True\)/u);
    assert.match(app, /def create_app\(dependencies: HttpDependencies\) -> FastAPI/u);
    assert.match(app, /install_http_protocol\(app,/u);
    assert.match(app, /HealthResponse\(status="ok" if ready else "unavailable"\)/u);
    assert.match(app, /commit_sha=dependencies\.commit_sha/u);

    const dto = await readFile(
      join(target, "src", "project_sample", "adapters", "inbound", "http", "dto.py"),
      "utf8",
    );
    assert.match(dto, /ConfigDict\(extra="forbid"\)/u);
    assert.match(dto, /class HealthResponse\(TransportDTO\)/u);
    assert.match(dto, /class VersionResponse\(TransportDTO\)/u);
    assert.match(dto, /commit_sha: str/u);
    assert.match(dto, /class ErrorResponse\(TransportDTO\)/u);

    const protocol = await readFile(
      join(target, "src", "project_sample", "adapters", "inbound", "http", "protocol.py"),
      "utf8",
    );
    assert.match(protocol, /CORRELATION_HEADER = "X-Correlation-ID"/u);
    assert.match(protocol, /def error_response\(/u);
    assert.match(protocol, /def install_http_protocol\(/u);
    assert.match(protocol, /RequestValidationError/u);

    const settings = await readFile(
      join(target, "src", "project_sample", "bootstrap", "settings.py"),
      "utf8",
    );
    assert.match(settings, /env_prefix="PROJECT_SAMPLE_"/u);
    assert.match(settings, /class DatabaseSettings\(BaseSettings\)/u);
    assert.match(settings, /class ApiSettings\(DatabaseSettings\)/u);
    assert.match(settings, /class WorkerSettings\(DatabaseSettings\)/u);
    assert.match(settings, /validation_alias="W_SERVICE_VERSION"/u);
    assert.match(settings, /validation_alias="W_SERVICE_REVISION"/u);

    const api = await readFile(
      join(target, "src", "project_sample", "bootstrap", "api.py"),
      "utf8",
    );
    assert.match(api, /def create_application\(\) -> FastAPI/u);
    assert.match(api, /"project_sample\.bootstrap\.api:create_application"/u);
    assert.match(api, /factory=True/u);

    const logging = await readFile(
      join(target, "src", "project_sample", "bootstrap", "logging.py"),
      "utf8",
    );
    assert.match(logging, /class JsonFormatter\(logging\.Formatter\)/u);

    const dockerfile = await readFile(join(target, "Dockerfile"), "utf8");
    assert.match(dockerfile, /ARG SERVICE_VERSION=0\.1\.0/u);
    assert.match(dockerfile, /ARG SERVICE_REVISION=unknown/u);
    assert.match(dockerfile, /org\.opencontainers\.image\.version/u);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision/u);
    assert.match(dockerfile, /W_SERVICE_VERSION/u);
    assert.match(dockerfile, /W_SERVICE_REVISION/u);
    assert.match(dockerfile, / AS build/u);
    assert.match(dockerfile, /pip wheel .*--no-build-isolation/u);
    assert.match(dockerfile, /pip install --no-cache-dir --require-hashes/u);
    assert.match(dockerfile, /COPY --from=build \/wheels \/wheels/u);
    assert.match(dockerfile, /CMD \["task-sample-api"\]/u);
    assert.ok(
      dockerfile.indexOf("RUN python -m pip install --no-cache-dir --require-hashes")
        < dockerfile.indexOf("LABEL org.opencontainers.image.version"),
    );
    assert.ok(
      dockerfile.indexOf("FROM runtime AS production")
        < dockerfile.indexOf("LABEL org.opencontainers.image.version"),
    );
    assert.doesNotMatch(dockerfile, /PYTHONPATH=/u);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("не перезаписывает существующие service-файлы", async () => {
  const target = await mkdtemp(join(tmpdir(), "task-python-service-existing-"));
  try {
    await appendFile(join(target, "pyproject.toml"), "existing\n");
    await assert.rejects(
      scaffoldPythonService({
        target,
        serviceName: "task-sample",
        packageName: "project_sample",
        port: "8080",
      }),
      /Target содержит service-файлы/u,
    );
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("dry-run планирует business-first service и verify принимает результат", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-python-service-command-"));
  const target = join(workspaceRoot, "task-sample");
  try {
    const planned = await scaffoldPythonService({
      target,
      serviceName: "task-sample",
      packageName: "project_sample",
      port: "8080",
      boundedContext: "Publishing",
      requirement: "Notion: Publishing requirement",
      capabilities: ["drafts"],
      dryRun: true,
    });
    assert.ok(planned.includes("docs/service-map.md"));
    assert.ok(planned.includes("docs/capabilities/drafts.md"));
    assert.ok(planned.includes("src/project_sample/domain/drafts/__init__.py"));
    assert.equal(await exists(target), false);

    const written = await scaffoldPythonService({
      target,
      serviceName: "task-sample",
      packageName: "project_sample",
      port: "8080",
      boundedContext: "Publishing",
      requirement: "Notion: Publishing requirement",
      capabilities: ["drafts"],
      verify: true,
    });
    assert.deepEqual(written, planned);
    assert.match(
      await readFile(join(target, "docs", "service-map.md"), "utf8"),
      /Bounded context: Publishing/u,
    );
    assert.match(
      await readFile(join(target, "docs", "capabilities", "drafts.md"), "utf8"),
      /Notion: Publishing requirement/u,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
