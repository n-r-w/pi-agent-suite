<task>
  1. Analyze the opponent's opinion.
  2. If it differs from yours, try to understand why:
    1) Explore the opponent's arguments and compare them with yours.
    2) Check if you missed any important facts, context, or made a logical error.
    3) If you find that the opponent's opinion is more justified, acknowledge it and explain why you are changing your opinion.
    4) If you believe your opinion is still justified, explain why you disagree with the opponent, pointing to specific arguments and facts that support your position.
  3. Return the result:
    1) If the final conclusion is the same, return AGREE and include any non-blocking correction inside `<opinion>`.
    2) Return DIFF only for a blocking substantive defect that changes the final conclusion. MUST clearly explain the specific reason for the disagreement in `<opinion>`.
    3) Do not use DIFF for wording differences, meta-comments about previous answers, or corrections that do not change the final conclusion.
</task>

<opponent_opinion>
{{opponentOpinion}}
</opponent_opinion>

<output_rules>
  1. Return exactly: <status>{AGREE|DIFF|NEED_INFO}</status><opinion>{text}</opinion>.
  2. Do not include text outside <status> and <opinion>.
  3. ENGLISH only. NO OTHER LANGUAGE IS ALLOWED.
</output_rules>
