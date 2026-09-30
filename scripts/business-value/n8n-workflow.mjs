#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BusinessValueError } from "./errors.mjs";
import { checkRuntimeManifest } from "./runtime-manifest.mjs";

export const WORKFLOW_NAME = "Оценка Business Value";
const ALLOWED_NODE_TYPES = new Set([
  "n8n-nodes-base.code",
  "n8n-nodes-base.form",
  "n8n-nodes-base.formTrigger",
  "n8n-nodes-base.httpRequest",
  "n8n-nodes-base.if",
]);
const FORBIDDEN_NODE_FRAGMENTS = [
  "agent",
  "executecommand",
  "executeworkflow",
  "filesystem",
  "localfile",
  "mcp",
  "notion",
  "schedule",
  "ssh",
  "webhook",
];
const RUNNER_URL = /^=?http:\/\/business-value-runner:8080\/v1\/runs\//u;
const RUNNER_HEALTH_SCRIPT =
  "fetch('http://127.0.0.1:8080/health').then(async r=>{const b=await r.text();if(!r.ok)throw new Error(b);process.stdout.write(b)}).catch(()=>process.exit(1))";

const fail = (code, message, details = {}) => {
  throw new BusinessValueError(code, message, details);
};

const assert = (condition, code, message) => {
  if (!condition) fail(code, message);
};

const normalizedCredentialCount = (node) => Object.keys(node.credentials || {}).length;

export function validateN8nWorkflow(workflow) {
  assert(workflow?.name === WORKFLOW_NAME, "WORKFLOW_NAME_INVALID", `Workflow должен называться «${WORKFLOW_NAME}»`);
  assert(Array.isArray(workflow.nodes) && workflow.nodes.length > 0, "WORKFLOW_NODES_MISSING", "В workflow отсутствуют nodes");
  const names = new Set();
  let triggerCount = 0;
  let httpCount = 0;
  let codeCount = 0;
  for (const node of workflow.nodes) {
    assert(node?.id && node?.name && node?.type, "WORKFLOW_NODE_INVALID", "Node не содержит id, name или type");
    assert(!names.has(node.name), "WORKFLOW_NODE_DUPLICATE", `Повторяется node «${node.name}»`);
    names.add(node.name);
    const normalizedType = node.type.toLocaleLowerCase("en-US");
    assert(ALLOWED_NODE_TYPES.has(node.type), "WORKFLOW_NODE_FORBIDDEN", `Запрещён node type ${node.type}`);
    assert(
      !FORBIDDEN_NODE_FRAGMENTS.some((fragment) => normalizedType.includes(fragment)),
      "WORKFLOW_NODE_FORBIDDEN",
      `Запрещён node type ${node.type}`,
    );
    assert(normalizedCredentialCount(node) === 0, "WORKFLOW_CREDENTIAL_FORBIDDEN", `Node «${node.name}» содержит credential`);

    if (node.type === "n8n-nodes-base.formTrigger") {
      triggerCount += 1;
      assert(node.typeVersion >= 2.6, "FORM_TRIGGER_VERSION_INVALID", "Form Trigger должен поддерживать n8n User Auth");
      assert(node.parameters?.authentication === "n8nUserAuth", "FORM_TRIGGER_AUTH_INVALID", "Form Trigger не использует n8n User Auth");
      assert(node.parameters?.requireExecuteAccess === true, "FORM_TRIGGER_RBAC_INVALID", "Form Trigger не проверяет Execute permission");
      assert(node.parameters?.options?.includeUserInOutput !== false, "FORM_TRIGGER_ACTOR_MISSING", "Form Trigger не передаёт пользователя");
    }

    if (node.type === "n8n-nodes-base.httpRequest") {
      httpCount += 1;
      assert(RUNNER_URL.test(node.parameters?.url || ""), "HTTP_TARGET_FORBIDDEN", `Node «${node.name}» обращается не к private runner`);
      assert(node.parameters?.method === "POST", "HTTP_METHOD_INVALID", `Node «${node.name}» должен использовать POST`);
      const headers = node.parameters?.headerParameters?.parameters || [];
      const headerNames = headers.map((header) => String(header.name || "").toLocaleLowerCase("en-US")).sort();
      assert(
        JSON.stringify(headerNames) === JSON.stringify(["x-identity-serviceenticated-user", "x-task-run-origin"]),
        "HTTP_HEADERS_INVALID",
        `Node «${node.name}» содержит недопустимые headers`,
      );
      const origin = headers.find((header) => header.name.toLocaleLowerCase("en-US") === "x-task-run-origin");
      const actor = headers.find((header) => header.name.toLocaleLowerCase("en-US") === "x-identity-serviceenticated-user");
      assert(origin?.value === "n8n-form", "HTTP_ORIGIN_INVALID", `Node «${node.name}» содержит неверный origin`);
      assert(/^=\{\{[\s\S]*\.user\.(?:email|id)[\s\S]*\}\}$/u.test(actor?.value || ""), "HTTP_ACTOR_INVALID", `Node «${node.name}» не использует actor Form Trigger`);
      assert(node.parameters?.options?.response?.response?.neverError === true, "HTTP_ERROR_CONTRACT_INVALID", `Node «${node.name}» не сохраняет typed error body`);
      assert(!JSON.stringify(node).match(/(?:OPENAI|NOTION)_[A-Z_]+/u), "HTTP_SECRET_REFERENCE_FORBIDDEN", `Node «${node.name}» ссылается на credential`);
    }

    if (node.type === "n8n-nodes-base.code") {
      codeCount += 1;
      const source = String(node.parameters?.jsCode || "");
      assert(source.length > 0, "CODE_VALIDATOR_EMPTY", `Code node «${node.name}» пуст`);
      assert(!/\b(?:fetch|require|process|\$env|child_process|fs\b|http\b|https\b)\b/u.test(source), "CODE_CAPABILITY_FORBIDDEN", `Code node «${node.name}» содержит внешнюю capability`);
    }
  }
  assert(triggerCount === 1, "FORM_TRIGGER_COUNT_INVALID", "Должен существовать ровно один Form Trigger");
  assert(httpCount === 7, "HTTP_STAGE_COUNT_INVALID", "Workflow должен содержать семь fixed runner stages");
  assert(codeCount >= 7, "CODE_VALIDATOR_COUNT_INVALID", "Не хватает strict Code validation stages");
  const serialized = JSON.stringify(workflow);
  for (const requiredStage of ["prepare", "research", "analyze", "score", "preview", "publish", "cancel"]) {
    assert(serialized.includes(`/v1/runs/`) && serialized.includes(requiredStage), "WORKFLOW_STAGE_MISSING", `Отсутствует stage ${requiredStage}`);
  }
  return {
    name: workflow.name,
    nodeCount: workflow.nodes.length,
    httpStageCount: httpCount,
    codeValidatorCount: codeCount,
    credentialCount: workflow.nodes.reduce((sum, node) => sum + normalizedCredentialCount(node), 0),
  };
}

