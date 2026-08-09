# Technical Solution: Thinking-Level Resolution

## Problem Statement

- PRB-01: `assertThinkingLevelSupported` rejects a configured thinking level when `getSupportedThinkingLevels(model)` omits that exact level.
- PRB-02: A valid agent, workflow, council participant, compaction, summary, or auxiliary-model configuration can fail even when the model exposes another usable thinking level.
- PRB-03: Configurations with `thinking: "off"` must remain usable for models that do not expose `off`.

## Proposed Solution

### SOL-01: Shared level resolver

- WHILE a configured level is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, WHEN a component resolves model settings, THE shared resolver SHALL return a thinking level from `getSupportedThinkingLevels(model)`.
- WHILE the model exposes the requested level, WHEN the resolver runs, THE shared resolver SHALL return that level.
- WHILE the model omits `minimal` or `low`, WHEN the paired level is available, THE shared resolver SHALL return the paired level.
- WHILE the model omits `medium` or `high`, WHEN the paired level is available, THE shared resolver SHALL return the paired level.
- WHILE no paired level is available, WHEN the resolver runs, THE shared resolver SHALL search higher levels in this order: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- WHILE no higher level is available, WHEN the resolver runs, THE shared resolver SHALL search lower levels in the reverse order.
- WHILE no supported level is reported, WHEN the resolver runs, THE shared resolver SHALL return `off`.
- WHILE a value is outside the seven configured levels, WHEN the resolver runs, THE shared resolver SHALL throw an error that lists all seven levels.

### SOL-02: Runtime application

- WHILE a component applies model settings, WHEN it has a valid configured thinking level, THE component SHALL apply the level returned by `resolveThinkingLevel`.
- WHILE `run-subagent` creates a child invocation, WHEN the selected child model omits its configured or inherited thinking level, THE extension SHALL pass the resolved level to the child process and invocation metadata.
- WHILE `knowledge` sends an extraction or merge request, WHEN its configured or inherited thinking level is unavailable for the operation model, THE extension SHALL send the resolved level.
- WHILE `ask-llm`, `consult-advisor`, or `subagent-query` has no explicit thinking level, WHEN it uses the current Pi thinking level with another model, THE component SHALL resolve that level against the selected model before sending the request.
- WHILE `main-agent-selection` applies an agent, WHEN the selected model does not expose its configured level, THE extension SHALL apply the resolved model and thinking levels without reporting an unsupported-thinking warning.
- WHILE a workflow applies settings, WHEN its target model does not expose its configured level, THE workflow extension SHALL pass the resolved level to its runtime model application.
- WHILE custom compaction, convene-council, tool-result-summary, or auxiliary-llm prepares a request, WHEN its model omits the requested level, THE component SHALL use the resolved level in its runtime request.

### SOL-03: Verification

- ACC-01: Unit tests cover paired-level resolution, higher-level resolution, lower-level resolution, `xhigh` to `max`, `off` to a higher level, and a non-reasoning model resolving to `off`.
- ACC-02: Workflow activation with `xhigh` and `openai/current-model` completes with the fake thinking level set to `high`.
- ACC-03: Main-agent selection with `high` and a non-reasoning model applies `off` without a warning.

## Overengineering and Overspecification Considerations

- The change has one shared resolver and passes its result through existing setting-application paths.
- The change adds no configuration field, user interface, compatibility layer, or model capability cache.

## Open Questions

No unresolved design questions remain for this solution.

## References

- REF-01: `pi-package/shared/model-settings.ts` - shared model settings validation and thinking-level resolution.
- REF-02: `pi-package/extensions/main-agent-selection/index.ts` - selected agent model and thinking application.
- REF-03: `pi-package/extensions/workflow/model-runtime.ts` - workflow model and thinking application.
- REF-04: `pi-package/shared/model-settings.test.ts` - resolver behavior tests.
