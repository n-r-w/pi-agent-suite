<task>
  This is the PREFIX of a turn that was too large to keep.
  The SUFFIX, which contains recent work, is retained.
  Summarize the prefix so the retained suffix has enough context.
</task>

<language>
  Use ENGLISH language ONLY, except for text where changing the language would change its meaning.
</language>

<summary_rules>
  1. Be concise.
  2. Preserve exact file paths, function names, commands, error messages, identifiers, and configuration keys.
  3. Focus only on information needed to understand the retained suffix.
  4. Return only the prefix summary.
</summary_rules>

<skill_output_rule>
  1. When the discarded prefix includes any path ending with `/SKILL.md`, the `## Context for Suffix` section MUST include one bullet with this meaning:
    - the skill was read in the discarded prefix;
    - this prefix summary does not preserve full skill file content;
    - before relying on that skill, the next agent must reread the exact listed file.
  2. List each exact `SKILL.md` path once.
  3. Do not describe these skills as loaded.
</skill_output_rule>

<output_format>
  Use this EXACT format:

  ## Original Request
  [What did the user ask for in this turn?]

  ## Early Progress
  - [Key decisions and work done in the prefix]

  ## Context for Suffix
  - [Information needed to understand the retained recent work]
  - [Skill reload bullet when the discarded prefix includes `SKILL.md` paths]
</output_format>
