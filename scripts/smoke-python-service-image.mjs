#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { scaffoldPythonService } from "./scaffold-python-service.mjs";

const IMAGE = "task-sample:python-service-template-smoke";
const CONTAINER = "task-python-service-template-smoke";
const VERSION = "987.6.5-smoke";
const REVISION = "template-smoke-revision";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

const target = await mkdtemp(join(tmpdir(), "task-python-image-smoke-"));
try {
  await scaffoldPythonService({
    target,
    serviceName: "task-sample",
    packageName: "project_sample",
    port: "8080",
  });
  run("docker", [
    "build",
    "--target",
    "production",
    "--build-arg",
    `SERVICE_VERSION=${VERSION}`,
    "--build-arg",
    `SERVICE_REVISION=${REVISION}`,
    "--tag",
    IMAGE,
    target,
  ]);

  const metadata = JSON.parse(run("docker", [
    "image",
    "inspect",
    IMAGE,
    "--format",
    "{{json .}}",
  ]));
  assert.equal(metadata.Config.Labels["org.opencontainers.image.version"], VERSION);
  assert.equal(metadata.Config.Labels["org.opencontainers.image.revision"], REVISION);
  assert.ok(metadata.Config.Env.includes(`W_SERVICE_VERSION=${VERSION}`));
  assert.ok(metadata.Config.Env.includes(`W_SERVICE_REVISION=${REVISION}`));
  assert.deepEqual(metadata.Config.Cmd, ["task-sample-api"]);

  const installed = run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--env",
    "W_SAMPLE_DATABASE_URL=postgresql://task:smoke@database:5432/task",
    "--entrypoint",
    "sh",
    IMAGE,
    "-ec",
    "command -v task-sample-api; command -v task-sample-worker; task-sample-worker",
  ]);
  assert.match(installed, /\/usr\/local\/bin\/task-sample-api/u);
  assert.match(installed, /\/usr\/local\/bin\/task-sample-worker/u);
  assert.equal(run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "python",
    IMAGE,
    "-c",
    [
      "import importlib.util",
      "assert importlib.util.find_spec('setuptools') is None",
      "assert importlib.util.find_spec('wheel') is None",
      "print('build-toolchain-absent')",
    ].join("; "),
  ]), "build-toolchain-absent");

  const containerId = run("docker", [
    "run",
    "--detach",
    "--name",
    CONTAINER,
    "--network",
    "none",
    "--env",
    "W_SAMPLE_DATABASE_URL=postgresql://task:smoke@database:5432/task",
    IMAGE,
  ]);
  assert.ok(containerId);
  const version = JSON.parse(run("docker", [
    "exec",
    CONTAINER,
    "python",
    "-c",
    [
      "import time",
      "import urllib.request",
      "last = None",
      "for _ in range(50):",
      "    try:",
      "        with urllib.request.urlopen(",
      "            'http://127.0.0.1:8080/version', timeout=1",
      "        ) as response:",
      "            print(response.read().decode('utf-8'))",
      "            break",
      "    except OSError as error:",
      "        last = error",
      "        time.sleep(0.1)",
      "else:",
      "    raise SystemExit(f'API entrypoint did not become ready: {last}')",
    ].join("\n"),
  ]));
  assert.deepEqual(version, {
    service: "task-sample",
    version: VERSION,
    commit_sha: REVISION,
  });
  process.stdout.write("Python service template image smoke: OK\n");
} finally {
  spawnSync("docker", ["rm", "--force", CONTAINER], { encoding: "utf8" });
  spawnSync("docker", ["image", "rm", "--force", IMAGE], { encoding: "utf8" });
  await rm(target, { recursive: true, force: true });
}
