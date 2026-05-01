<task>
  Review the opponent clarification.
  Decide whether you now agree, still disagree, or still need information.
</task>

<opponent_clarification>
{{clarification}}
</opponent_clarification>

<output_rules>
  1. Return exactly: <status>{AGREE|DIFF|NEED_INFO}</status><opinion>{text}</opinion>.
  2. Do not include text outside <status> and <opinion>.
</output_rules>
