<task>
  Source above is a session transcript wrapped in <summary_source> tags.
  Extract unique project knowledge that should be remembered for future work.
</task>

<output_contract>
RETURN EXACTLY ONE OF:
1. EXACT token `NOT_FOUND` when no durable unique knowledge exists.
Examples:
BAD: `NOT_FOUND; The session did not contain durable knowledge worth extracting`. Why bad: output contains extra text beyond the required token.
GOOD: `NOT_FOUND`
2. In case unique knowledge is found, return markdown in this exact structure:
```
  ## Strategic knowledge
  ### {Topic X}
  - ...

  ## Tactical knowledge
  ### {Topic Y}

  ## Outdated knowledge
  <!-- Existing global or local knowledge that is outdated and should be removed -->
```
If a category has no valid items, keep the section and write: (none)
</output_contract>

<quality_gate>
1. [ ] Did not mix `NOT_FOUND` with other texts. If there are no unique insights, I returned only `NOT_FOUND` AND NOTHING ELSE.
2. [ ] Did not include in the output knowledge that does not have long-term value for the project.
</quality_gate>
