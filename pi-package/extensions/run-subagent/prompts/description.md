Run independent subagent.
For parallel work, you MUST emit multiple run_subagent calls in same turn.

RULES:
1. Subagents SHOULD be used when they reduce context load or improve quality.
2. Independent subagents MUST be run in parallel using parallel tool calls (in same turn).
    1) Before proposing or launching a parallel subagent batch, MUST create a dependency map for that batch.
    2) Dependency map MUST list each subtask's required inputs, expected outputs, and whether those outputs can change another subtask's prompt, scope, sources, or evaluation criteria.
    3) Parallel batch is valid ONLY when every subagent can complete correctly without outputs from any other subagent in same batch.
    4) If dependency status is unclear, MUST treat subtasks as dependent and run them sequentially.
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
    1) Attempts to impose your own constraints on agent. agent may have different constraints, which are determined by its own rules, not yours.
    2) Information that assumes subagent knows anything about your work history.
6. EARS format MUST be used for subagent's functional and non-functional requirements.
    Format: `WHILE {optional pre-condition}, WHEN {optional trigger}, {actor} SHALL {required behavior}`
7. When `resumeSession` is omitted, subagent KNOWS NOTHING about your current context. ALL necessary data MUST be provided in prompt.
    BAD: `Task: Conduct second round of research on topic X {information based on understanding of first round of research}` WHY BAD: a new subagent session has no prior context.
    GOOD: `Task: Conduct research on topic X {all necessary information for research}` WHY GOOD: a new subagent session receives all required context.
8. When `resumeSession` is provided, subagent retains that child session's prior context. Prompt MUST contain new task, review findings, changed constraints, and acceptance criteria, etc, needed for next turn. It MUST NOT duplicate unchanged initial context.
9. `resumeSession` MUST be used only to continue work by same `agentId` in same working directory. Use a new session for independent work or review.
10. Same `resumeSession` MUST NOT be invoked concurrently. Each completed or failed child run returns its short session ID as `Subagent session: N`.
11. Use `resumeSession` for tasks such as:
    1) Continuing work on a task that was interrupted or not completed.
    2) Processing new messages that require revisiting previous decisions.
    3) Updating progress and task status based on new data.