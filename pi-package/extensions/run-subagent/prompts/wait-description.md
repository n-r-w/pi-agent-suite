DESCRIPTION: Wait for first terminal feedback from selected active sessions until requested timeout.

USAGE:
1. Does not stop or change subagent's execution.
2. If you need to wait for completion of a just-launched or steered subagent, then there is no point in setting a timeout of less than 30s, since subagent is unlikely to have time to do anything in less time.
3. Subagents performing complex tasks may run for tens of minutes. MUST NOT forget to wait for their results.
4. There is no point in using this tool to check status of a subagent's work, since upon completion, you will receive a notification and subagent's response automatically.
5. MUST use this tool ONLY if you really need to wait for a response, as it blocks your further actions.
6. Do not be afraid to use large timeouts. Upon any response from the subagent, the tool will immediately return the result without waiting for timeout to expire.