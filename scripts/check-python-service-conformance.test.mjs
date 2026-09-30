import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkPythonServiceConformance,
  loadConformanceManifest,
  missingReleaseHookActions,
  apiBootstrapTemplate,
} from "./check-python-service-conformance.mjs";
import { scaffoldPythonService } from "./scaffold-python-service.mjs";

async function scaffoldWorkspace() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-python-conformance-"));
  const manifest = await loadConformanceManifest();
  manifest.services = [["identity-service", "auth"], ["account-service", "profile"], ["feature-service", "flags"]].map(([repository, name], index) => ({ repository, service: repository, package: `project_${name}`, environmentPrefix: `PROJECT_${name.toUpperCase()}_`, port: 8101 + index, capabilityDirectories: [], httpModules: [], bootstrapModules: [], statefulServices: [], statefulRunServices: [], statefulModules: [], statefulEnvironment: [], dockerfileCapabilityCopies: [] }));
  manifest.crossServiceContractCopies = [];
  for (const service of manifest.services) {
    delete service.releaseHookPath;
    delete service.apiBootstrapProfile;
    service.capabilityDirectories = [
      ...new Set([
        ...service.capabilityDirectories,
        "application/contracts",
        "application/services",
      ]),
    ];
    service.httpModules = ["dto.py"];
    service.bootstrapModules = [];
    service.dockerfileCapabilityCopies = [];
    service.statefulServices = [];
    service.statefulRunServices = [];
    service.statefulModules = [];
    service.statefulEnvironment = [];
    await scaffoldPythonService({
      target: join(workspaceRoot, service.repository),
      serviceName: service.service,
      packageName: service.package,
      port: String(service.port),
    });
  }
  return { workspaceRoot, manifest };
}

