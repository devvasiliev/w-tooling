import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  runWorkspaceHarnessCli,
  scaffoldWorkspaceHarness,
  verifyWorkspaceHarness,
} from "./scaffold-workspace-harness.mjs";
import { workspaceTargets } from "./workspace-layout.mjs";
const WORKSPACE_TARGETS = workspaceTargets();

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const sourceToolingRoot = resolve(currentDirectory, "..");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createWorkspaceFixture() {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "task-workspace-harness-")));
  const toolingRoot = join(workspaceRoot, "w-tooling");
  for (const { relativeRoot } of WORKSPACE_TARGETS) {
    await mkdir(resolve(workspaceRoot, relativeRoot), { recursive: true });
  }
  for (const path of [
    join(toolingRoot, ".codex", "skills"),
    join(toolingRoot, "config"),
    join(toolingRoot, "docs"),
    join(toolingRoot, "templates", "agent-rules"),
    join(toolingRoot, "templates", "agents"),
    join(toolingRoot, "templates", "workspace-agents"),
    join(toolingRoot, "templates", "workspace-skills"),
  ]) {
    await mkdir(path, { recursive: true });
  }
  await cp(join(sourceToolingRoot, "config", "project.json"), join(toolingRoot, "config", "project.json"));
  await cp(
    join(sourceToolingRoot, "templates", "workspace-harness"),
    join(toolingRoot, "templates", "workspace-harness"),
    { recursive: true },
  );
  await writeFile(join(toolingRoot, "templates", "AGENTS.shared.md"), "# Shared\n");
  for (const { name, appendixName } of WORKSPACE_TARGETS) {
    await writeFile(
      join(toolingRoot, "templates", "agents", appendixName),
      `## ${name}\n`,
    );
  }
  await writeFile(join(toolingRoot, "docs", "notion-workflow.md"), "# Notion\n");
  await writeFile(join(toolingRoot, "docs", "business-value.md"), "# Business Value\n");
  return { workspaceRoot, toolingRoot };
}

