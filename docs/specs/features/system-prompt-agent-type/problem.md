# Problem Statement

## Key definitions and abbreviations
- **Main agent:** the agent of a Pi session that a person runs and talks to.
- **Subagent:** an agent in a child Pi process that `run-subagent` starts. It works on a task of another agent and returns its result to that agent.
- **Council participant:** an agent in a child Pi process that `convene-council` starts with its own system prompt. It answers the council loop of the extension.
- **Custom prompt:** a session's system prompt supplied through CLI `--system-prompt` text or a file, a trusted project's `.pi/SYSTEM.md`, or the Pi agent directory's `SYSTEM.md`. A person or the extension starting the process supplies the prompt, for example `convene-council` for its participants. When the CLI flag is absent, Pi checks the trusted-project file before the agent-directory file.
- **Bundled template:** the system prompt template `pi-package/extensions/system-prompt/prompts/system.md` that extension `system-prompt` uses when its config names no `templateFile`.
- **Conversation rules:** rules of the bundled template that describe work with a person: blocks `<goal_guard>`, `<scope_control>`, and `<interaction_and_writing>` with `<formatting>` and `<user_communication>`.

## Context
With the bundled template, the harness supplies conversation rules and safety rules to users who install the package without custom agents or a custom template. Therefore, edits to the bundled template affect the instructions these users' agents receive.

The conversation rules are written for an agent that talks to a person. Example: block `<questions>` requires a question template with options, and after a question the agent ends its turn and waits for the answer.

## Observed Problem
Before UNT-01, `system-prompt` rendered the bundled template for every session with a ready template. Some rules were inappropriate for the receiving agent's role:
1. Each subagent receives the conversation rules, although it works on a task of another agent and returns its result to it.
2. Each session with a custom prompt received the rendered template in place of that prompt. Examples include a council participant and a person running `pi --system-prompt "Answer only in JSON"`.
3. Main agents report a defect outside their task so briefly that the person does not learn what is broken. Rule 3 of `<scope_control>` requires a report and does not state what the report contains.

## Affected Audience
- Users who run the harness with the bundled template: they can miss defects their agents discover, and their subagents receive rules intended for another role.
- Users of custom-prompt sessions, including council sessions: before UNT-01, their agents received the rendered template in place of the custom prompt.
- Main agents of these users, which receive the results of subagents and of the council.
- The maintainer of the harness, who cannot give a rule to main agents only or to subagents only.

## Evidence
- `pi-package/extensions/system-prompt/index.ts`, `systemPrompt`: before UNT-01, the ready-template handler returned a replacement for every session. The handler still performs no process-kind classification; that work is planned for UNT-02.
- `docs/extensions/run-subagent.md`, section "Additional extensions": child processes of `run-subagent` load `pi-package` in each mode of extension loading, so each subagent runs extension `system-prompt`.
- Custom prompts, from the code of Pi, of `system-prompt`, and of `convene-council`:
  - Pi passes the custom prompt to the prompt options as `customPrompt` (`core/agent-session.js` of `@earendil-works/pi-coding-agent`). It takes the text from flag `--system-prompt`, or from a file `SYSTEM.md` when the flag is absent (`core/resource-loader.js`, function `discoverSystemPromptFile`). A `systemPrompt` that a handler of `before_agent_start` returns replaces the whole prompt (`core/extensions/runner.js`).
  - `SUPPORTED_TEMPLATE_VARIABLES` in `pi-package/extensions/system-prompt/index.ts` contains no custom-prompt variable. Before UNT-01, the handler replaced Pi's prompt without incorporating `customPrompt`.
  - `convene-council/startup.ts`, functions `resolveChildStartupPlan` and `buildChildParticipantStartupFromToolArgs`: the child process of a participant gets the extension flags of the parent process and the participant prompt by flag `--system-prompt`. So it loads `system-prompt` when the parent session loads it.
- The bundled template contains, for example, these conversation rules:
  - `<questions>`: "After you ask question, end turn".
  - `<scope_control>`, rule 2: "Do not limit investigation to requested change scope. Investigate related areas when they can materially affect task or reveal relevant findings".
  - `<scope_control>`, rule 3: "Report relevant out-of-scope findings and proposed changes".
  - `<brevity>`, rule 6: "Each finding, fact, and argument states its effect on task ... When fact has no effect, do not include it".
