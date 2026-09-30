import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const read = (path) => readFile(resolve(path), "utf8");

test("container source allowlists separate dedicated Notion runner from Codex auth", async () => {
  const [runner, codex] = await Promise.all([
    read("templates/n8n/business-value/runner.Dockerfile"),
    read("templates/n8n/business-value/codex.Dockerfile"),
  ]);
  assert.match(runner, /runner-server\.mjs/u);
  assert.match(runner, /business-value-build-manifest\.json config\/runtime-build-manifest\.json/u);
  assert.match(runner, /notion-workflow-lib\.mjs/u);
  assert.doesNotMatch(runner, /codex-provider\.mjs|codex-server\.mjs|codex-supervisor\.mjs|direct-eval\.mjs/u);
  assert.match(codex, /@openai\/codex/u);
  assert.match(codex, /codex-provider\.mjs/u);
  assert.match(codex, /codex-server\.mjs/u);
  assert.match(codex, /codex-supervisor\.mjs/u);
  assert.match(codex, /business-value-build-manifest\.json config\/runtime-build-manifest\.json/u);
  assert.doesNotMatch(codex, /notion-workflow-lib\.mjs|runner-server\.mjs|run-store\.mjs/u);
});

test("compose keeps n8n, dedicated Notion runner and Codex auth on separate boundaries", async () => {
  const compose = await read("templates/n8n/business-value/compose.yaml");
  const n8n = compose.slice(compose.indexOf("  n8n:"), compose.indexOf("  business-value-runner:"));
  const runner = compose.slice(compose.indexOf("  business-value-runner:"), compose.indexOf("  business-value-codex:"));
  const codexStart = compose.indexOf("  business-value-codex:");
  const codex = compose.slice(codexStart, compose.indexOf("\nvolumes:", codexStart));

  assert.match(n8n, /127\.0\.0\.1:5678:5678/u);
  assert.match(n8n, /N8N_ENV_FEAT_FORM_TRIGGER_OAUTH2: "true"/u);
  assert.match(n8n, /N8N_BLOCK_ENV_ACCESS_IN_NODE: "true"/u);
  assert.match(n8n, /N8N_COMMUNITY_PACKAGES_ENABLED: "false"/u);
  assert.doesNotMatch(n8n, /NOTION|OPENAI|CODEX|business_value_state|runner_codex/u);
  assert.match(n8n, /- n8n_runner\n      - n8n_host/u);

  assert.match(runner, /notion-business-value\.env:ro/u);
  assert.match(runner, /W_BV_NOTION_BOT_NAME: W Business Value/u);
  assert.match(runner, /W_BV_ALLOW_CODEX_SUBSCRIPTION: "true"/u);
  assert.match(runner, /business_value_state/u);
  assert.doesNotMatch(runner, /auth\.json|OPENAI_API_KEY|notion\.env:ro/u);
  assert.doesNotMatch(runner, /ports:/u);

  assert.match(codex, /\$\{W_BV_CODEX_AUTH_PATH:\?set W_BV_CODEX_AUTH_PATH\}:\/var\/lib\/codex\/auth\.json:rw/u);
  assert.match(codex, /read_only: true/u);
  assert.match(codex, /cap_drop:\n      - ALL/u);
  assert.match(codex, /no-new-privileges:true/u);
  assert.doesNotMatch(codex, /notion|business_value_state|NOTION_TOKEN|OPENAI_API_KEY/u);
  assert.doesNotMatch(codex, /ports:/u);
  assert.equal((codex.match(/volumes:/gu) || []).length, 1);
  assert.equal((codex.match(/auth\.json:rw/gu) || []).length, 1);

  assert.match(compose, /n8n_runner:\n    internal: true/u);
  assert.match(compose, /runner_codex:\n    internal: true/u);
});

test("Codex process uses only direct argv and stdin transport", async () => {
  const [runner, server, provider, supervisor] = await Promise.all([
    read("scripts/business-value/runner-server.mjs"),
    read("scripts/business-value/codex-server.mjs"),
    read("scripts/business-value/codex-provider.mjs"),
    read("scripts/business-value/codex-supervisor.mjs"),
  ]);
  assert.doesNotMatch(runner, /node:child_process|OPENAI_API_KEY/u);
  assert.doesNotMatch(server, /node:child_process|notion|RunStore|STATE_DIRECTORY/u);
  assert.match(provider, /node:child_process/u);
  assert.match(supervisor, /node:child_process/u);
  for (const source of [provider, supervisor]) {
    assert.match(source, /shell: false/u);
    assert.doesNotMatch(source, /execSync|execFileSync|\/bin\/sh|sh -c/u);
  }
  assert.match(provider, /child\.stdin\.end\(input\)/u);
  assert.match(supervisor, /child\.stdin\.end\(input\)/u);
  assert.match(provider, /features\.plugins=false/u);
  assert.match(provider, /features\.shell_tool=false/u);
  assert.match(provider, /web_search/u);
  assert.match(provider, /permissions\.business_value\.enabled_tools/u);
  assert.match(runner, /runtime-build-manifest/u);
  assert.match(server, /runtime-build-manifest/u);
});
