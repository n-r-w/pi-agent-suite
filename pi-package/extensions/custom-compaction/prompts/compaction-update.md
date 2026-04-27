<task>
  The messages above are NEW conversation messages to incorporate into the existing summary provided in `<previous-summary>` tags.
  Update the existing structured summary with new information.
</task>

<language>
  Use ENGLISH language ONLY, except for text where changing the language would change its meaning.
</language>

<update_rules>
  1. PRESERVE all existing information from the previous summary unless new messages make it stale or irrelevant.
  2. ADD new progress, decisions, and context from the new messages.
  3. UPDATE the Progress section: move items from `In Progress` to `Done` when completed.
  4. UPDATE `Next Steps` based on what was accomplished.
  5. PRESERVE exact file paths, function names, commands, error messages, identifiers, and configuration keys.
  6. REMOVE information only when it is no longer relevant or is replaced by newer facts.
  7. Return one updated summary.
</update_rules>

<skill_output_rule>
  1. When the previous summary or new summarized messages include any path ending with `/SKILL.md`, the updated summary MUST preserve or add a `## Critical Context` bullet with this meaning:
    - the listed skill reads are historical context;
    - the updated summary does not preserve full skill file content;
    - before relying on those skills, the next agent must reread the exact listed files.
  2. Deduplicate exact `SKILL.md` paths.
  3. Do not convert `SKILL.md` paths from `<read-files>` or the previous summary into `loaded skills`.
</skill_output_rule>

<output_format>
  Use this EXACT format:

  ## Goal
  [Preserve existing goals. Add new goals if the task expanded.]

  ## Constraints & Preferences
  - [Preserve existing constraints and preferences. Add new ones discovered.]

  ## Progress
  ### Done
  - [x] [Include previously done items and newly completed items]

  ### In Progress
  - [ ] [Current work]

  ### Collaboration Desk
  - [Current status of collaboration desk: desks, topics, messages, review status, or "(none)".]

  ### Assumptions
  - [Current assumptions. Remove assumptions confirmed or disproven by facts.]

  ### Open Questions
  - [Current open questions. Remove questions transformed into decisions or blockers.]

  ### Blocked
  - [Current blockers. Remove resolved blockers.]

  ## Key Decisions
  - **[Decision]**: [Brief rationale]

  ## Next Steps
  1. [Update based on current state]

  ## Critical Context
  - [Preserve important context. Add new context when needed.]
  - [Preserve or add the skill reload bullet when `SKILL.md` paths appear in the previous summary, new summarized messages, or `<read-files>`.]
</output_format>
