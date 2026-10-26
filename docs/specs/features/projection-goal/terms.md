# Terms

- Projection: `context-projection` replaces old large tool results in the provider context of the main agent with shorter text. The session file keeps the full results.
- Projection summary: the text that a separate summary model writes for one tool result. The main agent sees it in place of the full result after projection, and the compaction model reads it in place of the full result during compaction.
- Current tasks: the work that the agent of a session is doing and has not finished, as the session history shows it.
- Task model: the model that reads the current session and names the current tasks and the goal of the agent.
