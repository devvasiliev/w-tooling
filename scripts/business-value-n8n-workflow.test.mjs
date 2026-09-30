import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  checkRunningRuntimeDigest,
  importN8nWorkflow,
  validateN8nWorkflow,
} from "./business-value/n8n-workflow.mjs";

const workflowPath = resolve("templates/n8n/business-value/workflow.json");
const loadWorkflow = async () => JSON.parse(await readFile(workflowPath, "utf8"));

test("n8n workflow has only authenticated form, validation, branching and fixed runner calls", async () => {
  const result = validateN8nWorkflow(await loadWorkflow());
  assert.deepEqual(result, {
    name: "Оценка Business Value",
    nodeCount: 26,
    httpStageCount: 7,
    codeValidatorCount: 9,
    credentialCount: 0,
  });
});

test("n8n workflow validator rejects credentials and external-capability nodes", async () => {
  const withCredential = structuredClone(await loadWorkflow());
  withCredential.nodes.find((node) => node.type === "n8n-nodes-base.httpRequest").credentials = {
    httpHeaderAuth: { id: "secret", name: "secret" },
  };
  assert.throws(
    () => validateN8nWorkflow(withCredential),
    (error) => error.code === "WORKFLOW_CREDENTIAL_FORBIDDEN",
  );

  const withCommand = structuredClone(await loadWorkflow());
  withCommand.nodes.push({
    id: "forbidden",
    name: "Command",
    type: "n8n-nodes-base.executeCommand",
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
  });
  assert.throws(
    () => validateN8nWorkflow(withCommand),
    (error) => error.code === "WORKFLOW_NODE_FORBIDDEN",
  );
});

test("idempotent import preserves My workflow and creates backup before update", async () => {
  const workflow = await loadWorkflow();
  const temporary = await mkdtemp(join(tmpdir(), "task-bv-n8n-"));
  const myWorkflow = { id: "my-1", name: "My workflow", active: false, nodes: [], connections: {}, settings: {} };
  let remote = { id: "bv-1", active: false, ...workflow };
  const api = {
    async workflows() {
      return [
        { id: myWorkflow.id, name: myWorkflow.name, active: false, isArchived: false },
        { id: remote.id, name: remote.name, active: false, isArchived: false },
      ];
    },
    async workflow(id) {
      return id === myWorkflow.id ? structuredClone(myWorkflow) : structuredClone(remote);
    },
    async request(path, options) {
      assert.equal(path, "/workflows/bv-1");
      assert.equal(options.method, "PUT");
      remote = { id: "bv-1", active: false, ...JSON.parse(options.body) };
      return remote;
    },
  };
  try {
    const result = await importN8nWorkflow({ api, workflow, backupDirectory: temporary });
    assert.equal(result.id, "bv-1");
    assert.equal(result.active, false);
    assert.ok(result.backupPath.startsWith(temporary));
    const backup = JSON.parse(await readFile(result.backupPath, "utf8"));
    assert.equal(backup.id, "bv-1");
    assert.deepEqual(await api.workflow("my-1"), myWorkflow);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("publish preflight связывает running runner digest с canonical manifest", async () => {
  const expected = "a".repeat(64);
  const execFileImpl = (_command, args, _options, callback) => {
    assert.deepEqual(args.slice(0, 3), [
      "exec",
      "task-business-value-runner",
      "node",
    ]);
    callback(null, JSON.stringify({ ok: true, sourceDigest: expected }));
  };
  assert.equal(
    (await checkRunningRuntimeDigest(expected, { execFileImpl })).sourceDigest,
    expected,
  );
  await assert.rejects(
    checkRunningRuntimeDigest("b".repeat(64), { execFileImpl }),
    (error) => error.code === "RUNTIME_MANIFEST_DRIFT",
  );
});
