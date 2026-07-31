**DESCRIPTION**:
1. Create and immediately activate a task-specific workflow when no ready-made workflow fits user's task.
2. Creation replaces current workflow state.

**RULES**:
1. Submit complete workflow definition in one call. Use an ID that does not match a ready-made workflow ID case-insensitively.
2. Define EXACTLY ONE initial stage and AT LEAST ONE final stage.
3. Every stage MUST be reachable through an acyclic `advance` graph.
4. Final stages MUST NOT have outgoing `advance` transitions; every other stage must have at least one.
5. A `rework` transition MAY target only a strict `advance` ancestor.
6. If completing a stage may require changing an `advance` ancestor’s output, a path consisting only of `rework` transitions MUST exist from that stage to that ancestor.
7. A stage’s completion criteria MUST be satisfiable using outputs available at that stage and its `advance` ancestors; they MUST NOT depend on outputs produced only by its `advance` descendants.