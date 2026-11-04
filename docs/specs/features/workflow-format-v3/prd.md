# Idea: Nested workflows

## Definitions
- Nested process: a process that an agent runs inside a stage of a workflow, after which the agent continues the same stage.
- Nested workflow: a workflow that runs a nested process.
- Parent workflow: the workflow in whose stage the agent starts a nested workflow.
- Chain of running workflows: the parent workflows and the nested workflows that run at one moment, from the first started one to the last one.

## Context and Problem
Problem statement: [problem.md](problem.md). Only a part of the processes that agents must follow fits into the deterministic workflow mechanism: nested processes stay outside it, and agents skip their steps or mix them with the stages of the parent workflow.

## Goal
Each process that agents must follow, nested processes included, runs under the deterministic workflow mechanism, and the harness tracks its steps as it tracks the stages of a workflow.

## Affected Scenarios
- An agent checks the result of a stage by a nested process before it leaves the stage.
- An agent handles a defect that it found during a stage by a nested process, and the handling either lets it continue the stage or shows that the work needs another workflow.
- A nested process starts another nested process inside one of its steps.
- An agent without an active workflow runs a nested process.
- A session with running nested workflows is reloaded, navigated to another branch, or compacted.

## Scope and Non-Scope
In scope:
- Catalog workflows and workflows created through `workflow_create`.
- Main agents and subagents, with the workflows that their definitions allow.
- Restoration of workflow state after session reload, branch navigation, and compaction.

Out of scope:
- Which processes of a particular set of rules become nested workflows.
- Changes of workflow files of formats 1 and 2.

## Requirements

### Functional Requirements
- [X] FRQ-01: While a stage of a workflow is active, an agent can start a workflow that is intended for nested run; the harness then tracks the stages of this nested workflow, and the parent workflow stays on its stage.
  - Origin: formulated. Desired state of the problem: nested processes run under the deterministic mechanism.
  - Goal: steps of nested processes are tracked.
  - Goal achievement: Partial. The steps are tracked; FRQ-02 and FRQ-03 keep them apart from the stages of the parent workflow.
  - Feasibility: Confirmed. The extension already tracks the stages of a workflow; it holds one workflow state now, and nothing outside the extension limits the number of states.
- [X] FRQ-02: While a nested workflow runs, the agent cannot take a transition of any parent workflow.
  - Origin: formulated. Problem: agents take transitions of the parent workflow in the middle of a nested process.
  - Goal: steps of a nested process do not mix with the stages of the parent workflow.
  - Goal achievement: Full. A transition of the parent workflow is impossible until the nested workflow ends.
  - Feasibility: Confirmed. The extension decides which transitions are available.
- [X] FRQ-03: When a nested workflow ends, the agent continues, in the same agent run, the stage of the parent workflow from which it started the nested workflow, and the transitions of this stage are available again.
  - Origin: formulated. Definition of a nested process: after it, the agent continues the same stage.
  - Goal: the parent workflow continues where the nested process interrupted it.
  - Goal achievement: Full.
  - Feasibility: Confirmed. Today a workflow ends only when an agent run settles; the return within a run needs a new way to end a workflow, which FRQ-08 gives.
- [X] FRQ-04: A nested workflow can start further nested workflows, at any depth.
  - Origin: source. Nested processes start other nested processes inside their steps, for example a check of a result starts a research of open questions.
  - Goal: each nested process runs under the mechanism, also one that another nested process starts.
  - Goal achievement: Full.
  - Feasibility: Confirmed. Follows from FRQ-01 applied to a nested workflow.
- [X] FRQ-05: The harness rejects the start of a workflow that already runs in the chain of running workflows.
  - Origin: source. Decision of the requester: the repeated starts that existing nested processes make come from how these processes are written, and a rejection replaces the manual guards against cycles in them.
  - Goal: the chain of running workflows has no cycles.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The extension already excludes the workflow of the saved state from the activation options.
- [X] FRQ-06: A workflow that is intended for nested run can also start when no workflow is active, and after it ends the agent works without a workflow.
  - Origin: formulated. Agents without a workflow follow the same nested processes; without this, such a process needs a second copy outside the mechanism.
  - Goal: one copy of each nested process serves agents with and without a workflow.
  - Goal achievement: Full.
  - Feasibility: Confirmed. Today a workflow starts when no workflow is active.
