import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { syncWorkspace as syncImpl, WorkspaceSyncError } from "./sync-workspace.mjs";

const fixtureLayout = ["workspace", "w-tooling", "catalog-service", "portal-ui", "w-releases", "identity-service", "account-service", "feature-service", "inference-service"].map(name => ({name, relativeRoot: name === "workspace" ? "." : name, appendixName: `${name}.md`}));
const syncWorkspace = options => syncImpl({ ...options, layout: fixtureLayout });

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function rejectsSyncError(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WorkspaceSyncError);
    assert.equal(error.code, expected.code);
    assert.equal(error.stage, expected.stage);
    assert.equal(error.path, expected.path);
    for (const [key, value] of Object.entries(expected.details ?? {})) {
      assert.deepEqual(error.details[key], value);
    }
    return true;
  });
}

test("синхронизирует compact AGENTS, rules, skills, custom agents и документацию", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "w-tooling-sync-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "w-tooling-sync-external-"));
  const toolingRoot = join(workspaceRoot, "w-tooling");
  try {
    for (const name of [
      "w-tooling",
      "catalog-service",
      "portal-ui",
      "w-releases",
      "identity-service",
      "account-service",
      "feature-service",
      "inference-service",
    ]) {
      await mkdir(join(workspaceRoot, name), { recursive: true });
    }
    await mkdir(join(toolingRoot, "templates", "agents"), { recursive: true });
    await mkdir(join(toolingRoot, "templates", "agent-rules"), { recursive: true });
    await mkdir(join(toolingRoot, ".codex", "skills", "route-task"), { recursive: true });
    await mkdir(join(toolingRoot, ".codex", "skills", "legacy-skill"), { recursive: true });
    await mkdir(
      join(toolingRoot, "templates", "workspace-skills", "cycle-optimizer", "scripts"),
      { recursive: true },
    );
    await mkdir(
      join(toolingRoot, "templates", "workspace-skills", "echo-remover"),
      { recursive: true },
    );
    await mkdir(join(toolingRoot, "templates", "workspace-agents"), { recursive: true });
    await mkdir(join(toolingRoot, "docs"), { recursive: true });
    await writeFile(
      join(toolingRoot, "templates", "AGENTS.shared.md"),
      "# Общие правила\n\n[Маршрутизация](.codex/rules/task-routing.md)\n[Legacy](.codex/rules/legacy.md)\n",
    );
    await writeFile(
      join(toolingRoot, "templates", "agent-rules", "task-routing.md"),
      "# Маршрутизация\n\n## Идентификатор задачи\n\nИспользуй `$route-task`.\n",
    );
    await writeFile(
      join(toolingRoot, "templates", "agent-rules", "legacy.md"),
      "# Legacy\n",
    );
    for (const name of [
      "workspace",
      "w-tooling",
      "catalog-service",
      "portal-ui",
      "w-releases",
      "identity-service",
      "account-service",
      "feature-service",
      "inference-service",
    ]) {
      await writeFile(join(toolingRoot, "templates", "agents", `${name}.md`), `## ${name}\n`);
    }
    await writeFile(join(toolingRoot, ".codex", "skills", "route-task", "SKILL.md"), "skill\n");
    const canonicalExecutable = join(
      toolingRoot,
      ".codex",
      "skills",
      "route-task",
      "scripts",
      "check.sh",
    );
    await mkdir(dirname(canonicalExecutable), { recursive: true });
    await writeFile(canonicalExecutable, "#!/bin/sh\nexit 0\n");
    await chmod(canonicalExecutable, 0o755);
    await writeFile(join(toolingRoot, ".codex", "skills", "legacy-skill", "SKILL.md"), "legacy\n");
    await writeFile(
      join(toolingRoot, "templates", "workspace-skills", "cycle-optimizer", "SKILL.md"),
      "workspace skill\n",
    );
    await writeFile(
      join(toolingRoot, "templates", "workspace-skills", "echo-remover", "SKILL.md"),
      "echo skill\n",
    );
    const workspaceCanonicalExecutable = join(
      toolingRoot,
      "templates",
      "workspace-skills",
      "cycle-optimizer",
      "scripts",
      "check.sh",
    );
    await writeFile(workspaceCanonicalExecutable, "#!/bin/sh\nexit 0\n");
    await chmod(workspaceCanonicalExecutable, 0o755);
    const canonicalAgent = join(
      toolingRoot,
      "templates",
      "workspace-agents",
      "product-reviewer.toml",
    );
    const validAgentDefinition = `name = "product-reviewer"
description = "Read-only product persona."
sandbox_mode = "read-only"
developer_instructions = """
Проверь пользовательский путь.
"""
`;
    await writeFile(canonicalAgent, validAgentDefinition);
    const canonicalEchoAgent = join(
      toolingRoot,
      "templates",
      "workspace-agents",
      "echo-remover.toml",
    );
    await writeFile(
      canonicalEchoAgent,
      `name = "echo-remover"
description = "Read-only echo auditor."
sandbox_mode = "read-only"
developer_instructions = """
Верни findings и patch-plan без записи.
"""
`,
    );
    await writeFile(join(toolingRoot, "docs", "notion-workflow.md"), "notion\n");
    await writeFile(join(toolingRoot, "docs", "business-value.md"), "business value\n");

    const written = await syncWorkspace({ workspaceRoot, toolingRoot, write: true });
    assert.ok(written.includes("catalog-service/AGENTS.md"));
    assert.ok(written.includes("account-service/AGENTS.md"));
    assert.ok(written.includes("feature-service/AGENTS.md"));
    assert.ok(written.includes("catalog-service/.codex/rules/task-routing.md"));
    assert.ok(written.includes(".codex/skills/route-task/SKILL.md"));
    assert.ok(written.includes(".agents/skills/cycle-optimizer/SKILL.md"));
    assert.ok(written.includes(".agents/skills/echo-remover/SKILL.md"));
    assert.ok(written.includes(".codex/agents/product-reviewer.toml"));
    assert.ok(written.includes(".codex/agents/echo-remover.toml"));
    await assert.rejects(
      lstat(join(workspaceRoot, "catalog-service", ".codex", "skills", "cycle-optimizer")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      lstat(join(workspaceRoot, "catalog-service", ".codex", "skills", "echo-remover")),
      { code: "ENOENT" },
    );
    assert.ok((await lstat(join(workspaceRoot, "catalog-service", ".codex", "agents"))).isDirectory());
    const workspaceGeneratedExecutable = join(
      workspaceRoot,
      ".agents",
      "skills",
      "cycle-optimizer",
      "scripts",
      "check.sh",
    );
    assert.equal((await lstat(workspaceGeneratedExecutable)).mode & 0o777, 0o755);
    const generatedExecutable = join(
      workspaceRoot,
      "catalog-service",
      ".codex",
      "skills",
      "route-task",
      "scripts",
      "check.sh",
    );
    assert.equal((await lstat(generatedExecutable)).mode & 0o777, 0o755);
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    await writeFile(
      canonicalAgent,
      `name = "product-reviewer"
sandbox_mode = "read-only"
developer_instructions = """
Проверь путь.
"""
`,
    );
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      {
        code: "INVALID_AGENT_DEFINITION",
        stage: "custom_agent_definition",
        path: canonicalAgent,
        details: { field: "description", occurrences: 0 },
      },
    );
    await writeFile(canonicalAgent, validAgentDefinition);
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    await writeFile(canonicalAgent, `${validAgentDefinition}approval_policy = "never"\n`);
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      {
        code: "INVALID_AGENT_DEFINITION",
        stage: "custom_agent_definition",
        path: canonicalAgent,
        details: {
          field: "approval_policy",
          reason: "unknown_field",
          unknownFields: ["approval_policy"],
        },
      },
    );
    await writeFile(
      canonicalAgent,
      validAgentDefinition.replace('sandbox_mode = "read-only"', 'sandbox_mode = "workspace-write"'),
    );
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      {
        code: "INVALID_AGENT_DEFINITION",
        stage: "custom_agent_definition",
        path: canonicalAgent,
        details: { field: "sandbox_mode", actual: "workspace-write" },
      },
    );
    await writeFile(canonicalAgent, validAgentDefinition);
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    await writeFile(canonicalAgent, `${validAgentDefinition}это не TOML\n`);
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      {
        code: "INVALID_AGENT_DEFINITION",
        stage: "custom_agent_definition",
        path: canonicalAgent,
        details: { reason: "invalid_toml" },
      },
    );
    await writeFile(canonicalAgent, validAgentDefinition);
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    const obsoleteAgent = join(workspaceRoot, ".codex", "agents", "obsolete.toml");
    await writeFile(obsoleteAgent, "obsolete\n");
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      [".codex/agents/obsolete.toml"],
    );
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      [".codex/agents/obsolete.toml"],
    );
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    await chmod(workspaceGeneratedExecutable, 0o644);
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      [".agents/skills/cycle-optimizer/scripts/check.sh"],
    );
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      [".agents/skills/cycle-optimizer/scripts/check.sh"],
    );
    assert.equal((await lstat(workspaceGeneratedExecutable)).mode & 0o777, 0o755);

    const workspaceTargetSentinel = join(externalRoot, "workspace-target-sentinel.txt");
    const workspaceGeneratedSkill = join(
      workspaceRoot,
      ".agents",
      "skills",
      "cycle-optimizer",
      "SKILL.md",
    );
    await writeFile(workspaceTargetSentinel, "workspace target must survive\n");
    await rm(workspaceGeneratedSkill);
    await symlink(workspaceTargetSentinel, workspaceGeneratedSkill, "file");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      { code: "UNSAFE_ENTRY", stage: "managed_tree_entry", path: workspaceGeneratedSkill },
    );
    assert.equal(await readFile(workspaceTargetSentinel, "utf8"), "workspace target must survive\n");
    await unlink(workspaceGeneratedSkill);
    await syncWorkspace({ workspaceRoot, toolingRoot, write: true });

    const workspaceSourceSentinel = join(externalRoot, "workspace-source-sentinel.txt");
    const workspaceSourceLink = join(
      toolingRoot,
      "templates",
      "workspace-skills",
      "cycle-optimizer",
      "linked.md",
    );
    await writeFile(workspaceSourceSentinel, "workspace source must survive\n");
    await symlink(workspaceSourceSentinel, workspaceSourceLink, "file");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      { code: "UNSAFE_ENTRY", stage: "canonical_tree_entry", path: workspaceSourceLink },
    );
    assert.equal(await readFile(workspaceSourceSentinel, "utf8"), "workspace source must survive\n");
    await unlink(workspaceSourceLink);

    const collisionRoot = join(
      toolingRoot,
      "templates",
      "workspace-skills",
      "route-task",
    );
    await mkdir(collisionRoot);
    await writeFile(join(collisionRoot, "SKILL.md"), "collision\n");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      {
        code: "CANONICAL_TREE_COLLISION",
        stage: "canonical_tree_merge",
        path: "route-task/SKILL.md",
      },
    );
    await rm(collisionRoot, { recursive: true });

    const nestedCollisionRoot = join(
      toolingRoot,
      "templates",
      "workspace-skills",
      "route-task",
      "SKILL.md",
    );
    await mkdir(nestedCollisionRoot, { recursive: true });
    await writeFile(join(nestedCollisionRoot, "nested.md"), "nested collision\n");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      {
        code: "CANONICAL_TREE_COLLISION",
        stage: "canonical_tree_merge",
        path: "route-task/SKILL.md/nested.md",
      },
    );
    await rm(join(toolingRoot, "templates", "workspace-skills", "route-task"), {
      recursive: true,
    });

    await rm(join(toolingRoot, "templates", "workspace-skills", "cycle-optimizer"), {
      recursive: true,
    });
    assert.ok(
      (await syncWorkspace({ workspaceRoot, toolingRoot, write: true })).includes(
        ".agents/skills/cycle-optimizer",
      ),
    );
    await assert.rejects(
      lstat(join(workspaceRoot, ".agents", "skills", "cycle-optimizer")),
      { code: "ENOENT" },
    );

    await chmod(generatedExecutable, 0o644);
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      ["catalog-service/.codex/skills/route-task/scripts/check.sh"],
    );
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      ["catalog-service/.codex/skills/route-task/scripts/check.sh"],
    );
    assert.equal((await lstat(generatedExecutable)).mode & 0o777, 0o755);
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    await writeFile(
      join(toolingRoot, "templates", "AGENTS.shared.md"),
      "# Общие правила\n\n[Маршрутизация](.codex/rules/task-routing.md)\n",
    );
    await rm(join(toolingRoot, "templates", "agent-rules", "legacy.md"));
    await rm(join(toolingRoot, ".codex", "skills", "legacy-skill"), {
      recursive: true,
    });
    const removedCanonicalFiles = await syncWorkspace({ workspaceRoot, toolingRoot, write: true });
    assert.ok(removedCanonicalFiles.includes("identity-service/.codex/rules/legacy.md"));
    assert.ok(removedCanonicalFiles.includes("identity-service/.codex/skills/legacy-skill"));
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    const extraRule = join(workspaceRoot, "identity-service", ".codex", "rules", "obsolete.md");
    const extraSkillFile = join(
      workspaceRoot,
      "identity-service",
      ".codex",
      "skills",
      "route-task",
      "obsolete.md",
    );
    await writeFile(extraRule, "obsolete\n");
    await writeFile(extraSkillFile, "obsolete\n");
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      [
        "identity-service/.codex/rules/obsolete.md",
        "identity-service/.codex/skills/route-task/obsolete.md",
      ],
    );
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      [
        "identity-service/.codex/rules/obsolete.md",
        "identity-service/.codex/skills/route-task/obsolete.md",
      ],
    );
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    const conflictingRule = join(
      workspaceRoot,
      "identity-service",
      ".codex",
      "rules",
      "task-routing.md",
    );
    await rm(conflictingRule);
    await mkdir(conflictingRule);
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      ["identity-service/.codex/rules/task-routing.md"],
    );
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    const sentinel = join(externalRoot, "sentinel-user-data.txt");
    const managedSkills = join(workspaceRoot, "inference-service", ".codex", "skills");
    const managedAgentsBeforeSkillsFailure = join(
      workspaceRoot,
      "catalog-service",
      "AGENTS.md",
    );
    await writeFile(sentinel, "must survive\n");
    await writeFile(managedAgentsBeforeSkillsFailure, "earlier target must stay\n");
    await rm(managedSkills, { recursive: true });
    await symlink(externalRoot, managedSkills, "dir");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      { code: "SYMLINK_PATH", stage: "managed_target", path: managedSkills },
    );
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      { code: "SYMLINK_PATH", stage: "managed_target", path: managedSkills },
    );
    assert.equal(await readFile(sentinel, "utf8"), "must survive\n");
    assert.equal(
      await readFile(managedAgentsBeforeSkillsFailure, "utf8"),
      "earlier target must stay\n",
    );
    await unlink(managedSkills);
    await syncWorkspace({ workspaceRoot, toolingRoot, write: true });

    const nestedSkillSentinel = join(externalRoot, "nested-skill-user-data.txt");
    const nestedSkillLink = join(
      workspaceRoot,
      "inference-service",
      ".codex",
      "skills",
      "route-task",
      "SKILL.md",
    );
    const managedAgentsBeforeNestedSkillsFailure = join(
      workspaceRoot,
      "catalog-service",
      "AGENTS.md",
    );
    await writeFile(nestedSkillSentinel, "nested sentinel must survive\n");
    await writeFile(
      managedAgentsBeforeNestedSkillsFailure,
      "nested failure must be atomic\n",
    );
    await rm(nestedSkillLink);
    await symlink(nestedSkillSentinel, nestedSkillLink, "file");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      { code: "UNSAFE_ENTRY", stage: "managed_tree_entry", path: nestedSkillLink },
    );
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      { code: "UNSAFE_ENTRY", stage: "managed_tree_entry", path: nestedSkillLink },
    );
    assert.equal(await readFile(nestedSkillSentinel, "utf8"), "nested sentinel must survive\n");
    assert.equal(
      await readFile(managedAgentsBeforeNestedSkillsFailure, "utf8"),
      "nested failure must be atomic\n",
    );
    assert.equal((await lstat(nestedSkillLink)).isSymbolicLink(), true);
    await unlink(nestedSkillLink);
    await syncWorkspace({ workspaceRoot, toolingRoot, write: true });

    const agentsSentinel = join(externalRoot, "agents-user-data.txt");
    const workspaceAgents = join(workspaceRoot, "inference-service", "AGENTS.md");
    const managedAgentsBeforeFileFailure = join(
      workspaceRoot,
      "catalog-service",
      "AGENTS.md",
    );
    await writeFile(agentsSentinel, "must also survive\n");
    await writeFile(managedAgentsBeforeFileFailure, "earlier file must stay\n");
    await rm(workspaceAgents);
    await symlink(agentsSentinel, workspaceAgents, "file");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      { code: "SYMLINK_PATH", stage: "managed_file", path: workspaceAgents },
    );
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      { code: "SYMLINK_PATH", stage: "managed_file", path: workspaceAgents },
    );
    assert.equal(await readFile(agentsSentinel, "utf8"), "must also survive\n");
    assert.equal(
      await readFile(managedAgentsBeforeFileFailure, "utf8"),
      "earlier file must stay\n",
    );
    await unlink(workspaceAgents);
    await syncWorkspace({ workspaceRoot, toolingRoot, write: true });

    const externalAppendix = join(externalRoot, "external-appendix.md");
    const canonicalAppendix = join(
      toolingRoot,
      "templates",
      "agents",
      "inference-service.md",
    );
    const managedAgentsBeforeSourceFailure = join(
      workspaceRoot,
      "catalog-service",
      "AGENTS.md",
    );
    await writeFile(externalAppendix, "external appendix must survive\n");
    await writeFile(managedAgentsBeforeSourceFailure, "source failure must be atomic\n");
    await rm(canonicalAppendix);
    await symlink(externalAppendix, canonicalAppendix, "file");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      { code: "SYMLINK_PATH", stage: "canonical_file", path: canonicalAppendix },
    );
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      { code: "SYMLINK_PATH", stage: "canonical_file", path: canonicalAppendix },
    );
    assert.equal(
      await readFile(externalAppendix, "utf8"),
      "external appendix must survive\n",
    );
    assert.equal(
      await readFile(managedAgentsBeforeSourceFailure, "utf8"),
      "source failure must be atomic\n",
    );
    await unlink(canonicalAppendix);
    await writeFile(canonicalAppendix, "## inference-service\n");
    await syncWorkspace({ workspaceRoot, toolingRoot, write: true });

    const canonicalSkillLink = join(
      toolingRoot,
      ".codex",
      "skills",
      "route-task",
      "linked-user-data.md",
    );
    await symlink(sentinel, canonicalSkillLink, "file");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      { code: "UNSAFE_ENTRY", stage: "canonical_tree_entry", path: canonicalSkillLink },
    );
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      { code: "UNSAFE_ENTRY", stage: "canonical_tree_entry", path: canonicalSkillLink },
    );
    assert.equal(await readFile(sentinel, "utf8"), "must survive\n");
    await unlink(canonicalSkillLink);
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    const canonicalSkillsRoot = join(toolingRoot, ".codex", "skills");
    const externalCanonicalSkills = join(externalRoot, "canonical-skills");
    const externalCanonicalSkill = join(
      externalCanonicalSkills,
      "route-task",
      "SKILL.md",
    );
    const managedAgentsDuringSkillFailure = join(
      workspaceRoot,
      "catalog-service",
      "AGENTS.md",
    );
    await mkdir(dirname(externalCanonicalSkill), { recursive: true });
    await writeFile(externalCanonicalSkill, "external skill must survive\n");
    await writeFile(managedAgentsDuringSkillFailure, "managed file must stay\n");
    await rm(canonicalSkillsRoot, { recursive: true });
    await symlink(externalCanonicalSkills, canonicalSkillsRoot, "dir");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      { code: "SYMLINK_PATH", stage: "canonical_tree", path: canonicalSkillsRoot },
    );
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      { code: "SYMLINK_PATH", stage: "canonical_tree", path: canonicalSkillsRoot },
    );
    assert.equal(await readFile(externalCanonicalSkill, "utf8"), "external skill must survive\n");
    assert.equal(
      await readFile(managedAgentsDuringSkillFailure, "utf8"),
      "managed file must stay\n",
    );
    await unlink(canonicalSkillsRoot);
    await mkdir(join(canonicalSkillsRoot, "route-task"), { recursive: true });
    await writeFile(join(canonicalSkillsRoot, "route-task", "SKILL.md"), "skill\n");
    await syncWorkspace({ workspaceRoot, toolingRoot, write: true });

    const canonicalRulesRoot = join(toolingRoot, "templates", "agent-rules");
    const externalCanonicalRules = join(externalRoot, "canonical-rules");
    const externalCanonicalRule = join(externalCanonicalRules, "task-routing.md");
    const managedAgentsDuringRuleFailure = join(
      workspaceRoot,
      "portal-ui",
      "AGENTS.md",
    );
    await mkdir(externalCanonicalRules, { recursive: true });
    await writeFile(externalCanonicalRule, "external rule must survive\n");
    await writeFile(managedAgentsDuringRuleFailure, "managed file must also stay\n");
    await rm(canonicalRulesRoot, { recursive: true });
    await symlink(externalCanonicalRules, canonicalRulesRoot, "dir");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      { code: "SYMLINK_PATH", stage: "canonical_tree", path: canonicalRulesRoot },
    );
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      { code: "SYMLINK_PATH", stage: "canonical_tree", path: canonicalRulesRoot },
    );
    assert.equal(await readFile(externalCanonicalRule, "utf8"), "external rule must survive\n");
    assert.equal(
      await readFile(managedAgentsDuringRuleFailure, "utf8"),
      "managed file must also stay\n",
    );
    await unlink(canonicalRulesRoot);
    await mkdir(canonicalRulesRoot, { recursive: true });
    await writeFile(
      join(canonicalRulesRoot, "task-routing.md"),
      "# Маршрутизация\n\n## Идентификатор задачи\n\nИспользуй `$route-task`.\n",
    );
    await syncWorkspace({ workspaceRoot, toolingRoot, write: true });
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    const externalCheckout = join(externalRoot, "external-checkout");
    const externalCheckoutAgents = join(externalCheckout, "AGENTS.md");
    const symlinkedTarget = join(workspaceRoot, "inference-service");
    const managedAgentsDuringTargetFailure = join(
      workspaceRoot,
      "catalog-service",
      "AGENTS.md",
    );
    await mkdir(externalCheckout, { recursive: true });
    await writeFile(externalCheckoutAgents, "external checkout must survive\n");
    await writeFile(managedAgentsDuringTargetFailure, "earlier target must stay\n");
    await rm(symlinkedTarget, { recursive: true });
    await symlink(externalCheckout, symlinkedTarget, "dir");
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      { code: "SYMLINK_PATH", stage: "workspace_target", path: symlinkedTarget },
    );
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: true }),
      { code: "SYMLINK_PATH", stage: "workspace_target", path: symlinkedTarget },
    );
    assert.equal(
      await readFile(externalCheckoutAgents, "utf8"),
      "external checkout must survive\n",
    );
    assert.equal(
      await readFile(managedAgentsDuringTargetFailure, "utf8"),
      "earlier target must stay\n",
    );
    await unlink(symlinkedTarget);
    await mkdir(symlinkedTarget, { recursive: true });
    await syncWorkspace({ workspaceRoot, toolingRoot, write: true });
    assert.deepEqual(await syncWorkspace({ workspaceRoot, toolingRoot, write: false }), []);

    await writeFile(join(workspaceRoot, "inference-service", "AGENTS.md"), "drift\n");
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      ["inference-service/AGENTS.md"],
    );

    await writeFile(join(workspaceRoot, "account-service", "AGENTS.md"), "drift\n");
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      ["account-service/AGENTS.md", "inference-service/AGENTS.md"],
    );

    await writeFile(
      join(workspaceRoot, "catalog-service", ".codex", "rules", "task-routing.md"),
      "drift\n",
    );
    assert.deepEqual(
      await syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      [
        "catalog-service/.codex/rules/task-routing.md",
        "account-service/AGENTS.md",
        "inference-service/AGENTS.md",
      ],
    );

    await rm(join(toolingRoot, ".codex", "skills", "route-task"), {
      recursive: true,
      force: true,
    });
    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      {
        code: "UNKNOWN_SKILL_REFERENCE",
        stage: "rule_skill_reference",
        path: "route-task",
      },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("отклоняет ссылку на отсутствующий rule-модуль", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "w-tooling-sync-invalid-link-"));
  const toolingRoot = join(workspaceRoot, "w-tooling");
  try {
    for (const name of [
      "w-tooling", "catalog-service", "portal-ui", "w-releases", "identity-service",
      "account-service", "feature-service", "inference-service",
    ]) {
      await mkdir(join(workspaceRoot, name), { recursive: true });
    }
    await mkdir(join(toolingRoot, "templates", "agents"), { recursive: true });
    await mkdir(join(toolingRoot, "templates", "agent-rules"), { recursive: true });
    await mkdir(join(toolingRoot, ".codex", "skills"), { recursive: true });
    await mkdir(join(toolingRoot, "templates", "workspace-skills"), { recursive: true });
    await mkdir(join(toolingRoot, "templates", "workspace-agents"), { recursive: true });
    await mkdir(join(toolingRoot, "docs"), { recursive: true });
    await writeFile(
      join(toolingRoot, "templates", "AGENTS.shared.md"),
      "# Router\n\n[Missing](.codex/rules/missing.md)\n",
    );
    await writeFile(
      join(toolingRoot, "templates", "agent-rules", "existing.md"),
      "# Existing\n",
    );
    for (const name of [
      "workspace", "w-tooling", "catalog-service", "portal-ui", "w-releases",
      "identity-service", "account-service", "feature-service", "inference-service",
    ]) {
      await writeFile(join(toolingRoot, "templates", "agents", `${name}.md`), `## ${name}\n`);
    }
    await writeFile(join(toolingRoot, "docs", "notion-workflow.md"), "notion\n");
    await writeFile(join(toolingRoot, "docs", "business-value.md"), "business value\n");

    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      {
        code: "MISSING_RULE_REFERENCE",
        stage: "agents_router",
        path: "existing.md",
        details: { targetName: "workspace" },
      },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("отклоняет AGENTS выше лимита стартового контекста", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "w-tooling-sync-large-agents-"));
  const toolingRoot = join(workspaceRoot, "w-tooling");
  try {
    for (const name of [
      "w-tooling", "catalog-service", "portal-ui", "w-releases", "identity-service",
      "account-service", "feature-service", "inference-service",
    ]) {
      await mkdir(join(workspaceRoot, name), { recursive: true });
    }
    await mkdir(join(toolingRoot, "templates", "agents"), { recursive: true });
    await mkdir(join(toolingRoot, "templates", "agent-rules"), { recursive: true });
    await mkdir(join(toolingRoot, ".codex", "skills"), { recursive: true });
    await mkdir(join(toolingRoot, "templates", "workspace-skills"), { recursive: true });
    await mkdir(join(toolingRoot, "templates", "workspace-agents"), { recursive: true });
    await mkdir(join(toolingRoot, "docs"), { recursive: true });
    await writeFile(
      join(toolingRoot, "templates", "AGENTS.shared.md"),
      "# Router\n\n[Rules](.codex/rules/rules.md)\n",
    );
    await writeFile(join(toolingRoot, "templates", "agent-rules", "rules.md"), "# Rules\n");
    const oversizedAppendix = Array.from({ length: 101 }, (_, index) => `line ${index}`).join("\n");
    for (const name of [
      "workspace", "w-tooling", "catalog-service", "portal-ui", "w-releases",
      "identity-service", "account-service", "feature-service", "inference-service",
    ]) {
      await writeFile(join(toolingRoot, "templates", "agents", `${name}.md`), oversizedAppendix);
    }
    await writeFile(join(toolingRoot, "docs", "notion-workflow.md"), "notion\n");
    await writeFile(join(toolingRoot, "docs", "business-value.md"), "business value\n");

    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      {
        code: "AGENTS_TOO_LARGE",
        stage: "agents_router",
        path: "workspace",
        details: { maxLines: 100 },
      },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("отклоняет возврат вынесенного раздела в AGENTS", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "w-tooling-sync-duplicated-rule-"));
  const toolingRoot = join(workspaceRoot, "w-tooling");
  try {
    for (const name of [
      "w-tooling", "catalog-service", "portal-ui", "w-releases", "identity-service",
      "account-service", "feature-service", "inference-service",
    ]) {
      await mkdir(join(workspaceRoot, name), { recursive: true });
    }
    await mkdir(join(toolingRoot, "templates", "agents"), { recursive: true });
    await mkdir(join(toolingRoot, "templates", "agent-rules"), { recursive: true });
    await mkdir(join(toolingRoot, ".codex", "skills"), { recursive: true });
    await mkdir(join(toolingRoot, "templates", "workspace-skills"), { recursive: true });
    await mkdir(join(toolingRoot, "templates", "workspace-agents"), { recursive: true });
    await mkdir(join(toolingRoot, "docs"), { recursive: true });
    await writeFile(
      join(toolingRoot, "templates", "AGENTS.shared.md"),
      "# Router\n\n[Rules](.codex/rules/rules.md)\n\n## Вынесенный раздел\n",
    );
    await writeFile(
      join(toolingRoot, "templates", "agent-rules", "rules.md"),
      "# Rules\n\n## Вынесенный раздел\n",
    );
    for (const name of [
      "workspace", "w-tooling", "catalog-service", "portal-ui", "w-releases",
      "identity-service", "account-service", "feature-service", "inference-service",
    ]) {
      await writeFile(join(toolingRoot, "templates", "agents", `${name}.md`), `## ${name}\n`);
    }
    await writeFile(join(toolingRoot, "docs", "notion-workflow.md"), "notion\n");
    await writeFile(join(toolingRoot, "docs", "business-value.md"), "business value\n");

    await rejectsSyncError(
      syncWorkspace({ workspaceRoot, toolingRoot, write: false }),
      {
        code: "DUPLICATE_RULE_HEADING",
        stage: "agents_router",
        path: "workspace",
        details: { heading: "## Вынесенный раздел" },
      },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("канонический workspace содержит persona-агентов и read-only echo-remover", async () => {
  const agentRoot = join(repositoryRoot, "templates", "workspace-agents");
  const expectedAgents = ["product-reviewer", "echo-remover", "technical-reviewer", "research-reviewer"];
  const agentFiles = new Set(await readdir(agentRoot));
  assert.deepEqual([...agentFiles].sort(), expectedAgents.map((agent) => `${agent}.toml`).sort());
  for (const agent of expectedAgents) {
    const filename = `${agent}.toml`;
    assert.equal(agentFiles.has(filename), true, `${filename} отсутствует`);
    const content = await readFile(join(agentRoot, filename), "utf8");
    assert.match(content, new RegExp(`^name = "${agent}"$`, "mu"));
    assert.match(content, /^description = ".+"$/mu);
    assert.match(content, /^sandbox_mode = "read-only"$/mu);
    assert.match(content, /^developer_instructions = """$/mu);
    assert.doesNotMatch(content, /^model(?:_reasoning_effort)?\s*=/mu);
  }

  const skillMetadata = await readFile(
    join(
      repositoryRoot,
      "templates",
      "workspace-skills",
      "cycle-optimizer",
      "agents",
      "openai.yaml",
    ),
    "utf8",
  );
  assert.match(skillMetadata, /default_prompt: ".*\$cycle-optimizer/u);
  assert.doesNotMatch(skillMetadata, /default_prompt: ".*\/cycle-optimizer/u);

  const echoSkillRoot = join(
    repositoryRoot,
    "templates",
    "workspace-skills",
    "echo-remover",
  );
  const echoSkill = await readFile(join(echoSkillRoot, "SKILL.md"), "utf8");
  const echoMetadata = await readFile(join(echoSkillRoot, "agents", "openai.yaml"), "utf8");
  assert.match(echoSkill, /^name: echo-remover$/mu);
  assert.match(echoSkill, /agent_type=echo-remover/u);
  assert.match(echoSkill, /PROFILE_BINDING: unavailable \(echo-remover\)/u);
  assert.match(echoSkill, /`PROFILE_BINDING` — обязательное первое поле/u);
  assert.match(echoSkill, /PROFILE_BINDING: echo-remover` только при подтверждении runtime-метаданными/u);
  assert.match(echoSkill, /Независимый validator не запускает remover и не пишет файлы/u);
  assert.match(echoSkill, /Не создавай и не\nпредлагай новый архив/u);
  assert.match(echoSkill, /не превращай echo в историческую справку/u);
  assert.match(echoSkill, /Рабочую механику\nrelease и rollback сохраняй/u);
  assert.match(echoMetadata, /default_prompt: ".*\$echo-remover/u);
  assert.doesNotMatch(echoMetadata, /default_prompt: ".*\/echo-remover/u);
  assert.match(echoMetadata, /allow_implicit_invocation: true/u);

  const echoAgent = await readFile(join(agentRoot, "echo-remover.toml"), "utf8");
  assert.match(echoAgent, /runtime selector `agent_type=echo-remover`/u);
  assert.match(echoAgent, /`PROFILE_BINDING`: echo-remover/u);
  assert.ok(
    echoAgent.indexOf("- `PROFILE_BINDING`:") < echoAgent.indexOf("- `verdict`:"),
    "named echo-remover должен выводить PROFILE_BINDING до verdict",
  );
  assert.match(echoAgent, /Не создавай и не предлагай новый архив/u);
  assert.match(echoAgent, /не превращай echo в\n   историческую справку/u);
  assert.match(echoAgent, /Рабочую механику\n   release и rollback сохраняй/u);
});
