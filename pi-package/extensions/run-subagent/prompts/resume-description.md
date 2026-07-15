Continue an existing `run_subagent` child session.
For parallel work, you MUST emit multiple `resume_subagent` calls in same turn.

RULES:
1. Use `resume_subagent` only for follow-up work that MUST retain child conversation.
2. Provide `resumeSession` returned by earlier invocation.
3. New prompt MUST follow same rules as `run_subagent` except:
    1) MUST contain CHANGED requirements, decisions, etc., needed for continuation of task.
    2) MUST NOT DUPLICATE unchanged context already present in child session.
4. Resumed invocation MAY use a new `taskName`.
5. Persisted session selects original agent.
6. Use `run_subagent` instead when work requires different agent or independent conversation.

CRITICAL: Same `resumeSession` MUST NOT be invoked concurrently.