# Problem Statement

## Key definitions and abbreviations

- Workflow record: a hidden message that the workflow extension adds to the session, such as an activation, a stage entry, a checkpoint, or a stage edit. The agent learns the rules, graph, current stage, and stage instructions of a workflow from these records.
- Stage instructions: the text of `<stage_guidelines>` that the workflow extension sends when the agent first enters a stage.
- Reuse entry: a later record of entry into a known stage, marked `guidelines="reuse"`, without stage instructions. The agent relies on the instructions of an earlier record.
- Model context: messages that Pi sends to the model for its next response.

## Context

The workflow extension saves the workflow state and publishes a workflow record for each workflow operation. Pi first puts the record into its queue and saves it to the session later. The extension sends stage instructions once; on a later entry into the same stage, it sends a reuse entry, so the agent takes the instructions from an earlier record. The extension decides between the two forms by what it remembers about the records that it has sent.

## Observed Problem

Pi can drop a workflow record from its queue before it saves the record, while the workflow state stays saved. Two things then go wrong:
1. The agent continues the active workflow without this record. For example, after a dropped activation, the next response of the agent has neither the rules and graph of the workflow nor the instructions of its first stage.
2. The extension still treats the stage instructions of the dropped record as known. On the next entry into this stage, the agent receives a reuse entry and has no instructions of the stage in its history.

## Affected Audience

- Users who press Escape while an agent works in a workflow, or RPC clients that clear the message queue.
- Main agents and subagents that continue the workflow after such an interruption.

## Evidence

- `pi-package/extensions/workflow/index.ts` saves the workflow state before it publishes the record, for example in the `execute` function of `workflow_activate` through `commitWorkflowStateChange`. It publishes each record through `pi.sendMessage` with `deliverAs: "steer"`. While the agent answers, Pi puts such a message into its queue (`sendCustomMessage` in `agent-session.js` of Pi).
- Pi drops this queue in `AgentSession.clearQueue`. The interactive mode calls it when the user presses Escape during a response (`restoreQueuedMessagesToEditor` and `clearAllQueues` in `interactive-mode.js`), and the RPC mode calls it for the `clear_queue` command (`rpc-mode.js`).
- At the start of each run, the `before_agent_start` handler of the extension prepares only the list of activation options (`index.ts`). The extension checks whether the session shows the active workflow only on `session_start`, `session_tree`, and `session_compact` (`createWorkflowSynchronizer` and `registerWorkflowCompaction` in `index.ts`).
- `pi-package/extensions/workflow/context.ts`, `WorkflowJournal.activate`, `WorkflowJournal.enterStage`, `WorkflowJournal.checkpoint`, and `WorkflowJournal.updateStage` add the stage key to the set of known stages before they publish the record. Release `v2.22.1` has the same code in `WorkflowJournal.activate`.
- Review probes with isolated in-memory sessions confirmed both effects. After a cleared queue, the session held no workflow record, and the next activation of the same stage received `guidelines="reuse"`. After a dropped activation, the next run started with no workflow record and continued with a stage entry only. The probes ran in the reviews of `repeated-workflow-activation-context`; this document does not repeat them.

## Impact

HIGH. After an interruption, the agent continues a workflow without its rules, graph, or stage instructions and can skip what the workflow requires. The state repairs itself only after a restart, branch navigation, or compaction of the session.

## Current State

The extension keeps the set of known stage keys in memory. A record that Pi dropped from its queue stays in this set. The same applies to the stage keys that a checkpoint adds for waiting workflows. Between session start, branch navigation, and compaction, the extension does not check whether the session shows the active workflow.

## Desired State

After Pi drops a workflow record, the agent receives the current state, rules, graph, and stage instructions of the active workflow before its next response. A reuse entry refers only to instructions that the model context holds.

## Problem Boundary

Included: activation, stage entry, nested exit, checkpoints, and stage edits in main-agent and subagent sessions, after Pi drops a queued workflow record, and the next run of the agent after such a drop, also when the user selects another main agent in between.

Outside this problem:

- A context edit that removes or replaces a workflow record: no producer in Pi or this package makes such an edit now, although the Pi API (`SessionManager.appendContextEdit`) allows it.
- Repetition of shared workflow rules and the workflow graph on activation: issue `repeated-workflow-activation-context` covers it with the same history check.
- Activation options: the extension rebuilds them from the session history at the start of each run.
- Delivery of records that Pi saves late after a compaction: this is a limitation of Pi, issue #9051.

## Assumptions

No assumptions.

## Open Questions

None.
