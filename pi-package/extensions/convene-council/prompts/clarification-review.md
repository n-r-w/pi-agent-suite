<task>
  1. Review the opponent clarification.
  2. Compare the clarification with your previous answer.
  3. Return AGREE when the clarification resolves the substantive issue or confirms the same final conclusion.
  4. Return DIFF only when a blocking substantive disagreement remains.
  5. Return NEED_INFO only when specific missing information still prevents a decision.
  6. Do not use DIFF for wording differences, meta-comments about previous answers, or corrections that do not change the final conclusion.
</task>

<opponent_clarification>
{{clarification}}
</opponent_clarification>

<output_rules>
  1. Return exactly: <status>{AGREE|DIFF|NEED_INFO}</status><opinion>{text}</opinion>.
  2. Do not include text outside <status> and <opinion>.
  3. ENGLISH only. NO OTHER LANGUAGE IS ALLOWED.
</output_rules>
