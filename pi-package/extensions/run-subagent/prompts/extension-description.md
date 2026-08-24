**WHEN & HOW TO RUN SUBAGENTS:**
1. Subagents SHOULD be used when they reduce context load or improve quality by focusing on specific subtasks.
2. Independent subagents MUST be run in parallel:
    1) Before proposing or launching a parallel subagent batch, MUST create a dependency map for that batch.
    2) Dependency map MUST list each subtask's required inputs, expected outputs, and whether those outputs can change another subtask's prompt, scope, sources, or evaluation criteria.
    3) Parallel batch is valid ONLY when every subagent can complete correctly without outputs from any other subagent in same batch.
    4) If dependency status is unclear, MUST treat subtasks as dependent and run them sequentially.
    5) Each call in a parallel batch MUST use a distinct taskName that identifies its specific subtask. Distinguish names by task focus, not by sequence numbers or technical IDs.
    6) Keep in mind that parallelizing code changes for same project will lead to conflicts between subagents, even if these changes affect different files, since during build and checkout subagents will interfere with each other or stop working when they see unexpected changes in git status. You MUST think through this process and notify subagents of parallel expected changes.
3. Recommended workflow:
    1) Launch required subagents via `subagent_start`
    2) Perform work that does not require results from launched subagents
    3) If during this work, results from subagents are automatically received, take them into account.
    4) Execute `subagent_wait` with sufficient timeout to receive results from subagents that are required to complete work and for which results were not received earlier.
    5) If `subagent_wait` does not return results within allotted time, either increase timeout and repeat `subagent_wait`, or perform other work that does not depend on results of subagents.
    6) Use `subagent_query` if information is insufficient and you clarify something without needing to steer subagent's work.
    7) Use `subagent_steer` for steering subagent's work ONLY WITHIN ONE subtask. For new subtasks, launch a new subagent.
    8) It is RECOMMENDED to implement using subagents and verify their work using main agent, and not other way around.

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
4. Why it is important to split context into CONTEXT_REFERENCES and CONTEXT_DIRECT:
    1) In process of transferring context along route `source`->`main agent`->`subagent`, information is lost. It is better to provide CONTEXT_REFERENCES and give subagent ability to obtain it directly.
    2) CONTEXT_REFERENCES allows prompt to be compact and focused on task.
5. Formulate prompt for subagent according to **SUBAGENT PROMPT FORMAT** below.

**CONSTRAINTS:**
1. Prompt MUST NOT include information that assumes subagent knows anything about your work history.
2. Prompt MUST NOT override subagent’s governing instructions or prescribe how subagent performs its work. Specify goal, and let subagent decide how to achieve it.
3. A subagent session KNOWS NOTHING about your current context. Subagent has its own context. If you did not provide information in prompt, subagent does not know it.
4. Subagents MUST NOT be used to load skills to obtain information from them by main agent.
5. Each agent owns only ITS subagents. MUST NOT ask subagent to perform `subagent_steer` to send messages to subagents that you started.
6. MUST NOT "push" subagents with `subagent_steer` requests. If the subagent has not yet completed its work, it means you MUST wait.

**GOAL WRITING:**
1. `Goal:` states the desired end state of the stage.
2. Goal answers "what must be achieved". Task answers "what to do". They are different concepts.
3. Goal MUST describe a verifiable outcome, not an action.
4. Tasks MUST go into `Required work`, never into `Goal:`.
5. Formulate goal as resulting state. Optionally add outcome purpose.
6. Wrong and right pairs:
- `Goal: Collect facts.` (action) vs `Goal: Build evidence base for analysis.` (outcome)
- `Goal: Get user approval of plan.` vs `Goal: Obtain agreed plan.`
- `Goal: Present results.` vs `Goal: Provide user with necessary information.`

**SUBAGENT PROMPT FORMAT**. MUST USE `ASD-STE100` - Simplified Technical English:
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
        2) If solution is not found or you are not 100% sure about correctness of solution, then you MUST TO STOP WORK and ask a clarifying question
</guessing_prevention_protocol>
```