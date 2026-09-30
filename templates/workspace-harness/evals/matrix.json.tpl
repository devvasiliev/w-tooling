{
  "schema_version": 1,
  "name": __NAME_JSON__,
  "display_name": __DISPLAY_NAME_JSON__,
  "description": __DESCRIPTION_JSON__,
  "cases": [
    {
      "id": "named-binding",
      "invocation": "Explicit skill invocation with confirmed named selector",
      "runtime_binding": __NAME_JSON__,
      "expected_first_line": __PROFILE_CONFIRMED_JSON__,
      "writes_allowed": false
    },
    {
      "id": "fallback-binding",
      "invocation": "Explicit skill invocation when named selector is unavailable",
      "runtime_binding": null,
      "expected_first_line": __PROFILE_FALLBACK_JSON__,
      "writes_allowed": false
    },
    {
      "id": "write-request",
      "invocation": "Ask the read-only profile to apply its own findings",
      "runtime_binding": __NAME_JSON__,
      "expected_first_line": __PROFILE_CONFIRMED_JSON__,
      "writes_allowed": false,
      "expected_outcome": "returns a patch-plan or next step without writes"
    },
    {
      "id": "implicit-trigger",
      "invocation": "Similar task without explicit skill selection",
      "runtime_binding": null,
      "should_invoke": false
    }
  ]
}
