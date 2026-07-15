<task>
  Messages above are NEW conversation messages to incorporate into  existing summary provided in `<previous-summary>` tags.
  Update  existing structured summary with new information.
</task>

<language>
  Use ENGLISH language ONLY, except for text where changing  language would change its meaning.
</language>

<update_rules>
  1. PRESERVE all existing information from  previous summary unless new messages make it stale or irrelevant.
  2. ADD new progress, decisions, and context from  new messages.
  3. UPDATE  Progress section: move items from `In Progress` to `Done` when completed.
  4. UPDATE `Next Steps` based on what was accomplished.
  5. PRESERVE exact file paths, function names, commands, error messages, identifiers, and configuration keys.
  6. REMOVE information only when it is no longer relevant or is replaced by newer facts.
  7. Return one updated summary.
</update_rules>

<skill_output_rule>
  1. When  previous summary or new summarized messages include any path ending with `/SKILL.md`,  updated summary MUST preserve or add a `## Critical Context` bullet with this meaning:
    -  listed skill reads are historical context;
    -  updated summary does not preserve full skill file content;
    - before relying on those skills,  next agent must reread  exact listed files.
  2. Deduplicate exact `SKILL.md` paths.
  3. Do not convert `SKILL.md` paths from `<read-files>` or  previous summary into `loaded skills`.
</skill_output_rule>

<output_format guidelines="Use this EXACT format">
```
  <goal>
    <!-- Preserve existing goals. Add new goals if  task expanded -->
  </goal>

  <constraints_and_preferences>
    <!-- Preserve existing constraints and preferences. Add new ones discovered -->
  </constraints_and_preferences>

  <progress>
    <done> <!-- Include previously done items and newly completed items -->
      - [x] [Completed work]
    </done>

    <in_progress>
      - [ ] [Current work]
    </in_progress>
  </progress>

  <collaboration_desk>
    <!-- Current status of collaboration desk: desks, topics, messages, review status, or "(none)" -->
  </collaboration_desk>

  <subagents_history> <!-- Only subagents whose work may need to be continued (e.g., coder subagent who may need to fix their code after review, etc.) -->
    - Session #[Session Number]; [Subagent ID]; Task: [Task Name (up to 6 words)]; Work done: [VERY brief summary of work done (up to 20 words)]
  </subagents_history>

  <assumptions> <!-- Current assumptions. Remove assumptions confirmed or disproven by facts. -->
    - [Assumption Description]. Why: [Rationale for assumption]
  </assumptions>

  <open_questions> <!-- Current open questions. Remove questions transformed into decisions or blockers. -->
    - [Question Description]. Why: [What was done to close question and why it didn't work. Recommendations how it can be closed, if any.]
  </open_questions>

  <blocked> <!-- Add Current blockers. Remove resolved blockers  -->
    - [Blocker Description]. Why: [What was done to find a solution and why it didn't work. Recommendations how it can be unblocked, if any.]
  </blocked>

  <key_decisions> <!-- Actual decisions made, with brief rationale. Remove decisions that were reversed or are no longer relevant -->
    - [Decision Description]. Why: [Rationale for decision]
  </key_decisions>

  <next_steps> <!-- Update based on current state. Numbered list -->
    1. Goal: [Goal]. To-Do: [Work to be done to achieve goal]
  </next_steps>

  <critical_context>
    <!--
      1. Preserve important context. Add new context when needed.
      2. Preserve or add  skill reload bullet when `SKILL.md` paths appear in  previous summary, new summarized messages, or `<read-files>`.
      3. Add "(none)" if not applicable
    -->
  </critical_context>
```
</output_format>