test("общий skeleton сохраняет чтение файлов после смены пользователя", async () => {
  const { workspaceRoot, manifest } = await scaffoldWorkspace();
  try {
    assert.deepEqual(await checkPythonServiceConformance({ workspaceRoot, manifest }), []);
    for (const service of manifest.services) {
      const path = join(workspaceRoot, service.repository, "Dockerfile");
      const source = await readFile(path, "utf8");
      await writeFile(path, source.replaceAll("RUN chmod -R a+rX /app\n", ""));
    }
    const errors = await checkPythonServiceConformance({ workspaceRoot, manifest });
    assert.equal(errors.length, manifest.services.length);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("bootstrap-исключение требует известного профиля и предметной причины", () => {
  for (const profile of [{ name: "unknown", reason: "test" }, { name: "auth-client-ip" }]) {
    assert.throws(
      () => apiBootstrapTemplate({ repository: "task-sample", apiBootstrapProfile: profile }),
      { code: "INVALID_BOOTSTRAP_PROFILE", repository: "task-sample" },
    );
  }
});

test("Auth proxy bootstrap проверяется точно и не переносится без объявления", async () => {
  const { workspaceRoot, manifest } = await scaffoldWorkspace();
  try {
    const service = manifest.services[0];
    service.apiBootstrapProfile = { name: "auth-client-ip", reason: "Auth rate-limit/CAPTCHA" };
    const source = (await readFile(apiBootstrapTemplate(service), "utf8"))
      .replaceAll("__SERVICE_PACKAGE__", service.package);
    const destination = join(workspaceRoot, service.repository, "src", service.package, "bootstrap/api.py");
    await writeFile(destination, source);
    assert.deepEqual(await checkPythonServiceConformance({ workspaceRoot, manifest }), []);
    await writeFile(destination, source.replace("proxy_headers=bool(trusted_proxy_ips)", "proxy_headers=True"));
    assert.equal((await checkPythonServiceConformance({ workspaceRoot, manifest })).length, 1);
    await writeFile(destination, source);
    delete service.apiBootstrapProfile;
    assert.equal((await checkPythonServiceConformance({ workspaceRoot, manifest })).length, 1);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("блокирует release hook без общей preflight-фазы", () => {
  assert.deepEqual(
    missingReleaseHookActions(
      'case "$action" in\n  preflight) return 0 ;;\n  deploy) deploy ;;\nesac\n',
      ["preflight"],
    ),
    [],
  );
  assert.deepEqual(
    missingReleaseHookActions(
      'case "$action" in\n  deploy) deploy ;;\nesac\n',
      ["preflight"],
    ),
    ["preflight"],
  );
});

test("принимает три независимо созданных канонических Python-сервиса", async () => {
  const { workspaceRoot, manifest } = await scaffoldWorkspace();
  try {
    assert.deepEqual(await checkPythonServiceConformance({ workspaceRoot, manifest }), []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("блокирует отсутствие канонического запуска тестов", async () => {
  const { workspaceRoot, manifest } = await scaffoldWorkspace();
  try {
    await rm(join(workspaceRoot, "identity-service", "scripts", "run-tests.sh"));
    const errors = await checkPythonServiceConformance({ workspaceRoot, manifest });
    assert.ok(
      errors.some((error) => error.includes("run-tests.sh") && error.includes("missing canonical file")),
      errors.join("\n"),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("блокирует отсутствие канонического stateful-контура", async () => {
  const { workspaceRoot, manifest } = await scaffoldWorkspace();
  try {
    await rm(join(workspaceRoot, "identity-service", "compose.stateful.yaml"));
    await rm(join(workspaceRoot, "account-service", "scripts", "run-stateful-tests.sh"));
    await rm(join(workspaceRoot, "feature-service", "scripts", "release", "native-buildkit.sh"));
    const errors = await checkPythonServiceConformance({ workspaceRoot, manifest });
    assert.ok(
      errors.some((error) => error.includes("compose.stateful.yaml") && error.includes("missing canonical file")),
      errors.join("\n"),
    );
    assert.ok(
      errors.some((error) => error.includes("run-stateful-tests.sh") && error.includes("missing canonical file")),
      errors.join("\n"),
    );
    assert.ok(
      errors.some((error) => error.includes("native-buildkit.sh") && error.includes("missing canonical file")),
      errors.join("\n"),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("блокирует неполную stateful-конфигурацию сервиса", async () => {
  const { workspaceRoot, manifest } = await scaffoldWorkspace();
  try {
    const service = manifest.services.find((item) => item.repository === "identity-service");
    service.statefulServices = ["postgres", "redis"];
    service.statefulModules = ["tests.integration.test_postgres"];
    service.statefulEnvironment = ["W_AUTH_TEST_DATABASE_URL"];
    const errors = await checkPythonServiceConformance({ workspaceRoot, manifest });
    assert.ok(errors.some((error) => error.includes("stateful services must be postgres, redis")));
    assert.ok(errors.some((error) => error.includes("stateful modules must be tests.integration.test_postgres")));
    assert.ok(errors.some((error) => error.includes("stateful environment names must be W_AUTH_TEST_DATABASE_URL")));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("принимает явно объявленные capability-модули HTTP-адаптера", async () => {
  const { workspaceRoot, manifest } = await scaffoldWorkspace();
  try {
    const service = manifest.services.find((item) => item.repository === "identity-service");
    service.httpModules = ["access_routes.py", "dto.py"];
    await writeFile(
      join(
        workspaceRoot,
        "identity-service",
        "src",
        "project_auth",
        "adapters",
        "inbound",
        "http",
        "access_routes.py",
      ),
      "from __future__ import annotations\n",
      "utf8",
    );

    assert.deepEqual(await checkPythonServiceConformance({ workspaceRoot, manifest }), []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("принимает capability-specific Docker COPY только при явном объявлении", async () => {
  const { workspaceRoot, manifest } = await scaffoldWorkspace();
  try {
    const service = manifest.services.find((item) => item.repository === "identity-service");
    const dockerfile = join(workspaceRoot, "identity-service", "Dockerfile");
    const capabilityCopy = "COPY openapi.internal.yaml ./";
    await appendFile(dockerfile, `${capabilityCopy}\n`);

    let errors = await checkPythonServiceConformance({ workspaceRoot, manifest });
    assert.ok(errors.some((error) => error.includes("Dockerfile drifts")), errors.join("\n"));

    service.dockerfileCapabilityCopies = [capabilityCopy];
    errors = await checkPythonServiceConformance({ workspaceRoot, manifest });
    assert.deepEqual(errors, []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("блокирует umbrella export, неописанную capability и общий protocol drift", async () => {
  const { workspaceRoot, manifest } = await scaffoldWorkspace();
  try {
    const profileRoot = join(workspaceRoot, "account-service", "src", "project_profile");
    await appendFile(
      join(profileRoot, "application", "services", "__init__.py"),
      "\nfrom project_profile.application.services.sample import Sample\n",
    );
    await mkdir(join(profileRoot, "application", "handlers"));
    await writeFile(
      join(profileRoot, "application", "misc.py"),
      "from __future__ import annotations\n",
      "utf8",
    );
    await appendFile(
      join(profileRoot, "adapters", "inbound", "http", "protocol.py"),
      "\nDRIFT = True\n",
    );

    const errors = await checkPythonServiceConformance({ workspaceRoot, manifest });
    assert.ok(errors.some((error) => error.includes("must not re-export")), errors.join("\n"));
    assert.ok(errors.some((error) => error.includes("undeclared capability directory")), errors.join("\n"));
    assert.ok(errors.some((error) => error.includes("structural container")), errors.join("\n"));
    assert.ok(errors.some((error) => error.includes("drifts from the canonical tooling template")), errors.join("\n"));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("блокирует drift producer/consumer percentage rollout vectors", async () => {
  const { workspaceRoot, manifest } = await scaffoldWorkspace();
  try {
    const producer = join(
      workspaceRoot,
      "feature-service",
      "tests",
      "fixtures",
      "contracts",
      "v2",
    );
    const consumer = join(
      workspaceRoot,
      "account-service",
      "tests",
      "fixtures",
      "contracts",
      "v2",
    );
    await mkdir(producer, { recursive: true });
    await mkdir(consumer, { recursive: true });
    await writeFile(
      join(producer, "rollout-vectors.json"),
      '{"bucket":2246,"percentages":[0,37,100]}\n',
      "utf8",
    );
    await writeFile(
      join(consumer, "rollout-vectors.json"),
      '{"bucket":2246,"percentages":[0,37,100]}\n',
      "utf8",
    );
    manifest.crossServiceContractCopies = [[
      "feature-service/tests/fixtures/contracts/v2/rollout-vectors.json",
      "account-service/tests/fixtures/contracts/v2/rollout-vectors.json",
    ]];
    await writeFile(
      join(consumer, "rollout-vectors.json"),
      '{"bucket":2247,"percentages":[0,37,100]}\n',
      "utf8",
    );

    const errors = await checkPythonServiceConformance({ workspaceRoot, manifest });
    assert.ok(
      errors.some((error) => error.includes("local contract vector drifts")),
      errors.join("\n"),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
