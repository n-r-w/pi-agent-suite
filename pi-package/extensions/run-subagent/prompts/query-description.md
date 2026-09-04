DESCRIPTION: Ask question based on current state of specified subagent session. Use when information is insufficient and you need to clarify something without steering subagent's work.

USAGE:
1. To get information about current progress of subagent.
2. To clarify details of subagent's work if its answer is insufficient.
3. Can be called for both an active subagent and one that has completed its work.
4. Question MUST be written in ASD-STE100 - Simplified Technical English.

CONSTRAINTS:
1. Tool does not change state of subagent session and does not control it.
2. Tool does not support any commands (e.g., reading files, etc.), it can only operate on content of subagent session context.
3. MUST NOT add requirements unrelated to query, e.g., "Do not change files". It makes no sense, since tool cannot use commands anyway.
4. Queries are stateless. Each question MUST be self-contained and MUST NOT depend on prior query answers.