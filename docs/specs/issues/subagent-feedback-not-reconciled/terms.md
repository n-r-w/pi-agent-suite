# Domain Terms

- Calling agent: The agent that starts and directly owns a subagent session.
- Direct owner: The Pi session whose calling agent owns an owner-local subagent session ID.
- Terminal feedback: The success, failure, or abort result produced when one subagent invocation finishes.
- History feedback: Terminal feedback appended to the direct owner's conversation because no matching active `subagent_wait` can return it.
- Terminal session: A subagent session whose current invocation finished with success, failure, or abort.
- Active-session set: The subagent sessions that the calling agent currently considers active and eligible for `subagent_wait`.
- State reconciliation: Updating the calling agent's active-session set and available results after terminal feedback is delivered.
