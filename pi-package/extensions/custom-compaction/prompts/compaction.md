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

<output_format>
  Use this EXACT format:

  ## Goal
  [What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

  ## Constraints & Preferences
  - [Any constraints, preferences, or requirements mentioned by user]
  - [Or "(none)" if none were mentioned]

  ## Progress
  ### Done
  - [x] [Completed tasks/changes]

  ### In Progress
  - [ ] [Current work]

  ### Collaboration Desk
  - [Current status of collaboration desk: desks, topics, messages, review status, or "(none)".]

  ### Assumptions
  - [Current assumptions, if any]

  ### Open Questions
  - [Current open questions, if any]

  ### Blocked
  - [Issues preventing progress, if any]

  ## Key Decisions
  - **[Decision]**: [Brief rationale]

  ## Next Steps
  1. [Ordered list of what should happen next]

  ## Critical Context
  - [Any data, examples, or references needed to continue]
  - [Or "(none)" if not applicable]
  - [Skill reload bullet when summarized messages include `SKILL.md` paths]
</output_format>
