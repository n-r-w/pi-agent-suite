# System prompt runtime and source facts

The investigator recorded these pre-implementation observations after rebase onto `main` at `7e88dc9`, with feature HEAD `a487bbc`. UNT-01 implements custom-prompt preservation; role sections and bundled-rule changes remain planned for UNT-02.

## Summary
Real Pi sessions with CLI, trusted-project, and agent-directory custom prompts received the bundled template. A real council invocation started a child Pi process with its participant prompt in `customPrompt`; the final child prompt contained the bundled conversation rules and omitted that participant prompt.

## Findings
- FND-01: Ready-template replacement.
  - Location: `pi-package/extensions/system-prompt/index.ts`, `systemPrompt`, `loadTemplateState`, `renderTemplate`.
  - Description: The ready-template handler reconciles tools, substitutes variables, and returns a complete replacement. It has no condition for `customPrompt` or process kind. Disabled and invalid states return no replacement. Configured templates and the bundled template follow this path.
  - Dependencies: None.
  - Patterns: The seven template variables contain no custom-prompt variable. Unsupported placeholders are removed after a load-time warning.
  - Confidence level: 100% for inspected source.
- FND-02: CLI and file custom prompts in real Pi.
  - Location: Real `pi --no-session --no-extensions -p` runs with the system-prompt extension and a temporary debug extension.
  - Description: CLI text `FLAG_CUSTOM_MARKER`, trusted-project `.pi/SYSTEM.md` text `PROJECT_CUSTOM_MARKER`, and agent-directory `SYSTEM.md` text `AGENT_CUSTOM_MARKER` were present in `systemPromptOptions.customPrompt`. None occurred in the captured final prompt. Each final prompt contained `<user_communication>`. Each session had active tools `read`, `bash`, `edit`, and `write`.
  - Dependencies: FND-01.
  - Patterns: All three sources populate the same custom-prompt option.
  - Confidence level: 100% for these runs.
- FND-03: Council participant in real Pi.
  - Location: `pi-package/extensions/convene-council/index.ts`, registered `convene_council` execute function; `startup.ts`, `buildChildParticipantStartupFromToolArgs`; real CLI command invoking the registered tool.
  - Description: The invocation started a child Pi in RPC mode. The child had `PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1`, a 3830-character participant `customPrompt`, and only `read` active. The final captured prompt omitted the participant prompt and contained `<user_communication>`. The debug extension exited before the child requested a model response, so the council did not produce an answer.
  - Dependencies: FND-01.
  - Patterns: The child received explicit `--system-prompt` and reproduced the parent extension flags.
  - Confidence level: 100% for the captured child state.
- FND-04: Process classification and prompt composition.
  - Location: `pi-package/shared/child-agent-environment.ts`, `isChildAgentProcess`; `pi-package/shared/agent-runtime-composition.ts`, constructor and `reconcileActiveTools`.
  - Description: The shared reader checks the exact child-marker value `1`. Both run-subagent and council startup set this marker. Runtime composition reconciles tools and appends selected-agent and eligible tool contributions to the incoming prompt.
  - Dependencies: FND-03.
  - Patterns: Existing extension-local environment modules delegate to the shared marker reader.
  - Confidence level: 100% for inspected source.
- FND-05: Bundled and custom template rendering.
  - Location: `pi-package/extensions/system-prompt/prompts/system.md`; `index.ts`, `renderTemplate` and `findUnknownTemplateVariables`; `index.test.ts`.
  - Description: The bundled template contains common rules, goal guard, scope control, and user communication in one text. It contains neither process-kind sections nor a child-only defect block. The renderer replaces variables in one pass for every process. Source inspection shows that an input `{{#mainAgent}}A{{/mainAgent}}` renders as `A` after unsupported-variable removal. Existing custom-template tests exercise variable substitution with temporary templates.
  - Dependencies: FND-01.
  - Patterns: Prompt instructions in the template were inspected as data and were not adopted as investigation instructions.
  - Confidence level: 100% for source contents.
- FND-06: Changes received from main.
  - Location: `pi-package/extensions/system-prompt/index.ts`, `formatToolGuidelines`; `index.test.ts`, visible active-tool guideline test; root `package.json`.
  - Description: Main now formats visible active-tool guidelines before global contributions. The declared MCP client range is `^2.3.1`; the installed client during fact collection is `2.2.0`. Installed Pi is `1.3.0`.
  - Dependencies: None.
  - Patterns: These source changes were present before implementation of this feature.
  - Confidence level: 100% for inspected source and installed package versions.

## Method and limits
All runtime state, settings, prompts, and debug extensions were created in system temporary directories. Each normal probe selected a registered fixture model and terminated in the final debug `before_agent_start` handler with exit code 23. The fixture provider throws if called. The council parent invoked the registered tool through a temporary CLI command; the actual participant child terminated in the same debug hook. No model request was made. No prompt was passed in offline mode. Process-local environment overrides left HOME unchanged.

These checks inspected prompt routing and active tools. They did not measure whether a model follows the prompt instructions.

## Assumptions
None for the recorded observations.

## Open questions
None. FND-02 and FND-03 resolve QST-01 for Pi 1.3.0. Post-implementation probes must check prompt preservation and active tools for the same sources.
