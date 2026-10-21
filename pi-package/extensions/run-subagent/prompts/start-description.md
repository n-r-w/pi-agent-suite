Start subagent in new session. Tool returns numeric session ID after subagent accepts prompt. Subagent works in background, so you can do other work meanwhile. When subagent completes its work, its response reaches you as a notification without a tool call. `subagent_wait` also returns this response.

<usage>
1. Load a skill yourself. Do not start a subagent to read a skill and retell it to you.
2. Choose the lowest agent level that completes the subtask in one run, because a lower level is faster and cheaper, and a second run can cost more than one run of a stronger agent. Logical complexity of subtask sets level, and number of files does not raise it.
3. Start subagents in parallel only when no output of one subtask can change prompt, scope, sources, or acceptance criteria of another. When you are not sure, start them one after another.
4. Subagents that change code of one project in parallel break builds of each other and see changes of each other in git status, also when they change different files. Tell each of them which changes the others make.
</usage>

<prompt>
1. Prompt states goal and acceptance criteria and lets subagent choose how to work. It does not override instructions of subagent.
2. A file or another source that subagent can read goes into prompt as a reference. Prompt text holds only facts that subagent cannot read itself.
3. Prompt follows this format:
<goal><!-- End state that can be checked, for example "evidence base for analysis is built" --></goal>
<task><!-- What subagent does --></task>
<acceptance_criteria><!-- Requirements in EARS: `WHILE {pre-condition}, WHEN {trigger}, {actor} SHALL {behavior}` --></acceptance_criteria>
<context><!-- Facts and references to sources --></context>
<guidelines><!-- Other rules for this subtask, if any --></guidelines>
</prompt>