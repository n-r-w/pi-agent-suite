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
    1. YOUR NEXT TURN MUST contain ONLY tool calls that read ALL source from `<lost_during_compaction>`. <!-- Put this AS IS -->
    2. Futher work:
      - Goal: [Goal]. To-Do: [Work to be done to achieve goal] <!-- Update based on current state -->
      ...
  </next_steps>

  <lost_during_compaction note="Resources whose content was LOST during compaction and MUST BE FULLY RE-READ BEFORE ANY FURTHER WORK">
    IMPORTANT: THESE ARE NOT READ SOURCES. EVEN IF IT SEEMS TO YOU THAT YOU HAVE ALREADY READ THEM, YOU STILL MUST READ THEM AGAIN IN FULL! NO EXCEPTIONS!

    1. Skills: <!-- MUST list all SKILL.md files you have read previously or should have read -->
       1) [file path to skills file]
       2) ...
    2) Files: <!-- Relevant information that should be read first before continuing. MUST NOT put ANY previously read resource, ONLY TRULY CRITICAL for next steps. Add new items when needed -->
      1) [Link to file. Add exact line ranges of files if possible. Rationale for reading first]
      2) ...
    ...
  </lost_during_compaction>

  <critical_context>
    <!--
      1. Preserve important context that should be considered before continuing. Add new context when needed.
      2. Add "(none)" if not applicable
    -->
    - [Context Description. Rationale for context]
  </critical_context>
```
</output_format>