const parseEnvFile = async (path) => {
  try {
    const text = await readFile(path, "utf8");
    return Object.fromEntries(
      text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
};

const safeWorkflowBody = (workflow) => ({
  name: workflow.name,
  nodes: workflow.nodes,
  connections: workflow.connections,
  settings: workflow.settings || { executionOrder: "v1" },
});

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const timestampForPath = () => new Date().toISOString().replaceAll(":", "-").replace(".", "-");

const writePrivateJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};

export const checkRunningRuntimeDigest = (
  expectedDigest,
  { execFileImpl = execFile } = {},
) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFileImpl(
      "docker",
      [
        "exec",
        "task-business-value-runner",
        "node",
        "-e",
        RUNNER_HEALTH_SCRIPT,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          rejectPromise(
            new BusinessValueError(
              "RUNTIME_SERVICE_UNHEALTHY",
              "Running Business Value services не прошли healthcheck",
            ),
          );
          return;
        }
        let health;
        try {
          health = JSON.parse(stdout);
        } catch {
          rejectPromise(
            new BusinessValueError(
              "RUNTIME_HEALTH_INVALID",
              "Runner health вернул невалидный ответ",
            ),
          );
          return;
        }
        if (health.sourceDigest !== expectedDigest) {
          rejectPromise(
            new BusinessValueError(
              "RUNTIME_MANIFEST_DRIFT",
              "Running images расходятся с canonical source manifest",
            ),
          );
          return;
        }
        resolvePromise(health);
      },
    );
  });

class N8nApi {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/u, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      ...options,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "X-N8N-API-KEY": this.apiKey,
        ...(options.headers || {}),
      },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) fail("N8N_API_FAILED", `n8n API вернул HTTP ${response.status}`, { status: response.status });
    return value;
  }

  async workflows() {
    const result = await this.request("/workflows?limit=250");
    return result.data || [];
  }

  async workflow(id) {
    return this.request(`/workflows/${encodeURIComponent(id)}`);
  }
}

const exactWorkflow = async (api, name = WORKFLOW_NAME) => {
  const matches = (await api.workflows()).filter((workflow) => workflow.name === name && !workflow.isArchived);
  if (matches.length > 1) fail("N8N_WORKFLOW_AMBIGUOUS", `Найдено несколько workflow «${name}»`);
  return matches[0] || null;
};

