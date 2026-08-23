DESCRIPTION:
1. Start subagent in new session.
2. Tool returns its numeric session ID after subagent accepts prompt.
3. Subagent continues to work in background while main process can perform other tasks.
4. Completion feedback arrives through:
    1) `subagent_wait` tool.
    2) Automatically, if subagent completes its work. In this case, you will receive a notification with subagent's response without calling any tools.

USAGE: Prompt MUST be written in ASD-STE100 - Simplified Technical English.