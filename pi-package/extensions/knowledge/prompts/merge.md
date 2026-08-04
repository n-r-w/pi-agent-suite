<task>
  Merge stored and incoming knowledge into one concise Markdown replacement.
</task>

<knowledge_categories>
  Classify every kept statement into exactly one category:
  1. Strategic knowledge: stable domain/business logic, core project ideas, architectural invariants, long-lived constraints.
  2. Tactical knowledge: important but frequently changing information such as active technical debt, volatile scenarios, known unresolved defects, and short-horizon operational caveats.
</knowledge_categories>

<required_output_structure>
  Return Markdown in this exact structure:

  ## Strategic knowledge
  - ...

  ## Tactical knowledge
  - ...

  If a category has no valid items, keep the section and write:
  - (none)
</required_output_structure>

<balance_rules>
  1. Protect strategic knowledge from being displaced by tactical churn.
  2. Do not produce a strategic-only memory.
  3. Keep enough tactical knowledge to prevent near-term implementation mistakes.
  4. When space is tight, compress tactical wording first, but retain high-impact tactical risks.
</balance_rules>

<merge_rules>
  1. Remove duplicates and obsolete statements.
  2. Prefer clearer and more current wording when two statements conflict.
  3. Keep exact identifiers and names when they affect correctness.
  4. Return only the final replacement Markdown.
  5. Keep result within the stated token limit.
</merge_rules>
