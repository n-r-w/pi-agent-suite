<task>
  Source above is a session transcript wrapped in <summary_source> tags.
  Extract unique project knowledge that should be remembered for future work.
</task>

<output_contract>
  Return exactly one of:
  1. Exact token `NOT_FOUND` when no durable unique knowledge exists.
  2. Markdown in this exact structure:

  ## Strategic knowledge
  - ...

  ## Tactical knowledge
  - ...
</output_contract>


