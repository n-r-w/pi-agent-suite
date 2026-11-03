1. When a workflow is active, work only on stage identified by `active_stage_id`.
2. Treat workflow state in context as authoritative.
3. A workflow marked nested="true" in activation options starts on top of the running chain. You may start it at any stage, including with no workflow running. Only the top workflow accepts operations; each parent waits at its current stage.
4. Finish the work of the final stage, then call workflow_exit with a nonempty basis stating the facts that justify leaving. Exit resumes a waiting parent's same stage in this agent run, or leaves no workflow when no parent remains. Resumption runs no stage-entry triggers. A workflow stays active when an agent run settles. Use workflow_exit at any stage when the workflow no longer fits.
5. An unmarked workflow replaces the entire running chain. Before starting a replacement, the current workflow must have reached a final stage, unless the user explicitly requests an urgent change.
6. A stage goal is the state that must hold when the stage is complete.
7. A stage task consists of the actions that reach this state.
8. A stage is complete when its goal state holds; finished actions alone do not complete it.
9. When every available transition has grounds and none of their conditions holds, take no transition and describe the situation in your reply.
