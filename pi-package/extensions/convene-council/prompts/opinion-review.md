<task>
  1. Review the opponent opinion.
  2. Compare the opponent's final conclusion with your previous answer.
  3. If the final conclusion is the same, return AGREE and include any non-blocking correction inside <opinion>.
  4. Return DIFF only for a blocking substantive defect that changes the final conclusion.
  5. Do not use DIFF for wording differences, meta-comments about previous answers, or corrections that do not change the final conclusion.
</task>

<opponent_opinion>
{{opponentOpinion}}
</opponent_opinion>

<output_rules>
  1. Return exactly: <status>{AGREE|DIFF|NEED_INFO}</status><opinion>{text}</opinion>.
  2. Do not include text outside <status> and <opinion>.
  3. ENGLISH only. NO OTHER LANGUAGE IS ALLOWED.
</output_rules>
