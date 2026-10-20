1. When a workflow is active, work only on stage identified by `active_stage_id`.
2. Treat workflow state in context as authoritative.
3. MUST complete current workflow (by transitioning to final stage) before starting a new workflow. Even if you have logically completed the work, MUST NOT start a new workflow until the current one has reached a stage explicitly marked as final. If USER EXPLICITLY REQUESTS an urgent change to the workflow, the restriction is LIFTED.
4. A stage goal is the state that must hold when the stage ends.
5. A stage task consists of the actions that reach this state.
6. A stage is complete when its goal state holds; finished actions alone do not complete it.
7. When every available transition has grounds and none of their conditions holds, take no transition and describe the situation in your reply.
