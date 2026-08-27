# Technical Solution: Context Projection Custom Message Mapping

## Problem Statement

- PRB-01: Pi assigns one timestamp to a live custom message and another timestamp to its persisted `custom_message` entry.
- PRB-02: `mapEventMessagesToBranchEntries` rejects the complete context mapping when those timestamps differ, which prevents projection after extension custom messages.

## Proposed Solution

- SOL-01: Keep strict deep equality as the first matching rule for every message.
- SOL-02: When strict equality fails for a persisted `custom_message` and both compared messages have the `custom` role, compare both messages again without their top-level `timestamp` fields.
- SOL-03: Require `role`, `customType`, `content`, `display`, and `details` to remain deeply equal.
- SOL-04: Keep strict timestamp matching for ordinary user, assistant, and tool-result messages.
- SOL-05: Preserve sequential branch mapping, so duplicate custom messages map in branch order.
- ACC-01: A timestamp-only custom message difference produces a complete mapping and allows an eligible tool result to be projected.
- ACC-02: A difference in custom message content, custom type, details, or display produces no mapping.
- ACC-03: A timestamp difference in an ordinary message produces no mapping.

## Overengineering and Overspecification Considerations

- TRD-01: The solution changes one comparison rule for one Pi message type. It does not add timestamp tolerances, identifiers, persistence adapters, or Pi source changes.
- TRD-02: Sequential mapping and deep equality for all semantic fields preserve the existing fail-safe behavior.

## Open Questions

None.

## References

- REF-01: `pi-package/shared/context-projection.ts` - Owns branch-to-context message mapping.
- REF-02: `pi-package/shared/context-projection.test.ts` - Covers custom and ordinary message identity rules.
- REF-03: `pi-package/extensions/context-projection/index.test.ts` - Covers projection after a live custom message timestamp mismatch.
