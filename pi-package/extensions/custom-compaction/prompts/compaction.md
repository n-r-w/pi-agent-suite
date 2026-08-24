<task>
  Messages above are a conversation to summarize.
  Create a structured context checkpoint summary that another LLM will use to continue work.
  When referring to identifiers, they must be retained COMPLETELY AS IS.
</task>

<language>
  MUST use ASD-STE100 - Simplified Technical English, except for text where changing language would change its meaning.
</language>

<summary_rules>
  1. Include only information present in conversation.
  2. Return only summary.
</summary_rules>

{{fileCandidates}}

<output_format guidelines="Use this EXACT format">
```
  <goal>
    <!-- What is user trying to accomplish? Can be multiple items if session covers different tasks -->
  </goal>

  <constraints_and_preferences>
    <!--
    1. Any constraints, preferences, or requirements mentioned by user
    2. Or "(none)" if none were mentioned
    -->
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
      - [ ] [Current work. Rationale for current work]
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

  <assumptions> <!-- Current assumptions, if any -->
    - [Assumption Description. Rationale for assumption]
    ...
  </assumptions>

  <open_questions> <!-- Current open questions, if any -->
    - [Question Description. What was done to close question and why it didn't work. Recommendations how it can be closed, if any.]
    ...
  </open_questions>

  <blocked> <!-- Issues preventing progress, if any -->
    - [Blocker Description. What was done to find a solution and why it didn't work. Recommendations how it can be unblocked, if any.]
    ...
  </blocked>

  <key_decisions>
    - [Decision Description. Rationale for decision]
    ...
  </key_decisions>

  <next_steps>
    - Goal: [Goal]. To-Do: [Work to be done to achieve goal] <!-- Add relevant items -->
    ...
  </next_steps>

  <critical_context>
    <!-- Preserve important context that should be considered before continuing -->
    - [Context Description. Source. Rationale for context]
    ...
  </critical_context>
```
</output_format>
