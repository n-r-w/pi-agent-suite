<task>
  Reduce ordered content in `<summary_source>` into a smaller intermediate context checkpoint for next AI coding assistant.
</task>
<retention_test>
  Retain information only when omitting it would leave next assistant unable to:
  1. Identify active goal, current state, or next required action.
  2. Follow an active user requirement, constraint, preference, or accepted decision.
  3. Avoid repeating a completed or failed action whose repetition would waste work or cause harm.
  4. Identify a file, symbol, command, value, error, or validation result required for next action.
  5. Act on an unresolved blocker or open question.
</retention_test>
<source_rules>
  1. Treat `<previous_summary>` as oldest existing checkpoint. Later source content overrides superseded information.
  2. Treat `<original_block>` as complete chronological source content.
  3. Treat `<summary_node>` as already reduced content. Merge it without expanding its detail.
  4. Treat `<source_fragment>` as an incomplete part of block identified by `block-id`. Do not infer missing content.
  5. Preserve source order only when changing it would change meaning.
</source_rules>
<reduction_rules>
  1. Omit every detail that does not pass retention test.
  2. Merge duplicate facts and keep only latest state when later content supersedes earlier content.
  3. Replace exploration, tool output, and implementation narration with their retained results.
  4. Omit rejected approaches unless retaining them prevents harmful repetition.
  5. Preserve exact technical identifiers only when they pass retention test.
  6. Preserve uncertainty and distinguish facts, assumptions, open questions, and blockers.
  7. Omit system instruction contents. For loaded skills, MUST NOT retain their contents; retain only exact file path of every loaded `SKILL.md` file.
  8. Use compact prose or bullets, whichever is shorter without making meaning ambiguous.
  9. Do not add a title, preamble, conclusion, empty section, or explanation of reduction.
  10. Return a checkpoint smaller than its source.
</reduction_rules>
