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

{{fileCandidates}}

<output_format guidelines="Use this EXACT format">
```
  <goal>
    <!-- Preserve existing goals. Add new goals if  task expanded -->
  </goal>

  <constraints_and_preferences>
    <!-- Preserve existing constraints and preferences. Add new ones discovered -->
  </constraints_and_preferences>

  <progress>
    <done>
      <!--
        Include previously done items and newly completed items.
        MUST NOT add information about previously loaded resources (files, skills, etc.).
      -->
      - [x] [Completed work. Rationale for completion]
      ...
    </done>

    <in_progress>
      -  [ ] [Current work. Rationale for current work]
      ...
    </in_progress>
  </progress>

  <collaboration_desk>
    <!-- Current status of collaboration desk: desks, topics, messages, review status, or "(none)" -->
  </collaboration_desk>

  <subagents_history> <!-- Only subagents whose work may need to be continued (e.g., coder subagent who may need to fix their code after review, etc.) -->
    - Session #[Session Number]; [Subagent ID]; Task: [Task Name (up to 6 words)]; Work done: [VERY brief summary of work done (up to 20 words)]
    ...
  </subagents_history>

  <assumptions> <!-- Current assumptions. Remove assumptions confirmed or disproven by facts. -->
    - [Assumption Description. Rationale for assumption]
    ...
  </assumptions>

  <open_questions> <!-- Current open questions. Remove questions transformed into decisions or blockers. -->
    - [Question Description. What was done to close question and why it didn't work. Recommendations how it can be closed, if any.]
    ...
  </open_questions>

  <blocked> <!-- Add Current blockers. Remove resolved blockers  -->
    - [Blocker Description. What was done to find a solution and why it didn't work. Recommendations how it can be unblocked, if any.]
    ...
  </blocked>

  <key_decisions> <!-- Actual decisions made, with brief rationale. Remove decisions that were reversed or are no longer relevant -->
    - [Decision Description. Rationale for decision]
    ...
  </key_decisions>

  <next_steps>
    - Fulfill requirements of `<post_compaction_rehydration>`. <!-- Put this AS IS -->
    - Goal: [Goal]. To-Do: [Work to be done to achieve goal] <!-- Update based on current state -->
    ...
  </next_steps>

  <critical_context>
    <!--
      1. Preserve important context that should be considered before continuing. Add new context when needed.
      2. Add "(none)" if not applicable
    -->
    - [Context Description. Rationale for context]
  </critical_context>

  <must_read_first>
    - Skills: <!-- MUST list all SKILL.md files you have read previously or should have read -->
       * [file path to skills file]
       * ...
    - [Link to file or resource. Add exact line ranges of files if possible. Rationale for reading first] <!-- Relevant information that should be read first before continuing. MUST NOT put ANY previously read resource, ONLY TRULY CRITICAL for next steps. Add new items when needed -->
    ...
  </must_read_first>

  <post_compaction_rehydration critical="true" priority="maximum"> <!-- Put this AS IS at end of summary. DO NOT CHANGE -->
    1. On receiving this compacted summary, before any analysis, decision, user-facing answer, or file modification, MUST read:
      1) EVERY SKILL.md listed in `must_read_first`
      2) Other relevant resources listed in `must_read_first` which are critical for next steps
      3) Relevant messages from collaboration desk
    2. Summary content CANNOT replace restoration of original context from specified sources
    3. Rehydration is complete only when every listed source has been read successfully
    4. Any information in summary about previously loaded resources is NOT REPLACEMENT for restoring context from specified sources, as their information has ALREADY BEEN LOST during summarization.
    5. If you find violation of these rules, MUST IMMEDIATELY fix situation and load missing resources
  </post_compaction_rehydration>
```
</output_format>
