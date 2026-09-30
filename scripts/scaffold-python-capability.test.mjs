import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { loadConformanceManifest } from "./check-python-service-conformance.mjs";
import { scaffoldPythonCapability } from "./scaffold-python-capability.mjs";
import { scaffoldPythonService } from "./scaffold-python-service.mjs";

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sampleService() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-capability-"));
  const target = join(workspaceRoot, "task-sample");
  await scaffoldPythonService({
    target,
    serviceName: "task-sample",
    packageName: "project_sample",
    port: "8080",
    boundedContext: "Sample",
    requirement: "Notion: Sample requirement",
  });
  const profile = await loadConformanceManifest();
  profile.crossServiceContractCopies = [];
  profile.services = [
    {
      repository: basename(target),
      service: "task-sample",
      package: "project_sample",
      environmentPrefix: "PROJECT_SAMPLE_",
      port: 8080,
      capabilityDirectories: ["application/contracts", "application/services"],
      httpModules: ["dto.py"],
      bootstrapModules: [],
      statefulServices: [],
      statefulRunServices: [],
      statefulModules: [],
      statefulEnvironment: [],
      dockerfileCapabilityCopies: [],
    },
  ];
  const manifestPath = join(workspaceRoot, "conformance.json");
  await writeFile(manifestPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return { workspaceRoot, target, manifestPath };
}

test("добавляет capability и атомарно регистрирует её в conformance", async () => {
  const fixture = await sampleService();
  try {
    const result = await scaffoldPythonCapability({
      target: fixture.target,
      packageName: "project_sample",
      capability: "publishing",
      boundedContext: "Sample",
      requirement: "Notion: Sample requirement",
      withHttp: true,
      withPersistence: true,
      verify: true,
      conformanceManifest: fixture.manifestPath,
    });

    assert.equal(result.written.length, 6);
    assert.equal(result.manifestRegistered, true);
    assert.equal(result.manifestChanged, true);
    assert.match(
      await readFile(
        join(fixture.target, "docs", "capabilities", "publishing.md"),
        "utf8",
      ),
      /Генератор не создаёт use case или invariant/u,
    );
    assert.ok(
      await exists(
        join(
          fixture.target,
          "src",
          "project_sample",
          "adapters",
          "inbound",
          "http",
          "publishing.py",
        ),
      ),
    );
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    assert.deepEqual(manifest.services[0].capabilityDirectories, [
      "application/contracts",
      "application/publishing",
      "application/services",
      "domain/publishing",
    ]);
    assert.deepEqual(manifest.services[0].httpModules, [
      "dto.py",
      "publishing.py",
    ]);

    const repeated = await scaffoldPythonCapability({
      target: fixture.target,
      packageName: "project_sample",
      capability: "publishing",
      boundedContext: "Sample",
      requirement: "Notion: Sample requirement",
      withHttp: true,
      withPersistence: true,
      verify: true,
      conformanceManifest: fixture.manifestPath,
    });
    assert.equal(repeated.written.length, 0);
    assert.equal(repeated.existing.length, 6);
    assert.equal(repeated.manifestChanged, false);
  } finally {
    await rm(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("dry-run не создаёт capability, а продолжение scaffold не перезаписывает код", async () => {
  const fixture = await sampleService();
  try {
    const dryRun = await scaffoldPythonCapability({
      target: fixture.target,
      packageName: "project_sample",
      capability: "review",
      boundedContext: "Sample",
      requirement: "Notion: Sample requirement",
      dryRun: true,
      conformanceManifest: fixture.manifestPath,
    });
    assert.equal(dryRun.files.length, 4);
    assert.equal(dryRun.written.length, 0);
    assert.equal(
      await exists(join(fixture.target, "docs", "capabilities", "review.md")),
      false,
    );

    const domain = join(
      fixture.target,
      "src",
      "project_sample",
      "domain",
      "review",
    );
    await mkdir(domain, { recursive: true });
    await writeFile(join(domain, "__init__.py"), "user code\n", "utf8");
    const completed = await scaffoldPythonCapability({
      target: fixture.target,
      packageName: "project_sample",
      capability: "review",
      boundedContext: "Sample",
      requirement: "Notion: Sample requirement",
      conformanceManifest: fixture.manifestPath,
    });
    assert.equal(completed.written.length, 3);
    assert.equal(completed.existing.length, 1);
    assert.equal(await readFile(join(domain, "__init__.py"), "utf8"), "user code\n");
  } finally {
    await rm(fixture.workspaceRoot, { recursive: true, force: true });
  }
});
