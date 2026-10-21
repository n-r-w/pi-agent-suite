Ask separate model a question about saved conversation of specified subagent session, for example about progress of subagent or about details that its response lacks. Session may be active or finished. Subagent never receives question or answer, because separate model answers from saved conversation of subagent.

<usage>
1. Use this tool when information is insufficient and subagent does not need to act.
2. Present answer to others as conclusions of query, because answer holds conclusions of separate model about conversation of subagent.
3. When `subagent_steer` prompt relies on answer, state in prompt each fact from answer that subagent needs, for example exact command or file path.
4. Question holds no rules of work, for example "do not change files", because model has no tools and sees only saved conversation and question.
5. Each question holds all context that it needs, because each query is independent of previous queries.
</usage>