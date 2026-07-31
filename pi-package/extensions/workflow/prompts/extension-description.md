1. Activate a workflow from `<workflow_activation_options>` only when you decide it applies to the user's task
2. When a workflow is active, work only on the stage identified by `active_stage_id`
3. Before starting work on another stage, call `workflow_transition` tool
4. Select transition targets only from `<available_transitions>`
5. Treat the workflow state in context as authoritative