- [X] FRQ-07: When an agent starts a workflow that is not intended for nested run, each running workflow of the chain ends, at any depth.
  - Origin: source. Decision of the requester: a nested process can show that the work needs another process, for example development instead of analysis, which replaces the whole chain.
  - Goal: the start of a whole-task process leaves no running nested process behind.
  - Goal achievement: Full.
  - Feasibility: Confirmed. Today activation replaces the workflow state.
- [X] FRQ-08: An agent can leave any running workflow at any stage. Leaving a nested workflow returns the agent to the stage of its parent workflow as FRQ-03 describes; leaving the first workflow of the chain leaves the agent without a workflow.
  - Origin: source. Decision of the requester: entry into a workflow must not be one-way. Formulated part: while a nested workflow runs, FRQ-02 blocks the parent workflow, so a nested workflow that was started by mistake or no longer fits would hold the agent until its final stage.
  - Goal: the agent ends a nested workflow on its final stage within the run, and is not trapped in a workflow that does not fit.
  - Goal achievement: Full.
  - Feasibility: Confirmed. No tool leaves a workflow today; the extension registers its own tools.
- [X] FRQ-09: For each transition and each exit, the agent states the facts that justify it, and the harness refuses a transition or an exit without such a statement.
  - Origin: source. Decision of the requester: the agent takes each move as a conscious decision. Problem: an agent that moves only by a tool call passed the checks of stage exits.
  - Goal: the agent does not pass tracked steps formally.
  - Goal achievement: Partial. The harness checks that a statement exists, and the model decides its content.
  - Feasibility: Confirmed. The extension defines the input of its tools and can check the format of the active workflow.
- [X] FRQ-10: An agent can start a nested workflow only when its definition allows this workflow, as for any other workflow.
  - Origin: source. Decision of the requester: the list of allowed workflows stays the only access mechanism.
  - Goal: each agent runs only the nested processes that its definition gives it.
  - Goal achievement: Full.
  - Feasibility: Confirmed. Agent definitions already restrict workflows by their IDs.
- [X] FRQ-11: After session reload, branch navigation, and compaction, the chain of running workflows is the same as before, with the active stage of each workflow.
  - Origin: formulated. Without it, a nested process loses its tracking after these events, and the problem returns.
  - Goal: tracking of nested processes survives the life of a session.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The extension already restores one workflow state from session entries after these events.
- [X] FRQ-12: Workflow files of formats 1 and 2 load without errors, and such a workflow behaves as a workflow of format 3 that is not intended for nested run and has no kind.
  - Origin: source. Decision of the requester: files of earlier formats keep loading, and the behavior of all workflows follows one set of rules, so that the harness stays consistent and simple.
  - Goal: users with files of earlier formats change nothing in their files.
  - Goal achievement: Full.
  - Feasibility: Confirmed. Format 2 already relates to format 1 this way: it adds fields to the file, and both formats follow the same rules of transitions.
- [X] FRQ-13: `workflow_create` creates each workflow in the latest format version, format 3.
  - Origin: source. Request: a workflow that an agent creates through the tool always uses the latest format.
  - Goal: workflows that agents create can use nested runs and kinds like catalog workflows.
  - Goal achievement: Full.
  - Feasibility: Confirmed. `workflow_create` already fixes the format of a created workflow, format 2 today.
- [X] FRQ-14: At each change of the chain of running workflows, that is, a start of a nested workflow, its end, an exit, a start that ends the chain, and the end of the last workflow, the agent learns which workflow and stage are active now, what this stage requires, which transitions are available from it, and which workflows of the chain wait for a return; when no workflow runs any more, the agent learns this.
  - Origin: source. Request: the agent must be informed consistently when the active workflow changes and when it returns to an earlier one.
  - Goal: after each change of the chain, the agent works by the stage that the harness tracks.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The extension already informs the agent at activation, stage entry, completion, and after compaction.

