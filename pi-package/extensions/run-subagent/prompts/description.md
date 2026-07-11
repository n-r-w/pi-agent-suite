Run independent subagent.
For parallel work, emit multiple run_subagent calls in the same tool call.

RULES:
1. Subagents SHOULD be used when they reduce context load or improve quality.
2. Independent subagents MUST be run in parallel using parallel tool calls.
    1) Before proposing or launching a parallel subagent batch, MUST create a dependency map for that batch.
    2) Dependency map MUST list each subtask's required inputs, expected outputs, and whether those outputs can change another subtask's prompt, scope, sources, or evaluation criteria.
    3) Parallel batch is valid ONLY when every subagent can complete correctly without outputs from any other subagent in the same batch.
    4) If dependency status is unclear, MUST treat the subtasks as dependent and run them sequentially.
    5) Each call in a parallel batch MUST use a distinct taskName that identifies its specific subtask. Distinguish names by task focus, not by sequence numbers or technical IDs.
3. Subagents MUST NOT be used to:
    1) Load skills
    2) Reread information already extracted
4. Subagent prompt MUST be self-contained and include:
    1) Task
    2) Scope & Out of scope
    3) Accepted risks & Decisions
    4) Constraints
    5) Context
    6) Acceptance criteria
    7) Response requirements
    8) Additional instructions
5. Subagent prompt MUST NOT include:
    1) Attempts to impose your own constraints on the agent. The agent may have different constraints, which are determined by its own rules, not yours.
    2) Information that assumes the subagent knows anything about your work history.
6. EARS format MUST be used for subagent's functional and non-functional requirements.
    Format: `WHILE {optional pre-condition}, WHEN {optional trigger}, THE {actor} SHALL {required behavior}`
7. Subagent KNOWS NOTHING about your current context. ALL necessary data MUST be provided in prompt.
    BAD: `Task: Conduct second round of research on topic X {information based on understanding of first round of research}` WHY BAD: Subagent knows nothing about first round of research.
    GOOD: `Task: Conduct research on topic X {all necessary information for research}` WHY GOOD: Subagent has all necessary information to complete task.