# Technical Solution: Template section for agents with workflows in extension `system-prompt`

The system prompt template of pi, `~/.pi/agent/agent-suite/system-prompt/system.md`, holds rules that tell the agent to start workflows, for example "start workflow `HandleDeviation`". Main agents `Simple`, `Guru`, and `ReadOnly` and subagent `SubAgentDeveloperSimple` will get an empty list of workflows, so these rules will name workflows that these agents cannot start. The template has only role sections, `mainAgent` and `childAgent`, and no way to give text only to agents that can start workflows. This task adds such a section, `workflowAgent`, to extension `system-prompt` of `pi-harness`.

## Key definitions and abbreviations

- Agent with workflows. An agent whose active tools include `workflow_activate` when the extension renders the template. The workflow extension makes this tool active only when the policy of the agent allows at least one workflow of the catalog (`resolveWorkflowAvailability` in `pi-package/extensions/workflow/availability.ts`).
- Workflow section. The new template section, `{{#workflowAgent}}...{{/workflowAgent}}`, whose text only an agent with workflows gets.
- Role section. Existing sections `{{#mainAgent}}...{{/mainAgent}}` and `{{#childAgent}}...{{/childAgent}}`, described in section Role sections of `docs/extensions/system-prompt.md`.

## Source Context
- Investigation `docs/log/2026-11-06-workflow-overhead.md` of project `agent-rules-improvement`: requests of pi agents that only call workflow tools take 28% to 44% of the cost of sessions, and main agents without a leading workflow start nested workflows twice as often as Claude Code. The owner of the rules decided to empty the lists of workflows of `Simple`, `Guru`, `ReadOnly`, and `SubAgentDeveloperSimple`, and to give the rules that name workflows only to agents with workflows through a section of the template.
- Rules of the template that name workflows: lines 103, 180, 223, and 230 of `system.md` lie inside `{{#mainAgent}}`, and line 74 lies outside any section. So the workflow section must work inside a role section and outside it.
- Offered workflow tools: the workflow extension kept each workflow tool that it once offered until the end of the session, so that the tool list of later requests keeps the cached request prefix of the provider (section Provider context of `docs/extensions/workflow.md`). After `/agent Auto` and then `/agent Simple` with `workflows: []`, `workflow_activate` stayed active, and the signal of an agent with workflows gave the text of the workflow section to `Simple`. A change of the main agent changes the system prompt, so the cached prefix is lost anyway, and the workflow extension now offers only the applicable tools after such a change.

## Scope
In scope:
- A workflow section that the parser of templates accepts at the top level and inside a role section.
- Selection of the workflow section by whether the agent is an agent with workflows, for main and child processes.
- Tests and the documentation of the extension.
- In the workflow extension: the reset of the offered workflow tools to the applicable ones when the ID of the selected main agent changes.

Out of scope:
- Changes of `~/.pi/agent/agent-suite/system-prompt/system.md` and of agent definitions: the owner of the rules makes them after this task.
- An inverted section for agents without workflows.
- Other changes of the workflow extension, and changes of Claude Code.

## Dependencies and Preconditions
- Working copy: worktree `~/orca/workspaces/pi-harness/pi-fix-workflow-tokens`. List `packages` of `~/.pi/agent/settings.json` names its `pi-package`, so each running pi loads this code. No other agent changes `pi-package/extensions/system-prompt/` during this task. Files `pi-package/extensions/workflow/prompts/*.md` may change in a separate task.
- Rules of the repository: `AGENTS.md` of `pi-harness`.

## Overengineering and Overspecification Considerations
- The task adds one section kind and the nesting of this kind inside a role section, because line 74 of `system.md` lies outside the role sections and lines 103 to 230 inside `{{#mainAgent}}`. It adds no inverted section, no configuration, and no other nesting, because no rule of the template needs them.
- The signal of an agent with workflows is the active tool `workflow_activate`, which the extension already reads through `pi.getActiveTools()`. The task adds no reading of agent definitions or of workflow policy in extension `system-prompt`.
- The workflow extension resets the offered tools only when the ID of the selected main agent changes. Selecting the same agent again keeps the system prompt, so the tool list also stays and keeps the cached prefix.
- Left to the implementer: the name of the section, which follows the style of `mainAgent` and `childAgent`; the structure of the code in `sections.ts` and `index.ts`; the wording of the diagnostics of invalid templates.

## File Structure
- `pi-package/extensions/system-prompt/sections.ts`: parsing and selection of the workflow section.
- `pi-package/extensions/system-prompt/index.ts`: the signal of an agent with workflows in the handler of `before_agent_start`, passed to the selection.
- `pi-package/extensions/system-prompt/index.test.ts`: tests of the new behavior.
- `docs/extensions/system-prompt.md`: description of the workflow section next to section Role sections.
- `pi-package/extensions/workflow/index.ts`: the reset of the offered workflow tools in the listener of the selected-agent change in `registerWorkflowLifecycle`.
- `pi-package/extensions/workflow/index.test.ts`: the test of the reset.
- `docs/extensions/workflow.md`: the condition "until the main agent changes" in each statement that an offered tool remains offered.
- `pi-package/CHANGELOG.md`: entries of both changes under `## [Unreleased]`.

