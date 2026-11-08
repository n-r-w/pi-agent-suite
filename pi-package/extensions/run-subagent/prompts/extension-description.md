<when_to_use>
1. Use subagents when they reduce your context or improve quality by focusing on one subtask.
2. When work has implementation and its check, subagents implement, and you check their work.
</when_to_use>

<prompts>
1. Subagent knows only its prompts, its own instructions, the project rules of its `cwd`, and what it reads itself. So a prompt of `subagent_start` or `subagent_steer` holds no references to your work history, for example "the fix that we discussed".
2. A prompt holds only facts that change what subagent does or returns. Facts that change nothing for subagent, for example your stage, commit policy, your later check of result, history of approvals, and reasons of your decisions, stay out of it. Example: "I will check your fix before the commit. The user approved the plan yesterday. Fix finding 2 of `docs/review.md`." becomes "Fix finding 2 of `docs/review.md`."
</prompts>
