Start an independent subagent session.
For parallel work, you MUST emit multiple run_subagent calls in the same turn.

RULES:
1. Subagents SHOULD be used when they reduce context load or improve quality.
2. Independent subagents MUST be run in parallel using parallel tool calls in the same turn.
    1) Before proposing or launching a parallel subagent batch, MUST create a dependency map for that batch.
    2) Dependency map MUST list each subtask's required inputs, expected outputs, and whether those outputs can change another subtask's prompt, scope, sources, or evaluation criteria.
    3) Parallel batch is valid ONLY when every subagent can complete correctly without outputs from any other subagent in the same batch.
    4) If dependency status is unclear, MUST treat subtasks as dependent and run them sequentially.
    5) Each call in a parallel batch MUST use a distinct taskName that identifies its specific subtask. Distinguish names by task focus, not by sequence numbers or technical IDs.
3. Subagents MUST NOT be used to:
    1) Load skills.
    2) Reread information already extracted.
4. Subagent prompt MUST be self-contained and include:
    1) Task.
    2) Scope & Out of scope.
    3) Accepted risks & Decisions.
    4) Constraints.
    5) Context.
    6) Acceptance criteria.
    7) Response requirements.
    8) Additional instructions.
5. Subagent prompt MUST NOT include:
    1) Attempts to impose constraints that conflict with the subagent's own rules.
    2) Information that assumes the subagent knows anything about your work history.
6. EARS format MUST be used for the subagent's functional and non-functional requirements.
    Format: `WHILE {optional pre-condition}, WHEN {optional trigger}, {actor} SHALL {required behavior}`
7. A new subagent session KNOWS NOTHING about your current context. The prompt MUST provide all information required to start the task.
    BAD: `Task: Conduct second round of research on topic X {information based on prior unstated work}`
    GOOD: `Task: Conduct research on topic X {all information required to start}`
8. Each started session returns its short numeric ID as `Subagent session: N`.