- In the session described in the task, a subagent reported a defect outside the task with its file, triggering condition, and proposed separate fix. The main agent reduced the finding to one line, called the defect a limitation, omitted the user-visible behavior, and dropped the proposed fix. The person learned what was broken only after three questions. That session used rule 3 of `<scope_control>` and rule 6 of `<brevity>`.

## Impact
- The person does not learn about a defect that an agent found outside the task, or learns about it only after several questions. A critical defect stays unfixed.
- A subagent may answer its caller with a question in the template for a person and end its turn. The main agent then spends a turn to continue the subagent.
- A subagent may investigate areas beyond its task by rule 2 of `<scope_control>`. The user then spends time and tokens on work that the main agent did not request.
- Before UNT-01, council participants received the rendered template without their role instructions. This could reduce the quality of the council's answer.
- Before UNT-01, users of custom prompts received the rendered template in place of their instructions.

## Current State
UNT-01 now preserves custom prompts. The remaining role-selection and bundled-rule work is planned for UNT-02. [facts.md](facts.md) records the pre-implementation observations.

- Extension `system-prompt` takes the template from `templateFile` of its config, or the bundled template when the config file is missing.
- The bundled template has one text for all sessions. Its blocks fall into two groups:
  - blocks for any agent: `<system>`, `<role>`, `<safety>`, `<execution_limits>`, `<skills>`, `{{toolsets}}`, and `<tool_guidelines>`;
  - the conversation rules.
- The template syntax has no way to include a block only for some kind of session.
- The bundled template has no rule that tells a subagent what to do with a defect outside its task.
- For a nonempty custom prompt, the ready-template handler reconciles active tools and returns no replacement. Runtime composition still appends selected-agent and eligible tool prompt contributions. Disabled and invalid-template handlers also return no replacement.
- For sessions using the template, Pi's `--append-system-prompt` input reaches the rendered template through `{{appendSystemPrompt}}`.
- Extensions `ask-llm` and `consult-advisor` call the model directly by function `completeSimple` with their own system prompt, without a child Pi process. The template does not reach them.
- The package marks child processes by environment variables:
  - `PI_AGENT_SUITE_CHILD_AGENT_PROCESS` in `pi-package/shared/child-agent-environment.ts` marks child processes of `run-subagent` and of `convene-council`;
  - `PI_SUBAGENT_AGENT_ID` in `pi-package/shared/subagent-environment.ts` marks only child processes of `run-subagent`. Function `isChildSubagentProcess` of `main-agent-selection` checks it.
- Extension `system-prompt` reads neither variable.
- Before UNT-01, real Pi checks after rebase onto `main` captured the final system prompt and active tools with temporary state and a debug extension. CLI `--system-prompt`, trusted-project `.pi/SYSTEM.md`, and agent-directory `SYSTEM.md` each populated `customPrompt`; the final prompt omitted that text and contained the bundled conversation rules. A real `convene_council` invocation started a participant with a 3830-character custom prompt and active tool `read`; its final prompt also omitted the custom prompt and contained the conversation rules. The debug hook stopped each participant before a model request. See [facts.md](facts.md), FND-02 and FND-03.

## Desired State
- A main agent of a user without custom agents gets the conversation rules. When it finds a defect outside its task, the person learns from its message what is broken, why, and what fix the agent proposes.
- A subagent gets only the rules that fit work on a task of another agent, and it reports each defect outside its task to its caller.
- Each session with a custom prompt works by this prompt, for example a council participant.
- Main agents of existing users keep the behavior that the conversation rules give now, except the rules that this task corrects.

## Problem Boundary
- In scope: the content and the structure of the bundled template, that is, which rules each kind of session gets and the text of rules that fail in their role.
- In scope: sessions of main agents and of subagents, and each session with a custom prompt.
- Out of scope: `ask-llm` and `consult-advisor`, because they start no child Pi process.
- Out of scope: the text of custom templates of users. A custom template keeps its rendered text in each session without a custom prompt.

## Assumptions
- The consequences for subagents in Impact follow from the text of the rules. Nobody has checked sessions of subagents with the bundled template for them.
- The checks establish prompt routing and active-tool availability. They do not establish how often a model follows the conversation rules in a child session or the quality of a council answer.

## Open Questions
None. The pre-implementation real Pi checks in [facts.md](facts.md) resolve QST-01. In those checks, the extension replaced CLI, trusted-project, agent-directory, and council participant custom prompts with the rendered template.
