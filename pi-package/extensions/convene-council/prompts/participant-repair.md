<task>Regenerate the response in the required format</task>

<output_rules>
  1. Return exactly: <status>{AGREE|DIFF|NEED_INFO}</status><opinion>{text}</opinion>
  2. Do not include text outside `<status>` and `<opinion>`.
</output_rules>
