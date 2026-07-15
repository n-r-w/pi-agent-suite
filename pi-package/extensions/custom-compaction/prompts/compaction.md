<task>
  The messages above are a conversation to summarize.
  Create a structured context checkpoint summary that another LLM will use to continue the work.
</task>

<language>
  Use ENGLISH language ONLY, except for text where changing the language would change its meaning.
</language>

<summary_rules>
  1. Keep each section concise.
  2. Preserve exact file paths, function names, commands, error messages, identifiers, and configuration keys.
  3. Include only information present in the conversation.
  4. Do not continue the conversation.
  5. Return only the summary.
</summary_rules>

<skill_output_rule>
  When summarized messages include `SKILL.md` paths, the `## Critical Context` section MUST include this exact meaning:
  1. The listed skill reads are historical context.
  2. The summary does not preserve full skill file content.
  3. Before relying on these skills, the next agent must reread the exact listed files.
</skill_output_rule>

<output_format guidelines="Use this EXACT format">
```
  ## Goal
  <goal>
    <!-- What is the user trying to accomplish? Can be multiple items if the session covers different tasks -->
  </goal>

  <constraints_and_preferences>
    <!--
    1. Any constraints, preferences, or requirements mentioned by user
    2. Or "(none)" if none were mentioned
    -->
  </constraints_and_preferences>

  <progress>
    <done> <!-- Include previously done items and newly completed items -->
      - [x] [Completed work]. Why: [Rationale for completion]
    </done>

    <in_progress>
      - [ ] [Current work]. Why: [Rationale for current work]
    </in_progress>
  </progress>

  <collaboration_desk>
    <!-- Current status of collaboration desk: desks, topics, messages, review status, or "(none)" -->
  </collaboration_desk>

  <subagents_history> <!-- Only subagents whose work may need to be continued (e.g., coder subagent who may need to fix their code after review, etc.) -->
    - Session #[Session Number]; [Subagent ID]; Task: [Task Name (up to 6 words)]; Work done: [VERY brief summary of work done (up to 20 words)]
  </subagents_history>

  <assumptions> <!-- Current assumptions, if any -->
    - [Assumption Description]. Why: [Rationale for assumption]
  </assumptions>

  <open_questions> <!-- Current open questions, if any -->
    - [Question Description]. Why: [What was done to close question and why it didn't work. Recommendations how it can be closed, if any.]
  </open_questions>

  <blocked> <!-- Issues preventing progress, if any -->
    - [Blocker Description]. Why: [What was done to find a solution and why it didn't work. Recommendations how it can be unblocked, if any.]
  </blocked>

  <key_decisions>
    - [Decision Description]. Why: [Rationale for decision]
  </key_decisions>

  <next_steps> <!-- Numbered list -->
    1. Goal: [Goal]. To-Do: [Work to be done to achieve goal]
  </next_steps>

  <critical_context>
    <!--
      1. Any data, examples, or references needed to continue
      2. Skill reload bullet when summarized messages include `SKILL.md` paths
      3. Add "(none)" if not applicable
    -->
  </critical_context>
```
</output_format>
