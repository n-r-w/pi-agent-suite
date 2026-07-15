**TOOL DESCRIPTION:**
1. Run independent subagent.
2. For parallel work, you MUST emit multiple run_subagent calls in same turn.
3. Each started subagent session returns its numeric ID as `Subagent session: N`.

**WHEN & HOW TO RUN SUBAGENTS:**
1. Subagents SHOULD be used when they reduce context load or improve quality by focusing on specific subtasks.
2. Independent subagents MUST be run in parallel using parallel tool calls (in same turn).
    1) Before proposing or launching a parallel subagent batch, MUST create a dependency map for that batch.
    2) Dependency map MUST list each subtask's required inputs, expected outputs, and whether those outputs can change another subtask's prompt, scope, sources, or evaluation criteria.
    3) Parallel batch is valid ONLY when every subagent can complete correctly without outputs from any other subagent in same batch.
    4) If dependency status is unclear, MUST treat subtasks as dependent and run them sequentially.
    5) Each call in a parallel batch MUST use a distinct taskName that identifies its specific subtask. Distinguish names by task focus, not by sequence numbers or technical IDs.

**PROMPT FORMATION ALGORITHM:**
1. Define subagent's goal.
2. FULL_CONTEXT: Define what information subagent needs to achieve goal.
3. Split FULL_CONTEXT of subagent into two parts:
    CONTEXT_REFERENCES: Information that subagent can obtain independently from files and other accurate sources.
    CONTEXT_DIRECT: Information that must be directly provided to subagent in prompt.
4. Rules of tools `team_*` do not limit main agent in forming CONTEXT_DIRECT.
5. Why it is important to split context into CONTEXT_REFERENCES and CONTEXT_DIRECT:
    1) In process of transferring context along route `source`->`main agent`->`subagent`, information is lost. It is better to provide CONTEXT_REFERENCES and give subagent ability to obtain it directly.
    2) CONTEXT_REFERENCES allows prompt to be compact and focused on task.
6. Formulate prompt for subagent, including:
    1) Goal
    2) Task definition
    3) Acception criteria
    4) Context (do not explicitly label context as CONTEXT_DIRECT or CONTEXT_REFERENCES, just add information)
    5) Additional instructions if any
7. EARS format MUST be used for subagent's functional and non-functional requirements.
    Format: `WHILE {optional pre-condition}, WHEN {optional trigger}, {actor} SHALL {required behavior}`

**CONSTRAINTS:**
1. Prompt MUST NOT include information that assumes subagent knows anything about your work history.
2. Prompt MUST NOT override subagent’s governing instructions or prescribe how subagent performs its work. Specify goal, and let subagent decide how to achieve it.
3. A subagent session KNOWS NOTHING about your current context. Subagent has its own context. If you did not provide information in prompt, subagent does not know it.
4. Subagents MUST NOT be used to load skills to obtain information from them by main agent

