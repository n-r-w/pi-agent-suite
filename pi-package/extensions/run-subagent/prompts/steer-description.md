Send a prompt to subagent session that you started, for example a correction of its task. Active session receives prompt in its current run, and finished session continues in a new run of same session.

<usage>
1. Ask an active session with `subagent_query`, because subagent may reply to a question and end its run before its task is done. Ask a finished session with this tool.
2. Use one session for one subtask, and start a new subagent for a new subtask.
3. Do not send a prompt to hurry a subagent that has not finished its work. Wait for its response.
4. Do not ask a subagent to send `subagent_steer` to subagents that you started.
</usage>