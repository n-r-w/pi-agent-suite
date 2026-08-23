<task>
1. Analyze the question in `<question>`
2. Read the context file.
3. Analyze additional information if needed.
4. Provide your opinion about the question based on the context and your analysis.
</task>

<question>
{{question}}
</question>

<contextFilePath>
1. This file contains the history of events related to the given question.
2. It may include various documents, results of tool calls, exchange of opinions between participants, and other information that may be useful for making a decision on the question.
3. Consider this file as a package of documents that you need to study to understand all aspects of the question and make an informed decision.

File Path:
`{{contextFilePath}}`
</contextFilePath>

<context_instructions>
1. Before deciding, you MUST read the file at `<contextFilePath>` with the `read` tool.
2. If the `read` result is truncated or indicates that more content remains, continue reading the same file with `offset` until you have the needed context.
3. If `<contextFilePath>` is too big, recommend switching to `grep`, but BE CAREFUL to not miss any important information. `grep` is your last resort.
4. Treat the context file as evidence for this council question.
5. Do not repeat the full context file in your answer.
</context_instructions>

<constraints>
MUST be written in ASD-STE100 - Simplified Technical English.
</constraints>
