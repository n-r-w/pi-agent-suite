DESCRIPTION: Send a prompt to previously started subagent session.

USAGE:
1. Active session accepts steering in its current invocation.
2. Terminal session continues through new invocation of same session.
3. Can be used not only for steering, but also for discussion with subagents, obtaining additional opinions, etc.
4. Write prompt in language of texts of project: language that project rules set for documents and code comments, otherwise language of existing documents and comments. When task does not write or check text of project, use language of user. Code, identifiers, commands, paths, and quotations keep their own language.

CONSTRAINTS: MUST NOT be used to solve multiple subtasks in one session. Steering should be used to clarify and adjust ONE ATOMIC subtask.

