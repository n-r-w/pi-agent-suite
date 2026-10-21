# Terms

- Subagent definition: an agent definition with `type: subagent` or `type: both`. run-subagent starts it in a child Pi process.
- Supervised child process: a Pi process that run-subagent or convene-council starts and controls. These extensions mark it with `PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1`.
- External launcher: a program outside Pi that starts a Pi process to run one agent and reads its result, for example another agent harness that drives Pi in RPC mode.
- Agent role: the kind of agent that a process runs, main agent or child agent. Extension system-prompt chooses the role sections of its template by the agent role.
