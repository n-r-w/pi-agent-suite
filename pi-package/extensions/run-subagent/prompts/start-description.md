**TOOL DESCRIPTION:**
1. Start subagent in new session.
2. Tool returns its numeric session ID after subagent accepts prompt.
3. Subagent continues to work in background while main process can perform other tasks.
4. Completion feedback arrives through:
    1) `subagent_wait` tool.
    2) Owner history if the subagent finishes work before the `subagent_wait` call.

**WHEN & HOW TO RUN SUBAGENTS:**
1. Subagents SHOULD be used when they reduce context load or improve quality by focusing on specific subtasks.
2. Independent subagents MUST be run in parallel:
    1) Before proposing or launching a parallel subagent batch, MUST create a dependency map for that batch.
    2) Dependency map MUST list each subtask's required inputs, expected outputs, and whether those outputs can change another subtask's prompt, scope, sources, or evaluation criteria.
    3) Parallel batch is valid ONLY when every subagent can complete correctly without outputs from any other subagent in same batch.
    4) If dependency status is unclear, MUST treat subtasks as dependent and run them sequentially.
    5) Each call in a parallel batch MUST use a distinct taskName that identifies its specific subtask. Distinguish names by task focus, not by sequence numbers or technical IDs.
    6) Keep in mind that parallelizing code changes for same project will lead to conflicts between subagents, even if these changes affect different files, since during build and checkout subagents will interfere with each other or stop working when they see unexpected changes in git status. You MUST think through this process and notify subagents of parallel expected changes.

**COST AND TIME EFFICIENCY:**
1. Goal: optimizing time and money costs by selecting minimum sufficient level of sub-agents abilities
2. Rules:
    1) If subagent has multiple levels of expertise (eg. Junior, Middle, Senior), choose lowest level that can effectively complete task.
    2) Lower level, faster agent completes work and spends less money, but has lower level of capabilities.
    3) Number of files involved in task MUST NOT AFFECT choice of subagent level. Choice MUST be based on LOGICAL COMPLEXITY, not scope volume.
    4) Keep in mind that running two cheap subagents may spend more time and money than running one expensive subagent.
    5) Always consider cost and time efficiency when designing subagent's team and workflow.
    6) MUST adapt choice of agents during task execution if new data emerges about task complexity/simplicity, risks, and quality requirements.

**PROMPT FORMATION ALGORITHM:**
1. Define subagent's goal.
2. FULL_CONTEXT: Define what information subagent needs to achieve goal.
3. Split FULL_CONTEXT of subagent into two parts:
    CONTEXT_REFERENCES: Information that subagent can obtain itself from files.
    CONTEXT_DIRECT: Information that must be directly provided to subagent in prompt.
4. Rules of tools `team_*` do not limit main agent in forming CONTEXT_DIRECT.
5. Why it is important to split context into CONTEXT_REFERENCES and CONTEXT_DIRECT:
    1) In process of transferring context along route `source`->`main agent`->`subagent`, information is lost. It is better to provide CONTEXT_REFERENCES and give subagent ability to obtain it directly.
    2) CONTEXT_REFERENCES allows prompt to be compact and focused on task.
6. Formulate prompt for subagent according to **SUBAGENT PROMPT FORMAT** below.

**CONSTRAINTS:**
1. Prompt MUST NOT include information that assumes subagent knows anything about your work history.
2. Prompt MUST NOT override subagent’s governing instructions or prescribe how subagent performs its work. Specify goal, and let subagent decide how to achieve it.
3. A subagent session KNOWS NOTHING about your current context. Subagent has its own context. If you did not provide information in prompt, subagent does not know it.
4. Subagents MUST NOT be used to load skills to obtain information from them by main agent.
5. Each agent owns only ITS subagents. MUST NOT ask subagent to perform `subagent_steer` to send messages to subagents that you started.

**SUBAGENT PROMPT FORMAT**:
```
<goal>
    <!-- Which goal subagent is expected to achieve -->
</goal>

<task>
    <!-- What subagent is expected to do to achieve goal -->
</task>

<acceptance_criteria>
    <!--
    Functional and non-functional requirements in EARS format:
    `WHILE {optional pre-condition}, WHEN {optional trigger}, {actor} SHALL {required behavior}`
    -->
</acceptance_criteria>

<context>
    <!-- do not explicitly label context as CONTEXT_DIRECT or CONTEXT_REFERENCES, just add information -->
</context>

<guidelines>
    <!-- relevant guidelines if any -->
</guidelines>

<guessing_prevention_protocol>
    In case of ambiguities or blockers, you MUST:
        1) Investigate problem and try to find solution independently
        2) If solution is not found or you are not 100% sure about correctness of the solution, then you MUST TO STOP WORK and ask a clarifying question
</guessing_prevention_protocol>
```