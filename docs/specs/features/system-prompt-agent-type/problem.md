# Problem Statement

## Key definitions and abbreviations
- **Main agent:** the agent of a Pi session that a person runs and talks to.
- **Subagent:** an agent in a child Pi process that `run-subagent` starts. It works on a task of another agent and returns its result to that agent.
- **Council participant:** an agent in a child Pi process that `convene-council` starts with its own system prompt. It answers the council loop of the extension.
- **Custom prompt:** the own system prompt that Pi takes for a session from flag `--system-prompt`, or, without the flag, from file `.pi/SYSTEM.md` of a trusted project or from file `SYSTEM.md` of the Pi agent directory. A person or an extension that starts the process sets it, for example `convene-council` for its participants.
- **Bundled template:** the system prompt template `pi-package/extensions/system-prompt/prompts/system.md` that extension `system-prompt` uses when its config names no `templateFile`.
- **Conversation rules:** rules of the bundled template that describe work with a person: blocks `<goal_guard>`, `<scope_control>`, and `<interaction_and_writing>` with `<formatting>` and `<user_communication>`.

## Context
The bundled template gives the harness its default behavior: a person who installs the package without own agents or own template gets the conversation rules and the safety rules from it. Some users run the harness with the bundled template and have no custom version, so each change of this template changes the behavior of their agents.

The conversation rules are written for an agent that talks to a person. Example: block `<questions>` requires a question template with options, and after a question the agent ends its turn and waits for the answer.

## Observed Problem
The bundled template is one text for every Pi session that loads extension `system-prompt`, and part of its rules fail in the role of the agent that reads them:
1. Each subagent receives the conversation rules, although it works on a task of another agent and returns its result to it.
2. Each session with a custom prompt receives the rendered template in place of this prompt. Examples: a council participant, and a person who runs `pi --system-prompt "Answer only in JSON"`.
3. Main agents report a defect outside their task so briefly that the person does not learn what is broken. Rule 3 of `<scope_control>` requires a report and does not state what the report contains.

## Affected Audience
- Users who run the harness with the bundled template: they miss defects that their agents found, and their subagents and council participants work by rules of another role.
- People who run Pi with a custom prompt: the agent does not follow this prompt.
- Main agents of these users, which receive the results of subagents and of the council.
- The maintainer of the harness, who cannot give a rule to main agents only or to subagents only.

## Evidence
- `pi-package/extensions/system-prompt/index.ts`, handler of `before_agent_start`: the extension renders one template for each session in which the template is loaded. The handler does not check what kind of session it serves.
- `docs/extensions/run-subagent.md`, section "Additional extensions": child processes of `run-subagent` load `pi-package` in each mode of extension loading, so each subagent runs extension `system-prompt`.
- Custom prompts, from the code of Pi, of `system-prompt`, and of `convene-council`:
  - Pi passes the custom prompt to the prompt options as `customPrompt` (`core/agent-session.js` of `@earendil-works/pi-coding-agent`). It takes the text from flag `--system-prompt`, or from a file `SYSTEM.md` when the flag is absent (`core/resource-loader.js`, function `discoverSystemPromptFile`). A `systemPrompt` that a handler of `before_agent_start` returns replaces the whole prompt (`core/extensions/runner.js`).
  - The template variables of `system-prompt` have no variable for `customPrompt` (list `SUPPORTED_TEMPLATE_VARIABLES` in `index.ts`), so the rendered template contains no custom prompt.
  - `convene-council/startup.ts`, functions `resolveChildStartupPlan` and `buildChildParticipantStartupFromToolArgs`: the child process of a participant gets the extension flags of the parent process and the participant prompt by flag `--system-prompt`. So it loads `system-prompt` when the parent session loads it.
- The bundled template contains, for example, these conversation rules:
  - `<questions>`: "After you ask question, end turn".
  - `<scope_control>`, rule 2: "Do not limit investigation to requested change scope. Investigate related areas when they can materially affect task or reveal relevant findings".
  - `<scope_control>`, rule 3: "Report relevant out-of-scope findings and proposed changes".
  - `<brevity>`, rule 6: "Each finding, fact, and argument states its effect on task ... When fact has no effect, do not include it".
- A Pi session with the same rules 3 of `<scope_control>` and 6 of `<brevity>`: a subagent that reviewed code reported a defect outside the task with its file and condition and proposed a separate fix. The main agent reduced it to one line of its final report, called the defect a limitation, showed no behavior that the person sees, and dropped the proposed fix. The person learned what was broken only after three questions.

## Impact
- The person does not learn about a defect that an agent found outside the task, or learns about it only after several questions. A critical defect stays unfixed.
- A subagent may answer its caller with a question in the template for a person and end its turn. The main agent then spends a turn to continue the subagent.
- A subagent may investigate areas beyond its task by rule 2 of `<scope_control>`. The user then spends time and tokens on work that the main agent did not request.
- A council participant works without the instructions of its role, so the council may give a worse answer.
- A person who runs Pi with a custom prompt gets an agent that ignores this prompt and follows the rendered template.

## Current State
- Extension `system-prompt` takes the template from `templateFile` of its config, or the bundled template when the config file is missing.
- The bundled template has one text for all sessions. Its blocks fall into two groups:
  - blocks for any agent: `<system>`, `<role>`, `<safety>`, `<execution_limits>`, `<skills>`, `{{toolsets}}`, and `<tool_guidelines>`;
  - the conversation rules.
- The template syntax has no way to include a block only for some kind of session.
- The bundled template has no rule that tells a subagent what to do with a defect outside its task.
- Pi keeps the custom prompt as the start of its own system prompt when extension `system-prompt` is disabled by `"enabled": false` or cannot read its template. The text of flag `--append-system-prompt` reaches the rendered template through variable `{{appendSystemPrompt}}`.
- Extensions `ask-llm` and `consult-advisor` call the model directly by function `completeSimple` with their own system prompt, without a child Pi process. The template does not reach them.
- The package marks child processes by environment variables:
  - `PI_AGENT_SUITE_CHILD_AGENT_PROCESS` in `pi-package/shared/child-agent-environment.ts` marks child processes of `run-subagent` and of `convene-council`;
  - `PI_SUBAGENT_AGENT_ID` in `pi-package/shared/subagent-environment.ts` marks only child processes of `run-subagent`. Function `isChildSubagentProcess` of `main-agent-selection` checks it.
- Extension `system-prompt` reads neither variable.

## Desired State
- A main agent of a user without own agents gets the conversation rules. When it finds a defect outside its task, the person learns from its message what is broken, why, and what fix the agent proposes.
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
- The loss of the custom prompt follows from the code of Pi and of `system-prompt`. Nobody has checked it by a run.

## Open Questions
- **QST-01:** Does a session with a custom prompt get the rendered template in place of this prompt in a real run? Purpose: confirm the conclusion that the code gives, before the solution is designed. During the work on this task, check it by a real experiment: run Pi with `--system-prompt` and run `convene-council`, both with a temporary extension that dumps the final system prompt of the session. Without an answer, the solution may fix a case that does not occur.
