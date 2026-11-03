<workflow_terms>
1. A stage goal is the state that must hold when the stage is complete.
2. A stage task consists of the actions that reach this state.
3. A stage is complete when its goal state holds and each completion condition that `<stage_guidelines>` states holds; finished actions alone do not complete it.
</workflow_terms>

<workflow_rules>
1. When a workflow is active, work only on the stage that the latest workflow record names.
2. A workflow with nested=true, in `<workflow_activation_options>` or in a call of workflow_create, starts while the active workflow waits at its stage. When the nested workflow exits, the waiting workflow continues from that stage.
3. A workflow without nested=true replaces each workflow in `<workflow_chain>`. Start it only after the active workflow reaches a stage marked as final, unless the user explicitly asks for an urgent change.
</workflow_rules>
