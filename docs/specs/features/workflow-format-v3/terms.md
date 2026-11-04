# Terms

- Workflow chain: the ordered list of running workflows, from the first started workflow to the most recently started workflow.
- Root workflow: the first workflow in the running chain.
- Top workflow: the last workflow in the running chain, whose current stage accepts operations.
- Nested workflow: a workflow marked for execution on top of the running chain.
- Parent workflow: the workflow that waits at its current stage while the workflow immediately above it runs.
- Waiting workflow: a workflow below the top in the running chain.
- Return: resumption of a waiting parent's current stage after the top exits.
- Replacement: a start that ends the entire running chain and leaves the new workflow as its only element.
- Restoration snapshot: the model identifier and thinking level captured when a workflow starts.
- Workflow kind: an author-defined classification with an ID and description, used to group activation options.
- Workflow format: the versioned schema of a workflow definition.
- Journal version: the versioned schema of saved workflow operations, independent of the workflow format.
- Basis: a free-text statement of the facts that justify a transition or exit.
- Transition ground: a declared condition identified by an ID on a workflow transition.
- Checkpoint: an appended context record that restores the current workflow chain after context compaction or session restoration.
