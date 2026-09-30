import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scaffoldPythonService } from "./scaffold-python-service.mjs";
import { syncPythonRelease } from "./sync-python-release.mjs";

test("восстанавливает канонические release-файлы без изменения manifest сервиса", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-release-sync-"));
  const repository = join(workspaceRoot, "identity-service");
  const manifestPath = join(workspaceRoot, "manifest.json");
  try {
    await scaffoldPythonService({
      target: repository,
      serviceName: "identity-service",
      packageName: "project_auth",
      port: "8101",
    });
    const manifest = {
      canonicalReleaseFiles: [
        {
          template: "scripts/release/build-distribution.sh",
          destination: "scripts/release/build-distribution.sh",
          mode: "0755",
        },
        {
          template: "scripts/release/verify_image_archive.py.tpl",
          destination: "scripts/release/verify_image_archive.py",
          mode: "0755",
        },
      ],
      services: [
        {
          repository: "identity-service",
          service: "identity-service",
          package: "project_auth",
          environmentPrefix: "W_AUTH_",
          port: 8101,
        },
      ],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const localManifest = join(repository, "scripts/release/distribution.json");
    await writeFile(localManifest, "service-owned\n", "utf8");
    await writeFile(join(repository, "scripts/release/build-distribution.sh"), "drift\n", "utf8");
    const verifier = join(repository, "scripts/release/verify_image_archive.py");
    await chmod(verifier, 0o600);

    const changed = await syncPythonRelease({ workspaceRoot, manifestPath });

    assert.deepEqual(changed, [
      "identity-service/scripts/release/build-distribution.sh",
      "identity-service/scripts/release/verify_image_archive.py",
    ]);
    assert.match(
      await readFile(join(repository, "scripts/release/build-distribution.sh"), "utf8"),
      /build_distribution\.py/u,
    );
    assert.match(
      await readFile(verifier, "utf8"),
      /org\.opencontainers\.image\.source": "identity-service"/u,
    );
    assert.equal((await stat(verifier)).mode & 0o777, 0o755);
    assert.equal(await readFile(localManifest, "utf8"), "service-owned\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
