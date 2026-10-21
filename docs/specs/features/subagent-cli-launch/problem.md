# Problem Statement

## Key definitions and abbreviations
- **Subagent definition:** an agent definition with `type: subagent` or `type: both`. run-subagent starts it in a child Pi process.
- **Supervised child process:** a Pi process that run-subagent or convene-council starts and controls. These extensions mark it with `PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1`.
- **External launcher:** a program outside Pi that starts a Pi process to run one agent and reads its result, for example another agent harness that drives Pi in RPC mode.
- **Agent role:** the kind of agent that a process runs, main agent or child agent. Extension system-prompt chooses the role sections `{{#mainAgent}}` and `{{#childAgent}}` of its template by the agent role.

## Context
An external launcher can delegate a task to a Pi agent in the same way as a Pi main agent delegates it through run-subagent. Such an agent works on a task of another agent and returns its result to that agent, so it needs the same definition and the same child-agent rules as a subagent that run-subagent starts.

Pi offers one CLI way to choose an agent: flag `--agent <id>` of main-agent-selection. Its documentation in `docs/extensions/main-agent-selection.md` describes it as the selection of a main agent.

## Observed Problem
An external launcher cannot run a subagent definition in a Pi process. A user who needs it creates a second definition of the same agent with `type: main`. The process then runs as a main agent and gets the main-agent sections of the system prompt template. The user keeps the two definitions of one agent in sync.

## Affected Audience
- Users who delegate tasks from an external launcher to Pi agents. They maintain a copy of each delegated agent as a main agent.
- External launchers that receive the result of such an agent. With a custom template that has role sections, the agent gets rules for a conversation with a person, for example the question template and the rule to end the turn after a question.
- Authors of custom templates. They cannot move rules for child agents into `{{#childAgent}}`, because an agent started by an external launcher does not get this section.

## Evidence
- A run of `pi --agent <id> --mode rpc --no-session` for a definition with `type: subagent` and a `get_state` request: Pi sent the notification `[main-agent-selection] agent <id> was not found` with type `warning` and answered `get_state` with success and the default model of the user settings.
- `pi-package/extensions/main-agent-selection/index.ts`:
  - `loadSelectableAgents` keeps only definitions with `type: main` or `type: both`, and `applyEphemeralAgent` searches flag `--agent` among them;
  - when `applyEphemeralAgent` finds no definition, it reports the issue and returns without applying an agent;
  - `handleSessionStart` returns at once in a process with `PI_SUBAGENT_AGENT_ID`, so a supervised child process of run-subagent ignores `--agent`.
- `pi-package/extensions/run-subagent/invocation-supervisor.ts`, `spawnWorkerProcess`: run-subagent passes the agent ID, tool patterns, workflow IDs, depth, and a runtime lease to its child through environment variables, and keeps a Node IPC channel to it. The child applies the agent prompt and tool policy from these variables, for example in `buildSubagentsPrompt` and `applyChildToolPolicy` of `pi-package/extensions/run-subagent/agent-policy.ts`. An external launcher has no part in this protocol.
- `pi-package/extensions/system-prompt/index.ts`, `systemPrompt`: the extension chooses the agent role once when it loads, from `PI_AGENT_SUITE_CHILD_AGENT_PROCESS`.
- Other extensions read the same marker as a sign of a parent process. For example, `readWorkflowPolicyEnvironment` of `pi-package/extensions/workflow/environment.ts` then takes the allowed workflows from `PI_SUBAGENT_WORKFLOW_IDS`, and usage takes the agent ID and root session ID from variables of run-subagent. So an external launcher that sets the marker breaks workflow activation of its agent.

## Impact
- `HIGH`: when an external launcher passes the ID of a subagent definition to `--agent`, the process continues without the agent. Its result comes from the default model without the agent prompt and without the tool restrictions of the definition, for example an agent intended for reading gets tools that change files. The launcher learns about it only if it handles the `warning` notification.
- `MEDIUM`: two definitions of one agent diverge after an edit of one of them, and the external launcher gets an agent that behaves differently from the subagent of run-subagent.
- `MEDIUM`: with a custom template that has role sections, an agent of an external launcher gets the main-agent rules. It may answer its caller with a question for a person and end the turn, or investigate areas outside its task.

## Current State
- Flag `--agent` applies only definitions with `type: main` or `type: both`, and the process runs with the main-agent role.
- run-subagent applies a subagent definition only in its own supervised child processes.
- Extension system-prompt gives the child-agent role only to supervised child processes, by `PI_AGENT_SUITE_CHILD_AGENT_PROCESS`.
- A process without this marker behaves as a root process for usage, workflow, knowledge, footer, cmux, and completion-sound.

## Desired State
- An external launcher runs a subagent definition in a Pi process, and the agent works by this definition in the same way as a subagent of run-subagent: the same prompt, model, thinking level, tools, workflows, callable subagents, and child-agent rules of the system prompt template.
- Each delegated agent has one definition.
- The external launcher learns that Pi could not apply the requested agent before the agent starts any work.

## Problem Boundary
- In scope: Pi processes that an external launcher starts to run one subagent definition, in each Pi mode.
- Out of scope: supervised child processes of run-subagent and convene-council, because they already get their definitions and roles.
- Out of scope: selection of main agents through `/agent` and `--agent`, including an unknown ID passed to `--agent`.

## Assumptions
- The consequences of the main-agent rules for an agent of an external launcher follow from the text of these rules. Nobody has checked how often a model follows them in such a session.
- In the run from Evidence, the absence of the agent prompt and of tool restrictions follows from `applyEphemeralAgent`. The run did not dump the system prompt or the active tools.

## Open Questions
None.
