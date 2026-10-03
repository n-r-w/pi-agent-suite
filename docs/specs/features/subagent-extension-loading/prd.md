# Subagent extension loading

## Definitions

See [Terms](terms.md).

## Context and problem

See [Problem statement](problem.md). The package-only launcher prevented configured agents from using tools supplied by additional extensions.

## Goal

Let users control additional extension loading without removing the required subagent runtime or weakening agent tool restrictions.

## Scenarios

- Start a direct or nested subagent with the selected extension-loading mode.
- Continue a completed saved subagent session with the selected mode.
- Keep only package extensions, use ordinary Pi extension settings, or load an explicit extension list.

## Scope and non-scope

The setting applies to run-subagent workers. The required package remains loaded. Agent definitions and tool policies retain their meaning. Other child launchers and replacement of enable-tools are outside this feature.

## Requirements

### Functional requirements

- [x] FRQ-01: The package shall read the subagent extension setting from `agent-selection/config.json` under the suite storage directory.
  - Origin: source, approved configuration proposal.
  - Goal: Give users one standard configuration location.
  - Goal achievement: Full for configuration ownership.
- [x] FRQ-02: When mode is `none`, each new worker shall load only the required package.
  - Origin: source, approved D1 and D4.
  - Goal: Allow package-only workers.
  - Goal achievement: Full for disabling additional extensions.
- [x] FRQ-03: When mode is `all`, each new worker shall load the required package and extensions enabled by ordinary Pi user and project settings.
  - Origin: source, approved D2 and D4.
  - Goal: Preserve ordinary extension availability.
  - Goal achievement: Full for normal Pi extension discovery.
- [x] FRQ-04: When mode is `explicit`, each new worker shall load the required package and only the sources in `include`.
  - Origin: source, approved D3, D4, D5, and D6.
  - Goal: Allow an explicitly selected extension set, including built-in extensions.
  - Goal achievement: Full for explicit selection.
- [x] FRQ-05: When the file or setting is absent, the package shall use `all`.
  - Origin: source, approved D8.
  - Goal: Avoid an implicit package-only restriction.
  - Goal achievement: Full for the default behavior.
- [x] FRQ-06: After extensions register their tools, the child shall apply the agent's existing tool policy.
  - Origin: source, approved D7.
  - Goal: Keep extension loading separate from tool permissions.
  - Goal achievement: Full for preserving agent tool restrictions.

## Open questions

None.

## Technical supplement

The approved setting is `subagents.extensions`, with required `mode` values `none`, `all`, and `explicit`. The `include` array is required and permitted only in `explicit` mode. Its entries are non-whitespace strings; an empty list selects no additional extensions.

The existing top-level `enabled` field continues to control main-agent selection. The new setting does not change its meaning.

## References

- [Technical solution](solution.md)
- [run-subagent configuration](../../../extensions/run-subagent.md#additional-extensions)
