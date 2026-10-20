# Terms

- Skill: a directory with a `SKILL.md` file. Pi builds the skill list, and the system prompt shows each skill by name, description, and `SKILL.md` path; either Pi's default prompt or the `system-prompt` extension renders this list. The model reads the skill body only when a task needs it.
- Skill file: `SKILL.md` of a skill or any other file inside the skill directory, for example `gate-transition/assets/problem.md`.
- Summarized range: session messages that a compaction replaces with a summary.
- Retained suffix: session messages after the summarized range. They stay in the model context unchanged after compaction.
