# Idea: Skill restoration after compaction

## Definitions

Terms are defined in `terms.md`.

## Context and Problem

See `problem.md`. After compaction, the content of skill files that the model loaded in the summarized range leaves the model context, and the model continues the task without the skill instructions.

## Goal

After compaction, the model continues the task with the instructions of the skills it had loaded before compaction, and neither the user nor the model loads them again.

## Scenarios

1. The model reads `gate-transition/SKILL.md` and `gate-transition/assets/problem.md`, then Pi compacts the session when the context reaches the threshold. The next model request contains both files.
2. The user loads a skill with `/skill:name` at the start of the session. After a later compaction, the model context contains the body of this skill.
3. The session is compacted a second time. The skill files that the first compaction returned stay in the model context.
4. `custom-compaction` exhausts its retries, and Pi compacts the session with standard compaction. The model context contains the skill files.
5. A subagent compacts its own session. The subagent context contains the skill files that the subagent had loaded.
6. The returned skill files do not fit below the auto-compaction threshold. The model receives the files that fit and a list of the others, which states that their content is absent from the context.

## Scope and Non-Scope

- In scope: skill files loaded with `read` and with `/skill:name`; every compaction, whether `custom-compaction` or Pi standard compaction produced it; the main agent and subagents.
- Out of scope: skill files read through `bash`; branch summaries created by `/tree` navigation; skill files loaded inside the retained suffix.

## Requirements

### Functional Requirements

- [X] FRQ-01: After every compaction, whether `custom-compaction` or Pi standard compaction produced it, the model context contains each skill file that was in the model context inside the summarized range. This covers files that the model read with `read`, skill bodies loaded with `/skill:name`, and files that a previous compaction returned to the context. The requirement applies to the main agent and to subagents, and it keeps holding after the session is reopened.
  - Origin: source. User request; user answers on loading ways and compaction kinds.
  - Goal: after compaction, the model continues the task with the skill instructions.
  - Goal achievement: Full. The model receives the same skill files it had before compaction, including files from skill subdirectories.
  - Feasibility: Confirmed. Pi notifies extensions after every compaction kind. Session records keep the path of each read file, and a `/skill:name` message keeps the `SKILL.md` path. An extension can add a message to the context that Pi stores in the session and replays when the session is reopened; one package extension already returns its instructions after compaction this way.
- [X] FRQ-02: A file counts as a skill file when it lies inside the directory of a skill from the Pi skill list. Example: `agent-rules/gate-transition/assets/problem.md` under the Pi skills directory returns to the context because `gate-transition` is in the list. A `gate-code/SKILL.md` in a project repository that the model edits as project code does not return.
  - Origin: source. User answer on the skill criterion.
  - Goal: after compaction, the model receives skill instructions and does not receive files that it edits as project code.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The Pi skill list contains the directory of each skill, and package extensions already receive this list before each agent run.
- [X] FRQ-03: The skill files that return after compaction take only the space below Pi's automatic compaction threshold that stays free after compaction. When not all skill files fit, the model receives a list of the files that did not return. The list states that the content of these files is absent from the context and that the model must read them before work that they concern. When no free space stays after compaction, the model receives only this list.
  - Origin: formulated. Follows from the size of skill files, a median of about 37,000 tokens per session at 4 characters per token, and from the user answer on files that do not fit.
  - Goal: returning skills does not cause consecutive compactions, and the model knows which skills it lacks.
  - Goal achievement: Partial. The model can skip reading the listed files; the user observed this with a plain path list.
  - Feasibility: Confirmed. Extensions know the model context window and the compaction settings, and the package already estimates request size in tokens.
- [X] FRQ-04: The package system prompt does not tell the model to read skills again after compaction.
  - Origin: source. User instruction.
  - Goal: the model spends no `read` calls on skills that are already in the context.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The instruction lies in the package system prompt template and can be removed.

### Non-Functional Requirements

None.

## Risks

- R1: The model can skip reading the files from the FRQ-03 list. In six live `pi` runs with `openai-codex/gpt-6.1-sol` at `medium` thinking and a simulated list, the model read the listed `SKILL.md` every time. Other models, long histories, and long lists remain unchecked.

## Open Questions

None.

## Technical Supplement

None.

## References

- `problem.md`
- `docs/extensions/custom-compaction.md`
- `docs/extensions/context-projection.md`
