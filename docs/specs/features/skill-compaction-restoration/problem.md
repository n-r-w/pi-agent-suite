# Problem statement

Terms are defined in `terms.md`.

## Context

Skills hold instructions that the model follows until the task ends: workflow stages, quality gates, coding standards. `SKILL.md` often tells the model to read other skill files of the same skill. The model loads skill files with the `read` tool. The user can force loading with `/skill:name`: Pi then inserts the `SKILL.md` body into the user message.

## Observed problem

When the model loaded a skill file inside the summarized range, the content of this file leaves the model context after compaction. The model continues the task without the instructions it followed before compaction, and in most cases the summary does not say which skills the model had loaded.

## Affected audience

- The main Pi agent and the subagents that `run-subagent` starts: both load the package with `custom-compaction`.
- The user who works with these agents.

## Evidence

- After compaction, Pi builds the model context from the system prompt, the compaction summary, and the retained suffix. The system prompt keeps only the skill list: name, description, and path. No extension of the package adds skill file content back.
- The bundled `custom-compaction` prompts tell the summarizer to drop skills: `compaction-system.md` forbids "SKILLS.md files content and links" in the summary, `compaction-reduction.md` keeps only the path of each loaded `SKILL.md` in intermediate summaries, and `compaction.md` with `compaction-update.md` forbid listing previously loaded resources in the `<done>` section.
- Pi standard compaction, which runs when `custom-compaction` is disabled or falls back, keeps only the `<read-files>` path list.
- Pi `serializeConversation` cuts each tool result to 2,000 characters in the summarizer input. One observed `read` result of a `SKILL.md` has 13,071 characters.
- A `/skill:name` body is part of a user message, so it leaves the context together with the summarized range.
- Sample of the 400 most recent local main-agent session files on 2026-10-20: 33 sessions had a first compaction that removed earlier `read` calls of `SKILL.md`, 321 calls in total that the retained suffix did not repeat. The summary named the skill directory for 66 of the 321 skills. Before the next compaction, the model read 201 of the 321 skills again (63%).
- In the same 33 sessions, the skill files that left the context took from 15,502 to 225,892 characters per session, with a median of 148,928 characters.

## Impact

- The model spends an extra `read` call and a model turn on each skill it reads again: 201 re-reads in 33 sessions.
- The model can read again only the skills it knows about. In 255 of the 321 cases, the summary did not name the skill.
- When the model does not read a skill again, it continues the task without the skill instructions, and its work can violate them. The user has to notice this and ask the model to load the skills again.

## Current state

Before compaction, `context-projection` keeps `read` results of skill files complete in model requests. Compaction removes these results from the context and keeps at most the skill path in the summary, when the summarizer model names it. The `system-prompt` template tells the model to read `SKILL.md` only with `read` and to read it again when its text is no longer in the context, for example after compaction.

## Desired state

After compaction, the model context contains the skill files that the model had loaded before compaction. Neither the user nor the model has to load them again.

## Problem boundary

- Covered: skill files that the model loaded with `read` or the user loaded with `/skill:name`; every compaction, whether `custom-compaction` or Pi standard compaction produced it; the main agent and subagents.
- Not covered: skill files read through `bash`, because the system prompt forbids this way; branch summaries created by `/tree` navigation; skill files loaded inside the retained suffix, because they stay in the context.

## Assumptions

- Some of the 120 skills that the model did not read again after compaction were still needed for the task. Nobody checked this.
- The model follows skill instructions less often after compaction. Nobody measured this.

## Open questions

None.
