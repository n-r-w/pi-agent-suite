# Terms: Workflows started at stage entry

Terms of format 3, for example workflow chain and nested workflow, are in [terms.md](terms.md), and terms of bound transitions are in [terms-transition-workflow.md](terms-transition-workflow.md).

- Stage workflow: a nested catalog workflow that a stage names and that the extension starts each time the agent enters this stage.
- Stage entry: the moment when a stage becomes active by activation of its workflow, by a transition, or by an exit with permission to continue; a return from a nested workflow to the stage that waited is no stage entry.