const myWorkflowDigest = async (api) => {
  const matches = (await api.workflows()).filter((workflow) => workflow.name === "My workflow" && !workflow.isArchived);
  if (matches.length > 1) fail("N8N_MY_WORKFLOW_AMBIGUOUS", "Найдено несколько My workflow");
  if (!matches[0]) return null;
  return digest(await api.workflow(matches[0].id));
};

export async function importN8nWorkflow({ api, workflow, backupDirectory }) {
  const validation = validateN8nWorkflow(workflow);
  const beforeMyWorkflow = await myWorkflowDigest(api);
  const existing = await exactWorkflow(api);
  let result;
  let backupPath = null;
  if (existing) {
    const current = await api.workflow(existing.id);
    backupPath = resolve(backupDirectory, `${timestampForPath()}-${existing.id}.json`);
    await writePrivateJson(backupPath, current);
    result = await api.request(`/workflows/${encodeURIComponent(existing.id)}`, {
      method: "PUT",
      body: JSON.stringify(safeWorkflowBody(workflow)),
    });
  } else {
    result = await api.request("/workflows", {
      method: "POST",
      body: JSON.stringify(safeWorkflowBody(workflow)),
    });
  }
  const afterMyWorkflow = await myWorkflowDigest(api);
  assert(beforeMyWorkflow === afterMyWorkflow, "N8N_UNRELATED_WORKFLOW_CHANGED", "My workflow изменился во время import");
  return { id: result.id, name: result.name, active: Boolean(result.active), backupPath, validation };
}

const cli = async () => {
  const [command = "", fileArgument = ""] = process.argv.slice(2);
  const defaultWorkflowPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../templates/n8n/business-value/workflow.json");
  const workflowPath = resolve(fileArgument || defaultWorkflowPath);
  if (command === "validate") {
    const workflow = JSON.parse(await readFile(workflowPath, "utf8"));
    process.stdout.write(`${JSON.stringify({ ok: true, ...validateN8nWorkflow(workflow) }, null, 2)}\n`);
    return;
  }

  const envPath = resolve(process.env.W_N8N_ENV_PATH || ".env");
  const fileEnv = await parseEnvFile(envPath);
  const apiKey = process.env.N8N_API_KEY || fileEnv.N8N_API_KEY;
  if (!apiKey) fail("N8N_API_KEY_MISSING", `Не найден N8N_API_KEY в ${envPath}`);
  const api = new N8nApi({
    baseUrl: process.env.N8N_BASE_URL || fileEnv.N8N_BASE_URL || "http://127.0.0.1:5678",
    apiKey,
  });

  if (command === "import") {
    const workflow = JSON.parse(await readFile(workflowPath, "utf8"));
    const result = await importN8nWorkflow({ api, workflow, backupDirectory: resolve("backups") });
    process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "N8N_WORKFLOW_IMPORTED", ...result }, null, 2)}\n`);
    return;
  }

  if (command === "export") {
    const existing = await exactWorkflow(api);
    if (!existing) fail("N8N_WORKFLOW_NOT_FOUND", `Workflow «${WORKFLOW_NAME}» не найден`);
    const workflow = await api.workflow(existing.id);
    validateN8nWorkflow(workflow);
    await writePrivateJson(workflowPath, workflow);
    process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "N8N_WORKFLOW_EXPORTED", id: workflow.id, path: workflowPath }, null, 2)}\n`);
    return;
  }

  if (command === "publish") {
    const manifest = await checkRuntimeManifest({
      runtimeDirectory:
        process.env.W_BV_RUNTIME_DIR ||
        ".project/business-value-runtime",
    });
    const existing = await exactWorkflow(api);
    if (!existing) fail("N8N_WORKFLOW_NOT_FOUND", `Workflow «${WORKFLOW_NAME}» не найден`);
    const workflow = await api.workflow(existing.id);
    validateN8nWorkflow(workflow);
    const runtimeHealth = await checkRunningRuntimeDigest(manifest.sourceDigest);
    const published = workflow.active
      ? workflow
      : await api.request(`/workflows/${encodeURIComponent(existing.id)}/activate`, { method: "POST" });
    process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "N8N_WORKFLOW_PUBLISHED", id: published.id, active: Boolean(published.active), manifest, runtimeHealth }, null, 2)}\n`);
    return;
  }

  fail("N8N_COMMAND_INVALID", "Команды: validate, import, export, publish");
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  cli().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, reasonCode: error.code || "N8N_WORKFLOW_FAILED", message: error.message })}\n`);
    process.exitCode = 1;
  });
}

export { N8nApi };
