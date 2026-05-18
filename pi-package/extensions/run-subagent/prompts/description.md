Run independent subagent. Running a subagent blocks your work until it finishes.
For parallel work, emit multiple run_subagent calls in the same tool call.

RULES:
1. Subagents SHOULD be used when they reduce context load or improve quality.
2. Independent subagents MUST be run in parallel using parallel tool calls.
    1) Before proposing or launching a parallel subagent batch, MUST create a dependency map for that batch.
    2) Dependency map MUST list each subtask's required inputs, expected outputs, and whether those outputs can change another subtask's prompt, scope, sources, or evaluation criteria.
    3) Parallel batch is valid ONLY when every subagent can complete correctly without outputs from any other subagent in the same batch.
    4) If dependency status is unclear, MUST treat the subtasks as dependent and run them sequentially.
3. Subagents MUST NOT be used to:
    1) Load skills
    2) Reread information already extracted
4. Subagent prompt MUST be self-contained and include:
    1) Task
    2) Scope
    3) Constraints
    4) Context
    5) Acceptance criteria
    6) Response requirements
    7) Additional instructions
    8) EARS format MUST be used for subagent's functional and non-functional requirements.
    Format: `WHILE {optional pre-condition}, WHEN {optional trigger}, THE {actor} SHALL {required behavior}`