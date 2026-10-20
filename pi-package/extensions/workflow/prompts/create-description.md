**DESCRIPTION**:
1. Create and immediately activate a task-specific workflow when no ready-made workflow fits user's task.
2. A workflow created through workflow_create cannot be reactivated after another workflow replaces it.
3. Creation replaces current workflow state.

**RULES**:
1. Submit complete workflow definition in one call. Use an ID that differs from each ready-made workflow ID, also when letter case is ignored.
2. Define exactly one initial stage and at least one final stage.
3. Each stage is reachable through an acyclic `advance` graph.
4. A final stage has no outgoing `advance` transition, and each other stage has at least one.
5. Each stage has an outgoing transition, so a final stage has at least one outgoing `rework` transition.
6. A `rework` transition targets only a strict `advance` ancestor.
7. When completion of a stage may require a change of output of an `advance` ancestor, a path of `rework` transitions leads from this stage to this ancestor.
8. Completion criteria of a stage use only outputs of this stage and of its `advance` ancestors, because outputs of its `advance` descendants do not exist yet.
9. When current workflow does not fit goals, create a new suitable workflow at once.
10. Set `thinking` of each stage to lowest level that reliably completes stage:
    1) `low`: Mechanical extraction, predefined commands, formatting, or deterministic checks. No material interpretation, trade-offs, or design decisions.
    2) `medium`: Bounded analysis, implementation, verification, synthesis from known evidence, or routine user interaction with established criteria.
    3) `high`: Ambiguous requirements, architecture or design, multi-option planning, cross-component trade-offs, contradiction resolution, or replanning.
    4) Choose level by hardest reasoning that stage requires. File count, tool count, task duration, and output size do not set level.
    5) Use `medium` when neither `low` nor `high` clearly applies.
11. General prompt holds only rules that two or more stages apply. A rule of one stage goes to prompt of this stage.
