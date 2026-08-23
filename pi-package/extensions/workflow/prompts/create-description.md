**DESCRIPTION**:
1. Create and immediately activate a task-specific workflow when no ready-made workflow fits user's task.
2. If a workflow created through workflow_create is replaced, it cannot be reactivated.
3. Creation replaces current workflow state.

**RULES**:
1. Submit complete workflow definition in one call. Use an ID that does not match a ready-made workflow ID case-insensitively.
2. Define EXACTLY ONE initial stage and AT LEAST ONE final stage.
3. Every stage MUST be reachable through an acyclic `advance` graph.
4. Final stages MUST NOT have outgoing `advance` transitions; every other stage must have at least one.
5. MUST NOT create dead-end nodes. Even a final stage MUST have at least one outgoing `rework` transition.
6. A `rework` transition MAY target only a strict `advance` ancestor.
7. If completing a stage may require changing an `advance` ancestor’s output, a path consisting only of `rework` transitions MUST exist from that stage to that ancestor.
8. A stage’s completion criteria MUST be satisfiable using outputs available at that stage and its `advance` ancestors; they MUST NOT depend on outputs produced only by its `advance` descendants.
9. If you understand that your current workflow does not fit goals, you MUST IMMEDIATELY create a new, suitable workflow.
10. MUST use English only unless using other language is essential for accuracy.
11. Set each stage's `thinking` to lowest level that can reliably complete stage:
    1) `low`: Mechanical extraction, predefined commands, formatting, or deterministic checks. No material interpretation, trade-offs, or design decisions.
    2) `medium`: Bounded analysis, implementation, verification, synthesis from known evidence, or routine user interaction with established criteria.
    3) `high`: Ambiguous requirements, architecture or design, multi-option planning, cross-component trade-offs, contradiction resolution, or replanning.
    4) Choose level by hardest reasoning required in stage, not file count, tool count, task duration, or output size.
    5) Use `medium` when neither `low` nor `high` clearly applies.