test("создаёт полный skill+agent bundle и регистрирует его в подключённых checkout", async () => {
  const fixture = await createWorkspaceFixture();
  try {
    const result = await scaffoldWorkspaceHarness({
      ...fixture,
      name: "owner-auditor",
      displayName: "Owner Auditor",
      description: "Проверяет владельца поведения и границы изменений",
    });
    assert.equal(result.created.length, 5);
    assert.deepEqual(result.checks, ["bundle-contract", "workspace-sync"]);

    const verified = await verifyWorkspaceHarness({
      toolingRoot: fixture.toolingRoot,
      name: "owner-auditor",
    });
    assert.equal(verified.files.length, 5);
    const canonicalSkill = join(
      fixture.toolingRoot,
      "templates",
      "workspace-skills",
      "owner-auditor",
      "SKILL.md",
    );
    const canonicalAgent = join(
      fixture.toolingRoot,
      "templates",
      "workspace-agents",
      "owner-auditor.toml",
    );
    const generatedSkill = join(
      fixture.toolingRoot,
      ".agents",
      "skills",
      "owner-auditor",
      "SKILL.md",
    );
    const generatedAgent = join(
      fixture.toolingRoot,
      ".codex",
      "agents",
      "owner-auditor.toml",
    );
    assert.equal(await readFile(generatedSkill, "utf8"), await readFile(canonicalSkill, "utf8"));
    assert.equal(await readFile(generatedAgent, "utf8"), await readFile(canonicalAgent, "utf8"));
    for (const { name, relativeRoot } of WORKSPACE_TARGETS) {
      if (name === "workspace") continue;
      const targetRoot = resolve(fixture.workspaceRoot, relativeRoot);
      assert.equal(
        await exists(join(targetRoot, ".agents", "skills", "owner-auditor")),
        true,
      );
      assert.equal(
        await exists(join(targetRoot, ".codex", "agents", "owner-auditor.toml")),
        true,
      );
      assert.equal(
        await exists(join(targetRoot, ".codex", "skills", "owner-auditor")),
        false,
      );
    }

    const before = await readFile(canonicalAgent, "utf8");
    await assert.rejects(
      scaffoldWorkspaceHarness({
        ...fixture,
        name: "owner-auditor",
        displayName: "Owner Auditor",
        description: "Не должна перезаписать существующий workspace bundle",
      }),
      (error) => error.code === "ARTIFACT_EXISTS" && error.stage === "destination_preflight",
    );
    assert.equal(await readFile(canonicalAgent, "utf8"), before);

    const contractPath = join(
      fixture.toolingRoot,
      "templates",
      "workspace-skills",
      "owner-auditor",
      "tests",
      "contract.json",
    );
    await writeFile(contractPath, '{"schema_version":1,"required_files":null}\n');
    await assert.rejects(
      verifyWorkspaceHarness({
        toolingRoot: fixture.toolingRoot,
        name: "owner-auditor",
      }),
      (error) => error.code === "GENERATED_CONTRACT_INVALID" && error.stage === "bundle_verify",
    );
  } finally {
    await rm(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("dry-run возвращает точный план без файлов и sync", async () => {
  const fixture = await createWorkspaceFixture();
  let syncCalls = 0;
  try {
    const result = await scaffoldWorkspaceHarness({
      ...fixture,
      name: "release-reader",
      displayName: "Release Reader",
      description: "Проверяет release evidence без изменения репозитория",
      dryRun: true,
      syncWorkspaceFn: async () => {
        syncCalls += 1;
        return [];
      },
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.planned.length, 5);
    assert.equal(syncCalls, 0);
    assert.equal(
      await exists(join(fixture.toolingRoot, "templates", "workspace-agents", "release-reader.toml")),
      false,
    );
    assert.equal(
      await exists(join(fixture.toolingRoot, "templates", "workspace-skills", "release-reader")),
      false,
    );
  } finally {
    await rm(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("вложенный tooling использует workspace из конфигурации и сохраняет соседние checkout", async () => {
  const fixture = await createWorkspaceFixture();
  try {
    const tools = join(fixture.workspaceRoot, "tools");
    const toolingRoot = join(tools, "w-tooling");
    await mkdir(tools);
    await rename(fixture.toolingRoot, toolingRoot);
    const configPath = join(toolingRoot, "config/project.json");
    const project = JSON.parse(await readFile(configPath));
    project.workspaceRoot = "../..";
    project.repositories.find(item => item.role === "tooling").path = "tools/w-tooling";
    await writeFile(configPath, JSON.stringify(project));
    const unrelated = [join(tools, "tools/w-tooling"), join(tools, "w-releases")];
    for (const path of unrelated) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "AGENTS.md"), "unrelated checkout\n");
    }
    await scaffoldWorkspaceHarness({ toolingRoot, name: "nested-reader", displayName: "Nested Reader", description: "Проверяет правильно настроенный вложенный workspace" });
    assert.equal(await exists(join(fixture.workspaceRoot, "w-releases/.agents/skills/nested-reader/SKILL.md")), true);
    for (const path of unrelated) {
      assert.equal(await readFile(join(path, "AGENTS.md"), "utf8"), "unrelated checkout\n");
      assert.deepEqual(await readdir(path), ["AGENTS.md"]);
    }
  } finally { await rm(fixture.workspaceRoot, { recursive: true, force: true }); }
});

test("scaffold проверяет все checkout до создания канонического bundle", async () => {
  const fixture = await createWorkspaceFixture();
  try {
    const external = join(fixture.workspaceRoot, "unregistered");
    await mkdir(external);
    await writeFile(join(external, "sentinel"), "keep");
    await symlink(external, join(fixture.workspaceRoot, "w-releases/.agents"));
    await assert.rejects(scaffoldWorkspaceHarness({ ...fixture, name: "safe-reader", displayName: "Safe Reader", description: "Проверяет назначения до записи канонического bundle" }), { code: "SYMLINK_PATH" });
    assert.equal(await exists(join(fixture.toolingRoot, "templates/workspace-skills/safe-reader")), false);
    assert.equal(await exists(join(fixture.toolingRoot, "templates/workspace-agents/safe-reader.toml")), false);
    assert.deepEqual(await readdir(external), ["sentinel"]);
  } finally { await rm(fixture.workspaceRoot, { recursive: true, force: true }); }
});

test("не создаёт workspace bundle поверх одноимённого project skill", async () => {
  const fixture = await createWorkspaceFixture();
  const projectSkillRoot = join(
    fixture.toolingRoot,
    ".codex",
    "skills",
    "release-reader",
  );
  try {
    await mkdir(projectSkillRoot);
    await writeFile(join(projectSkillRoot, "SKILL.md"), "# Existing project skill\n");
    await assert.rejects(
      scaffoldWorkspaceHarness({
        ...fixture,
        name: "release-reader",
        displayName: "Release Reader",
        description: "Проверяет release evidence без изменения репозитория",
      }),
      (error) => error.code === "ARTIFACT_EXISTS" && error.stage === "destination_preflight",
    );
    assert.equal(
      await exists(join(fixture.toolingRoot, "templates", "workspace-skills", "release-reader")),
      false,
    );
  } finally {
    await rm(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("CLI печатает короткий план, а ошибки имеют стабильную классификацию", async () => {
  const fixture = await createWorkspaceFixture();
  let stdout = "";
  let stderr = "";
  try {
    const exitCode = await runWorkspaceHarnessCli(
      [
        "--name",
        "risk-reader",
        "--display-name",
        "Risk Reader",
        "--description",
        "Проверяет риски решения и возвращает read-only verdict",
        "--dry-run",
      ],
      {
        ...fixture,
        stdout: { write: (value) => { stdout += value; } },
        stderr: { write: (value) => { stderr += value; } },
      },
    );
    assert.equal(exitCode, 0);
    assert.match(stdout, /Workspace bundle запланирован: risk-reader/u);
    assert.match(stdout, /templates\/workspace-agents\/risk-reader\.toml/u);
    assert.equal(stderr, "");

    await assert.rejects(
      scaffoldWorkspaceHarness({
        ...fixture,
        name: "Risk Reader",
        displayName: "Risk Reader",
        description: "Проверяет стабильную классификацию ошибки имени",
      }),
      (error) => error.code === "INVALID_NAME" && error.stage === "input_validation",
    );
    await assert.rejects(
      scaffoldWorkspaceHarness({
        ...fixture,
        name: "risk-reader",
        displayName: "Risk Reader",
        description: "Проверяет <неуказанный> риск решения до реализации",
      }),
      (error) => error.code === "INVALID_DESCRIPTION" && error.stage === "input_validation",
    );
  } finally {
    await rm(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test("проверяет каждый canonical bundle с tests/contract.json", async () => {
  const workspaceSkillsRoot = join(sourceToolingRoot, "templates", "workspace-skills");
  const entries = await readdir(workspaceSkillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const contractPath = join(workspaceSkillsRoot, entry.name, "tests", "contract.json");
    if (!(await exists(contractPath))) continue;
    await verifyWorkspaceHarness({ toolingRoot: sourceToolingRoot, name: entry.name });
  }
});