- [X] FRQ-15: Authors define kinds of workflows, each with an ID and a description, apart from the workflow files; a workflow of format 3 may name its kind; the agent sees the workflows that it may activate grouped by kind, with the description of each kind. The kind changes no other behavior of the harness.
  - Origin: source. Decision of the requester, a mandatory constraint: the agent must see which group each workflow belongs to, for example processes of a whole task and nested processes.
  - Goal: the agent structures its work by the purpose of each workflow.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The extension renders the activation options itself and loads its own configuration directory.

- [X] FRQ-17: A session that an earlier version of the extension saved restores its workflow state as a chain of one workflow, with the same workflow, route, and active stage.
  - Origin: source. Decision of the requester: users who update the package continue their sessions.
  - Goal: work that started before the update continues from the same stage.
  - Goal achievement: Full.
  - Feasibility: Confirmed. Each saved entry of the current version describes one workflow state, which is a chain of one workflow.

- [X] FRQ-18: Before the agent starts a workflow, it knows for each workflow that it may activate whether this workflow is intended for nested run, and what a nested run means: when the workflow ends, the agent returns to the stage from which it started it.
  - Origin: source. Request: an agent that does not know in advance that a workflow returns to the calling stage meets a logical conflict when the return happens.
  - Goal: the agent chooses between a nested run and a whole-task process knowing the consequence of each.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The extension renders the list of workflows that the agent may activate and the guidance of its tools.

### Non-Functional Requirements
- [X] NRQ-01: For models that accept system messages in the middle of a conversation, each piece of information about workflows that the agent receives, changes of the available tools included, appears at the end of the session context, and the harness changes no earlier part of the context.
  - Origin: source. Request: new information always appears at the end of the session, so that the prompt cache stays valid.
  - Goal: workflow changes do not invalidate the cached part of the context.
  - Goal achievement: Full for these models. Other models receive the replayed prompt after each change of the tool set, which pi documents as one cache miss per change.
  - Feasibility: Confirmed. The extension publishes workflow information as messages appended to the session. `pi.setActiveTools()` makes pi append a system message that patches only the changed prompt sections and tool declarations, and models that accept such messages keep their cached prefix (pi documentation `docs/extensions.md`, section `before_agent_start`).

## Critical Scenarios
- SCN-01: Nested check inside a stage
  - Requirements: FRQ-01, FRQ-02, FRQ-03, FRQ-09 (transition), FRQ-14 (start and end of a nested workflow)
  - Level: external. The agent sees the results in the answers of the harness and in the context.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives
  - Flow: the agent works on a stage of a parent workflow and starts a nested workflow; the agent learns the active stage of the nested workflow, what it requires, its transitions, and that the parent workflow waits; the agent tries a transition of the parent workflow, and the harness rejects it; the agent passes the stages of the nested workflow, stating facts for each transition; on the final stage it leaves the nested workflow; in the same run it learns that the stage of the parent workflow is active again, with its transitions, and continues this stage.
- SCN-02: Move without a statement of facts
  - Requirements: FRQ-09 (transition and exit)
  - Level: external. The agent sees the rejection.
  - Area: the workflow extension
  - Flow: the agent requests a transition without a statement of facts, and the harness rejects it and keeps the active stage; the agent requests an exit without a statement of facts, and the harness rejects it and keeps the workflow running.
- SCN-03: Nested workflow inside a nested workflow
  - Requirements: FRQ-04, FRQ-05, FRQ-14 (end of a nested workflow)
  - Level: external. The agent sees the results in the answers of the harness and in the context.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives
  - Flow: inside a nested workflow, the agent starts a second nested workflow; inside the second one, it tries to start the first nested workflow again, and the harness rejects the start; the second nested workflow ends, and the agent continues the stage of the first nested workflow from which it started the second; the first nested workflow ends, and the agent continues the stage of the parent workflow.
- SCN-04: Nested process without a workflow
  - Requirements: FRQ-06, FRQ-14 (end of the last workflow)
  - Level: external. The agent sees the results in the answers of the harness and in the context.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives
  - Flow: an agent without an active workflow starts a workflow intended for nested run, passes its stages, and leaves it on its final stage; the agent learns that no workflow runs.
