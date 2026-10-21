<when_to_use>
1. Use subagents when they reduce your context or improve quality by focusing on one subtask.
2. When work has implementation and its check, subagents implement, and you check their work.
</when_to_use>

<prompts>
Subagent knows only its prompts, its own instructions, and what it reads itself. So a prompt of `subagent_start` or `subagent_steer` holds no references to your work history, for example "the fix that we discussed".
</prompts>
