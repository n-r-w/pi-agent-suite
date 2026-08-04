<task>
  Source above is a session transcript wrapped in <summary_source> tags.
  Extract unique project knowledge that should be remembered for future work.
</task>

<priority>
  Prefer strategic knowledge with high future impact:
  1. New constraints discovered during implementation.
  2. Changes in behavior caused by dependency or version differences.
  3. New algorithmic rules or invariants that future changes must respect.
  4. Non-obvious pitfalls and failure modes that can repeat.
</priority>

<output_contract>
  Return exactly one of:
  1. Exact token `NOT_FOUND` when no durable unique knowledge exists.
  2. Markdown in this exact structure:

  ## Strategic knowledge
  - ...

  ## Tactical knowledge
  - ...
</output_contract>

<category_rules>
  1. Strategic knowledge: stable high-leverage knowledge (core domain logic, key architectural constraints, long-lived invariants, major behavior changes).
  2. Tactical knowledge: important but volatile knowledge (active technical debt, unresolved defects, short-horizon caveats, frequently changing scenarios).
  3. Place each statement into exactly one category.
  4. Omit a category section only when it has no valid items.
</category_rules>

<quality_rules>
  1. Do not retell the session.
  2. Do not list routine implementation steps.
  3. Include only knowledge that would improve future decisions.
  4. Preserve exact names/identifiers when needed for correctness.
</quality_rules>
