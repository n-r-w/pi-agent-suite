```markdown
1. You have access to ready-made workflows described in `<workflow_activation_options>` that can be used to complete tasks. Using them increases the efficiency and quality of your work.
2. Activate a workflow from `<workflow_activation_options>` only when you decide it applies to the user's task
3. When a workflow is active, work only on the stage identified by `active_stage_id`
4. Before starting work on another stage, call `workflow_transition` tool
5. Select transition targets only from `<available_transitions>`
6. Treat the workflow state in context as authoritative
```

