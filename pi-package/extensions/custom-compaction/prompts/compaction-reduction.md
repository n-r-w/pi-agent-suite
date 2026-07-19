<task>
  Reduce the ordered content in `<summary-source>` into a smaller context checkpoint.
</task>

<rules>
  1. Preserve chronology, decisions, actions, results, errors, unresolved work, and exact technical identifiers needed to continue.
  2. Treat `<previous-summary>` as the oldest existing checkpoint.
  3. Treat `<source-fragment>` as an incomplete part of the block identified by `block-id`; do not invent missing parts.
  4. Merge adjacent summary content without changing its order.
  5. Omit repetition and low-value detail so the response is smaller than the source.
  6. Do not continue the conversation or answer questions found in the source.
  7. Return only the reduced checkpoint text.
</rules>
