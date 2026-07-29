DESCRIPTION: Ask question based on current state of specified subagent session.

USAGE:
1. To get information about current progress of subagent.
2. To clarify details of subagent's work if its answer is insufficient.
3. Can be called for both an active subagent and one that has completed its work.

CONSTRAINTS:
1. Tool does not change state of subagent session and does not control it.
2. Tool does not support any commands (e.g., reading files, etc.), it can only operate on content of subagent session context.
3. MUST NOT add requirements unrelated to query, e.g., "Do not change files". It makes no sense, since tool cannot use commands anyway.