- SCN-05: Nested process leads to another whole-task process
  - Requirements: FRQ-07, FRQ-14 (start that ends the chain)
  - Level: external. The agent sees the results in the answers of the harness and in the context.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives
  - Flow: inside a nested workflow, the agent finds that the work needs another process and starts a workflow that is not intended for nested run; the nested workflow and its parent workflow end; the agent learns that the new workflow is active and that no workflow waits for a return.
- SCN-06: Exit before the final stage
  - Requirements: FRQ-08, FRQ-14 (exit)
  - Level: external. The agent sees the results in the answers of the harness and in the context.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives
  - Flow: on a middle stage of a nested workflow, the agent leaves it with a statement of facts and learns that the stage of the parent workflow is active again; on a middle stage of the parent workflow, the agent leaves it with a statement of facts and learns that no workflow runs.
- SCN-07: Nested workflow that the agent definition does not allow
  - Requirements: FRQ-10
  - Level: external. The agent sees the rejection.
  - Area: the workflow extension and the agent definition
  - Flow: an agent whose definition does not list a nested workflow tries to start it, and the harness rejects the start; an agent whose definition lists it starts it.
- SCN-08: Chain survives the life of a session
  - Requirements: FRQ-11 (session reload, branch navigation, compaction)
  - Level: external. The agent sees the restored state in the context.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives, and the saved session
  - Flow: a nested workflow runs inside a parent workflow; the session is reloaded, navigated to another branch and back, or compacted; after each of these events the agent works on the same stage of the nested workflow, the parent workflow still waits, and after the end of the nested workflow the agent continues the stage of the parent workflow.
- SCN-09: Workflow files of earlier formats
  - Requirements: FRQ-12
  - Level: external. The agent sees the workflows in the list and the results of their moves.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives
  - Flow: a catalog holds workflow files of formats 1, 2, and 3; all of them load without errors; the agent works by a workflow of format 2, starts a nested workflow on its stage, and returns to this stage; later, inside a chain, it starts a workflow of format 1, and the chain ends.
- SCN-10: Workflow that an agent creates
  - Requirements: FRQ-13
  - Level: external. The agent sees the result of creation.
  - Area: the workflow extension
  - Flow: an agent creates a workflow that is intended for nested run and names its kind; the harness accepts it as a workflow of format 3, and the agent can start it as a nested workflow.
- SCN-11: Grouped list of workflows
  - Requirements: FRQ-15
  - Level: external. The agent sees the list in the context.
  - Area: the workflow extension, the catalog of kinds, and the workflow catalog
  - Flow: authors define two kinds and assign them to workflows, and some workflows have no kind; the agent sees the workflows that it may activate grouped by kind with the description of each kind, and the workflows without a kind apart from them; a workflow behaves the same with and without a kind.
- SCN-12: Session saved before the update
  - Requirements: FRQ-17
  - Level: external. The agent sees the restored state in the context.
  - Area: the saved session and the workflow extension
  - Flow: a session that the previous version of the extension saved on a middle stage of a workflow is opened after the update; the agent works on the same stage of the same workflow, with the same route, and can start a nested workflow from it.
- SCN-13: Workflow changes keep the beginning of the provider request
  - Requirements: NRQ-01
  - Level: external. The model provider receives the requests.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives, and the requests to a model that accepts system messages in the middle of a conversation
  - Flow: during the flow of SCN-01, SCN-05, and SCN-06, each request to the provider starts with the previous request unchanged, and the information about each change of workflows, changes of the available tools included, comes after it.
- SCN-14: Agent knows a returning workflow before its start
  - Requirements: FRQ-18
  - Level: external. The agent sees the list and the guidance in the context.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives
  - Flow: the catalog holds workflows intended for nested run and workflows that are not; before any start, the agent receives the list of workflows that it may activate, in which each workflow intended for nested run is recognizable as such, and an explanation that such a workflow returns the agent to the stage from which it started it.

## Open Questions
No open questions.

## Technical Supplement
No technical supplement.

## References
- [problem.md](problem.md)
- `docs/extensions/workflow.md`
