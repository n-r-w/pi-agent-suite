Create and immediately activate a task-specific workflow when no ready-made workflow fits the user's task.
Submit the complete workflow definition in one call. Use an ID that does not match a ready-made workflow ID case-insensitively.
Define exactly one initial stage and at least one final stage. Every stage must be reachable through an acyclic `advance` graph. Final stages must not have outgoing `advance` transitions; every other stage must have at least one. A `rework` transition may target only a strict `advance` ancestor.
Creation replaces current workflow state.
