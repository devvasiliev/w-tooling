{
  "schema_version": 1,
  "name": __NAME_JSON__,
  "required_files": [
    "templates/workspace-agents/__NAME__.toml",
    "templates/workspace-skills/__NAME__/SKILL.md",
    "templates/workspace-skills/__NAME__/agents/openai.yaml",
    "templates/workspace-skills/__NAME__/evals/matrix.json",
    "templates/workspace-skills/__NAME__/tests/contract.json"
  ],
  "assertions": {
    "sandbox_mode": "read-only",
    "writes_allowed": false,
    "allow_implicit_invocation": false,
    "profile_binding": {
      "confirmed": __PROFILE_CONFIRMED_JSON__,
      "fallback": __PROFILE_FALLBACK_JSON__
    }
  }
}
