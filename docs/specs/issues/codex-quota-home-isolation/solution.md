# Technical solution: Codex quota test isolation

## Problem statement

See [problem.md](problem.md).

## Proposed solution

- Remove the HOME constant and all HOME writes from the quota test helper.
- Retain the temporary agent directory override and restoration of pi-specific environment variables.
- Remove the unused Codex CLI auth fixture.
- Keep assertions for the model-registry provider and quota request headers.
- Describe the pi model registry as the credential source in the extension documentation.

## Overengineering and overspecification considerations

The change removes unused global state and fixture files. It introduces no new isolation abstraction or authorization behavior.

## Open questions

None.

## References

- [Requirements](prd.md)
- [Codex quota extension](../../../extensions/codex-quota.md)
