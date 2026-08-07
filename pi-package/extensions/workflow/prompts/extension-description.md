1. When a workflow is active, work only on stage identified by `active_stage_id`.
2. Treat workflow state in context as authoritative.
3. MUST complete current workflow (by transitioning to final stage) before starting a new workflow. Even if you have logically completed the work, MUST NOT start a new workflow until the current one has reached a stage explicitly marked as final. If USER EXPLICITLY REQUESTS an urgent change to the workflow, the restriction is LIFTED.