## Code Structure
- `parseTemplateSections`: accepts the workflow section at the top level and inside a role section, and rejects a workflow section inside a workflow section, a role section inside a role section, and unmatched or mismatched markers, as it does for role sections now.
- `selectTemplateSections`: keeps the text of a workflow section only for an agent with workflows, together with the selection by role.
- Handler of `before_agent_start` in `index.ts`: reads whether `workflow_activate` is among the active tools after `composition.reconcileActiveTools()`, as the handler of the workflow extension does in `registerWorkflowLifecycle` of `pi-package/extensions/workflow/index.ts`.
- Listener of `SELECTED_AGENT_CONTRIBUTION_CHANGE_EVENT` in `registerWorkflowLifecycle`: when the ID of the selected agent differs from the previous one, it clears `offeredToolNames` before `refreshTools`, so `reconcileTools` offers only the tools that `resolveWorkflowAvailability` returns for the new agent.

## Work Items
Each item starts with a failing test, by `TDD` of `code-rules`.
- TSK-01: Selection at the top level. Test: template `C{{#W}}X{{/W}}`, where `W` is `workflowAgent`, renders `CX` for a main agent whose active tools include `workflow_activate`, and `C` for a main agent without this tool. The same holds for a child process.
- TSK-02: Selection inside a role section. Test: template `{{#mainAgent}}M{{#W}}X{{/W}}{{/mainAgent}}{{#childAgent}}S{{/childAgent}}` renders `MX` for a main agent with workflows, `M` for a main agent without workflows, and `S` for a child agent with workflows.
- TSK-03: Validation. Test: the extension rejects `{{#W}}{{#W}}X{{/W}}{{/W}}`, `{{#mainAgent}}{{#W}}X{{/mainAgent}}{{/W}}`, and `{{#W}}X`, keeps the original prompt of pi, and reports the issue, as for invalid role sections now.
- TSK-04: Marker-only lines. Test: a line that holds only a marker of the workflow section is removed with its line break, as for role sections.
- TSK-05: Current signal. Test: when the selected agent changes from an agent with workflows to an agent with an empty list of workflows in one session, the next `before_agent_start` renders the template without the text of the workflow section.
- TSK-05.1: Reset of offered tools. Test in the workflow extension: after agent `Auto` with a workflow, agent `Simple` with `workflows: []` has no workflow tools; selecting `Auto` again with `workflows: []` keeps them; an active workflow keeps `workflow_transition` and `workflow_exit` after the change.
- TSK-06: Documentation. `docs/extensions/system-prompt.md` describes the workflow section, its condition, where it may stand, and one example of input and output, in the form of section Role sections.

## Deliverables
- DLV-01: Changes of `sections.ts` and `index.ts` of `system-prompt`, and of `index.ts` of `workflow`.
- DLV-02: Tests of TSK-01 to TSK-05 in `index.test.ts` of `system-prompt`, and of TSK-05.1 in `index.test.ts` of `workflow`.
- DLV-03: The descriptions in `docs/extensions/system-prompt.md` and `docs/extensions/workflow.md`.

## Acceptance Criteria
- ACC-01: The tests of TSK-01, TSK-02, TSK-04, TSK-05, and TSK-05.1 fail before the change and pass after it. The inputs of TSK-03 pass before the change too, because the earlier parser rejects each unknown section name.
- ACC-02: `bun run verify` in the root of the worktree passes after the last change.
- ACC-03: A template without the workflow section renders as before: the existing tests of `index.test.ts` pass without changes of their expected output.
- ACC-04: Run check with a temporary template and a temporary agent. Copy `~/.pi/agent/agent-suite/agent-selection/agents/Simple.md` to `WfSectionCheck.md` in the same directory with `workflows: []`, and point field `templateFile` of `~/.pi/agent/agent-suite/system-prompt/config.json` to a copy of `system.md` with text in the workflow section. Each new session of pi on this machine reads this configuration, so get the approval of the owner of the rules before this change. A new session of pi with agent `WfSectionCheck` gives a system prompt without this text, and a session with agent `Auto` gives it with this text. The system prompt of a session is field `sections` of the first message with role `system` in its log in `~/.pi/agent/sessions/`. After the check, remove `WfSectionCheck.md`, the copy of the template, and the change of the configuration.

## Constraints and Risks
- Each running pi loads this worktree, so an error of the parser falls back to the original prompt of pi in each new session; impact: HIGH, every agent loses the rules of the template until the fix.
- A session restored with an active workflow and an agent with an empty list has `workflow_transition` and `workflow_exit` without `workflow_activate`, so it gets no text of the workflow section; impact: LOW, such a session continues the active workflow by the records of the workflow extension.

## Assumptions

No assumptions. The reconciliation of active tools before the handler of `before_agent_start` of extension `system-prompt` is checked by the tests of TSK-05 and TSK-05.1 and by the run check of ACC-04.

## Open Questions

No open questions.

## References
- `pi-package/extensions/system-prompt/sections.ts`, `index.ts`, `index.test.ts` - the parser, the selection, and the tests of role sections.
- `docs/extensions/system-prompt.md`, section Role sections - the documented behavior of role sections.
- `pi-package/extensions/workflow/availability.ts`, `resolveWorkflowAvailability` - when `workflow_activate` is active.
- `pi-package/shared/workflow-policy.ts`, `resolveWorkflowPolicy` - a missing field `workflows` allows each workflow, and an empty list allows none.
