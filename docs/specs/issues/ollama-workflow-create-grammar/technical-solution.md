# Technical Solution: Ollama Workflow Creation Grammar Compatibility

## Problem Statement

- PRB-01: Ollama 0.32.15 converts tool JSON Schema into a constrained-generation grammar before model execution.
- PRB-02: The `workflow_create` schema combines nested stage and transition arrays with regex `pattern` constraints. Ollama rejects this schema with `Failed to initialize samplers: failed to parse grammar`.
- PRB-03: `workflow_create` remains active before a workflow starts, so the schema failure blocks requests that do not call the tool.

## Proposed Solution

### SOL-01: Provider-facing schema

- Define the six `workflow_create` string fields with `Type.String` and their existing `minLength`, `maxLength`, and descriptions.
- Keep required fields, collection limits, enums, and closed object shapes in the provider-facing schema.
- Keep the shared `technicalIdentifierSchema` and `singleLineTextSchema` contracts for other tools.

### SOL-02: Domain validation

- Pass structurally valid strings from the provider-facing schema to `validateCreatedWorkflowDefinition`.
- Continue to reject blank, untrimmed, and multiline human text through `isSingleLineText`. Continue to reject whitespace-bearing identifiers through `isTechnicalIdentifier` before workflow state is persisted.

### SOL-03: Validation

- Test that the provider-facing schema accepts structurally valid strings for domain validation.
- Test that workflow execution rejects invalid root text, stage text and identifiers, and transition endpoints.
- Run the complete repository verification and a real Pi request with `workflow_create` active against each affected local Ollama model.

## Overengineering and Overspecification Considerations

- The solution changes only the `workflow_create` boundary schema.
- The solution adds no provider detection, schema rewriting layer, configuration, or dependency.
- Existing domain validation remains the owner of exact workflow string rules.

## Open Questions

No unresolved questions remain.

## References

- REF-01: `pi-package/extensions/workflow/index.ts` - provider-facing workflow tool schemas.
- REF-02: `pi-package/extensions/workflow/workflow.ts` - exact workflow domain validation.
- REF-03: `pi-package/extensions/workflow/index.test.ts` - provider and domain boundary behavior tests.
