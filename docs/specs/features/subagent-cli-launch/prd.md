# Idea: Launch of a subagent from the command line

## Definitions
Terms of this feature are in [terms.md](terms.md): subagent definition, supervised child process, external launcher, and agent role.

## Context and Problem
[problem.md](problem.md).

## Goal
- An external launcher runs a subagent definition in a Pi process, and the agent works by this definition in the same way as a subagent of run-subagent.
- Each delegated agent has one definition.
- The external launcher learns that Pi could not apply the requested agent before the agent starts any work.

## Scenarios
1. An external launcher starts Pi in RPC mode for a subagent definition, sends a task, and reads the result.
2. The agent of scenario 1 activates a workflow that its definition allows and starts a subagent that its definition lists as callable.
3. The external launcher names an agent that Pi cannot apply, for example an ID without a definition.
4. A Pi main agent starts the same definition through run-subagent.

## Scope and Non-Scope
In scope:
- a CLI option that runs one subagent definition in a Pi process;
- the agent role of such a process;
- the error that the external launcher gets when Pi cannot apply the requested agent;
- the documentation of the extensions that change.

Out of scope:
- supervised child processes of run-subagent and convene-council;
- selection of main agents through `/agent` and `--agent`, including an unknown ID passed to `--agent`;
- the place where the external launcher stores sessions of the agents that it starts.

## Requirements

### Functional Requirements
- [X] FRQ-01: When an external launcher starts Pi with the ID of a subagent definition in CLI flag `--subagent`, the agent works by this definition: its prompt, model, thinking level, tools, allowed workflows, and callable subagents.
  - Origin: source. Desired State in [problem.md](problem.md). The separate flag `--subagent` is a constraint of the task: the launch of a main agent and the launch of a subagent are separate CLI options, so `--agent` keeps the meaning of main-agent selection.
  - Goal: an external launcher runs a subagent definition, and each delegated agent has one definition.
  - Goal achievement: Full. The external launcher names the same definition that run-subagent uses, so no copy with `type: main` is needed.
  - Feasibility: Confirmed. The package already applies each of these parts of a definition: run-subagent applies the prompt and tools in its child processes, and the selection of a main agent applies the model, thinking level, tools, workflows, and callable subagents at the start of a session.
- [X] FRQ-02: A process started with `--subagent` gets the child-agent sections of the system prompt template and does not get the main-agent sections.
  - Origin: formulated. Observed Problem in [problem.md](problem.md): an agent of an external launcher gets the main-agent rules.
  - Goal: the agent works in the same way as a subagent of run-subagent.
  - Goal achievement: Full. The agent gets the same template sections as a subagent of run-subagent.
  - Feasibility: Confirmed. Extension system-prompt builds the system prompt before each run of the agent, when the definition of the agent is already applied.
- [X] FRQ-03: In a process started with `--subagent`, the selection of main agents changes nothing in the agent: neither the main agent saved for the session nor flag `--agent` replaces or extends the subagent definition. When both `--agent` and `--subagent` are given, Pi reports an error and the agent does no work.
  - Origin: source. The task constrains the selection of main agents to take no part in the launch of a subagent. The error for both flags follows from this constraint and FRQ-01, because the two flags name two different agents.
  - Goal: the agent works by its own definition.
  - Goal achievement: Full. Only the subagent definition shapes the agent.
  - Feasibility: Confirmed. The selection of main agents already skips its work in supervised child processes, and it can skip it by the same rule for a process with `--subagent`.
- [X] FRQ-04: When Pi cannot apply the agent named by `--subagent`, the external launcher gets an error with the reason before the agent handles the first task, in RPC and print modes. Examples of such a case: no definition has this ID, the definition has `type: main`, or the model of the definition is unavailable.
  - Origin: source. Impact `HIGH` in [problem.md](problem.md): today the process continues without the agent.
  - Goal: the external launcher learns that Pi could not apply the requested agent before the agent starts any work.
  - Goal achievement: Full. The agent handles no task without its definition.
  - Feasibility: Confirmed. The selection of main agents already holds incoming input until the start of a session settles, so the extension that applies the subagent definition can report the error before the first task.
- [X] FRQ-05: The agent of a process started with `--subagent` has delegation depth 1, the depth of a direct child of a Pi main agent. It can start the callable subagents of its definition only when the depth limit of run-subagent allows delegation from depth 1. Example: with limit 1, the agent has no subagent tools; with limit 3, it starts its callable subagents at depth 2.
  - Origin: source. The task requires the same depth as in a launch of the same definition by a Pi main agent through run-subagent.
  - Goal: the agent works in the same way as a subagent of run-subagent, including delegation.
  - Goal achievement: Full. The depth limit gives the agent the same delegation as a direct child of a Pi main agent.
  - Feasibility: Confirmed. run-subagent already computes the delegation of a process from its depth, and a supervised child process gets depth 1 from its parent.

### Non-Functional Requirements
- [X] NRQ-01: Processes without `--subagent` keep their behavior: the agent that they run, its role sections, tools, workflows, usage records, and notifications. This includes supervised child processes of run-subagent and convene-council and main agents selected through `/agent` or `--agent`. Verification: the existing tests of the changed extensions pass, and a real Pi run of a main agent and of a subagent of run-subagent shows the same system prompt and active tools as before the change.
  - Origin: formulated. Problem Boundary in [problem.md](problem.md) excludes these processes.
  - Goal: the change adds a way to launch an agent and keeps the existing ways.
  - Goal achievement: Full. Each existing process keeps its prompt, tools, and role.
  - Feasibility: Confirmed. The new behavior applies only when the new flag is given.

## Open Questions
None.

## Technical Supplement
Facts of the package for the technical solution:
- run-subagent applies a subagent definition in its child: `buildSubagentsPrompt` adds the agent prompt by `PI_SUBAGENT_AGENT_ID`, and `applyChildToolPolicy` applies `PI_SUBAGENT_TOOL_PATTERNS` (`pi-package/extensions/run-subagent/agent-policy.ts`). The parent passes the model and thinking level by flags `--model` and `--thinking` (`buildChildArgs` in `pi-package/extensions/run-subagent/invocation-process.ts`).
- In a process without `PI_AGENT_SUITE_CHILD_AGENT_PROCESS`, extension workflow reads the allowed workflows from the selected agent of `agent-runtime-composition` (`pi-package/extensions/workflow/index.ts`). Only main-agent-selection fills this slot now, by `setMainAgentContribution`.
- main-agent-selection skips session start and shutdown when `isChildSubagentProcess` finds `PI_SUBAGENT_AGENT_ID` (`pi-package/extensions/main-agent-selection/environment.ts`).
- Extension system-prompt chooses the agent role once when it loads (`systemPrompt` in `pi-package/extensions/system-prompt/index.ts`) and renders the template in `before_agent_start`.
- run-subagent reads the delegation depth of a process from `PI_SUBAGENT_DEPTH`, and its parent sets this variable in `spawnWorkerProcess` (`pi-package/extensions/run-subagent/invocation-supervisor.ts`). A process without the variable has depth 0.
- Extensions usage, knowledge, footer, cmux, completion-sound, workflow, and algorithms read `PI_AGENT_SUITE_CHILD_AGENT_PROCESS` as a sign of a Pi parent. A process with `--subagent` has no Pi parent.

## References
- [docs/extensions/run-subagent.md](../../../extensions/run-subagent.md)
- [docs/extensions/main-agent-selection.md](../../../extensions/main-agent-selection.md)
- [docs/extensions/system-prompt.md](../../../extensions/system-prompt.md)
