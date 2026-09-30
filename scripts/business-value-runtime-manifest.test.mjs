import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUILD_MANIFEST_PATH,
  checkRuntimeManifest,
  deployRuntime,
} from "./business-value/runtime-manifest.mjs";

test("runtime deploy фиксирует source/installed digests и check ловит drift", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "task-bv-runtime-"));
  try {
    const deployed = await deployRuntime({ runtimeDirectory });
    assert.match(deployed.sourceDigest, /^[0-9a-f]{64}$/u);
    assert.match(deployed.installedDigest, /^[0-9a-f]{64}$/u);
    const buildManifest = JSON.parse(
      await readFile(new URL(`../${BUILD_MANIFEST_PATH}`, import.meta.url), "utf8"),
    );
    assert.equal(buildManifest.sourceDigest, deployed.sourceDigest);
    const current = await checkRuntimeManifest({ runtimeDirectory });
    assert.equal(current.reasonCode, "RUNTIME_MANIFEST_CURRENT");
    const composePath = join(runtimeDirectory, "compose.yaml");
    const compose = await readFile(composePath, "utf8");
    await writeFile(composePath, `${compose}\n# drift\n`);
    await assert.rejects(
      checkRuntimeManifest({ runtimeDirectory }),
      (error) => error.code === "RUNTIME_MANIFEST_DRIFT",
    );
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
