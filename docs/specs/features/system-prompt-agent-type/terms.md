# Terms

- Main agent: the agent of a Pi session that a person runs and talks to.
- Child agent: an agent in a child Pi process that a package extension starts for work delegated by another agent or extension.
- Subagent: a child agent that run-subagent starts to work on a task of another agent and return its result.
- Council participant: a child agent that convene-council starts with the council participant prompt.
- Custom prompt: a session's system prompt supplied through CLI `--system-prompt` text or a file, a trusted project's `.pi/SYSTEM.md`, or the Pi agent directory's `SYSTEM.md`.
- Bundled template: the system prompt template shipped with the system-prompt extension.
- Custom template: a template named in the system-prompt extension configuration.
- Common rules: bundled-template rules for any agent, including safety, execution limits, skills, toolsets, and tool guidelines.
- Conversation rules: bundled-template rules for work with a person, including goal guard, scope control, formatting, and user communication.
- Defect outside the task: wrong behavior that an agent discovers while working on a task that does not include that behavior.
