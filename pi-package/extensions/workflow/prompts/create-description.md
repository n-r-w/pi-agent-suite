**DESCRIPTION**:
1. Create and immediately activate a task-specific workflow when no workflow in `<workflow_activation_options>` fits the user's task.
2. A created workflow cannot be activated again after it is replaced or exits.

**RULES**:
1. Submit a complete workflow definition in one call. Use an ID that differs from each ID in `<workflow_activation_options>` and in `<workflow_chain>`.
2. Define exactly one initial stage and at least one final stage.
3. Each stage is reachable through an acyclic `advance` graph.
4. A final stage has no outgoing `advance` transition, and each other stage has at least one.
5. A final stage has at least one outgoing `rework` transition, because the final stage stays active until exit, and a requested change of its result can need an earlier stage.
6. A `rework` transition targets only a strict `advance` ancestor.
7. When completion of a stage may require a change of output of an `advance` ancestor, a path of `rework` transitions leads from this stage to this ancestor.
8. Completion criteria of a stage use only outputs of this stage and of its `advance` ancestors, because outputs of its `advance` descendants do not exist yet.
9. Set `thinking` of each stage to the lowest level that reliably completes the stage, by the hardest reasoning that the stage requires:
    1) `low`: the stage needs no interpretation, trade-off, or design decision, for example extraction, predefined commands, formatting, or deterministic checks.
    2) `medium`: the stage reasons from known evidence by established criteria, for example bounded analysis, implementation, verification, or routine user interaction.
    3) `high`: the stage resolves ambiguity or chooses between designs, for example ambiguous requirements, architecture, multi-option planning, cross-component trade-offs, or replanning.
    4) File count, tool count, task duration, and output size do not set the level.
    5) Use `medium` when neither `low` nor `high` clearly applies.
10. General prompt holds only rules that two or more stages apply. A rule of one stage goes to the prompt of this stage.
