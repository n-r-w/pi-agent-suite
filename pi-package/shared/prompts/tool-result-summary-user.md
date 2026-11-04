<task>
  Summarize `<tool_result>` for later task continuation after the full result is omitted from the main LLM context.
</task>

<source_reminder>
  Each line of the summary restates `<tool_result>`, so leave out each statement that only `<agent_tasks>` holds, for example a task, a finding, or a plan of the agent.
</source_reminder>

<output_reminder>
  Return only the summary in the format of `<output_format>` from the system prompt.
</output_reminder>
