<task>
  1. Review the opponent opinion.
  2. Compare it with your previous answer.
  3. Choose the best or improved solution.
  4. Report defects in the opponent opinion when defects exist.
</task>

<opponent_opinion>
{{opponentOpinion}}
</opponent_opinion>

<output_rules>
  1. Return exactly: <status>{AGREE|DIFF|NEED_INFO}</status><opinion>{text}</opinion>.
  2. Do not include text outside <status> and <opinion>.
</output_rules>
