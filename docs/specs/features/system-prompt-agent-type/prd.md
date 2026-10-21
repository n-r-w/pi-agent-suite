# Idea: System prompt by kind of agent session

## Definitions
- **Main agent:** the agent of a Pi session that a person runs and talks to.
- **Subagent:** an agent in a child Pi process that `run-subagent` starts. It works on a task of another agent and returns its result to that agent.
- **Custom prompt:** a session's system prompt supplied through CLI `--system-prompt` text or a file, a trusted project's `.pi/SYSTEM.md`, or the Pi agent directory's `SYSTEM.md`. A person or the extension starting the process supplies the prompt, for example `convene-council` for its participants. When the CLI flag is absent, Pi checks the trusted-project file before the agent-directory file.
- **Bundled template:** the system prompt template shipped with `system-prompt`, used when its configuration specifies no custom template.
- **Custom template:** a template that a user names in the config of `system-prompt`.
- **Common rules:** rules of the bundled template that fit any agent: safety, execution limits, skills, toolsets, and tool guidelines.
- **Conversation rules:** rules of the bundled template that describe work with a person: the goal guard, scope control, formatting, and communication with the user, including the question template.
- **Defect outside the task:** wrong behavior of code, configuration, a document, or data that an agent finds while it works on a task that does not include this behavior.

## Context and Problem
[problem.md](problem.md).

## Goal
- A person who installs the harness without custom agents receives the conversation rules in the main-agent session.
- Each subagent gets only rules that fit work on a task of another agent.
- A person learns from the message of the main agent what is broken when an agent finds a defect outside the task.
- Each session with a custom prompt retains the prompt that Pi builds from it.
- Main agents of existing users keep their behavior, except the rules that this change corrects.

## Scenarios
1. A person installs the harness, runs Pi without custom agents, and talks to the main agent.
2. The main agent starts a subagent, and the subagent works on its task and returns the result.
3. A subagent or the main agent finds a defect outside the task, and the main agent reports it to the person.
4. A person runs Pi with a custom prompt from CLI `--system-prompt`, a trusted project's `.pi/SYSTEM.md`, or the Pi agent directory's `SYSTEM.md`.
5. The main agent calls `convene-council`, and each participant works by the prompt that the council gives it.
6. A user with a custom template works as before.

## Scope and Non-Scope
In scope:
- the content and the structure of the bundled template: which rules each kind of session gets, and the rules about defects outside the task;
- the behavior of extension `system-prompt` in sessions with a custom prompt, with the bundled template and with custom templates;
- the documentation of extension `system-prompt`.

Out of scope:
- `ask-llm` and `consult-advisor`, because they start no child Pi process and do not use the template;
- the text of custom templates;
- other rules of the bundled template.

## Requirements

### Functional Requirements
- [X] FRQ-01: When the bundled template serves a session of a main agent without a custom prompt, the agent gets the common rules and the conversation rules.
  - Origin: source. The task requires conversation rules for a person who installs the harness without custom agents.
  - Goal: a person without custom agents receives the conversation rules.
  - Goal achievement: Full. The main agent gets the same set of rules as now.
  - Feasibility: Confirmed. The bundled template already holds these rules and serves each main session.
- [X] FRQ-02: When the bundled template serves a session of a subagent without a custom prompt, the agent gets the common rules and does not get the conversation rules.
  - Origin: source. The user approved a template that distinguishes the main agent and the subagent.
  - Goal: each subagent gets only rules that fit work on a task of another agent.
  - Goal achievement: Full. The subagent keeps the rules that fit any agent and loses the rules for a conversation with a person.
  - Feasibility: Confirmed. The package marks each child process of `run-subagent`, so the extension can identify subagent sessions.
- [X] FRQ-03: The bundled template requires a subagent to report each defect outside its task to its caller as a separate finding. The finding names where the defect is, under which condition it occurs, and what behavior it gives. The subagent does not reproduce the defect, design a fix, or fix it without approval of its caller.
  - Origin: formulated. Under FRQ-02, the subagent loses the conversation rule about findings outside the scope. The subagent therefore needs a role-specific reporting rule.
  - Goal: a person learns what is broken when an agent finds a defect outside the task.
  - Goal achievement: Partial. The subagent passes the defect to the main agent, and FRQ-04 makes the main agent describe it to the person.
  - Feasibility: Confirmed. The rule depends only on the text of the bundled template.
- [X] FRQ-04: The bundled template requires the main agent to report each defect outside the task that it or another agent found, also a defect that existed before the task or does not affect the task.
  1. The main agent reports the defect as a separate finding in the first message that ends its turn.
  2. The finding states what the person or the system does, what happens, and what must happen. It also names where the defect is and under which condition it occurs, and proposes a fix.
  3. The main agent takes the facts of the finding from the code that the finding names. It does not reproduce the defect, design a fix, or fix it without approval of the person.
  4. The finding names each fact that the main agent did not check.
  - Origin: source. The task requires a full report about each defect outside the task, because a person can miss a critical finding in an incomplete report. Reporting in the first message that ends the turn keeps the finding visible when work pauses. Limiting investigation to facts from the named code keeps fix-design work outside the task.
  - Goal: a person learns what is broken when an agent finds a defect outside the task.
  - Goal achievement: Full. The person gets the behavior, the cause, the proposed fix, and the unchecked facts at the next stop of the agent.
  - Feasibility: Confirmed. The rule depends only on the text of the bundled template.
- [X] FRQ-05: When a session has a custom prompt, extension `system-prompt` does not change the prompt that Pi builds for this session. This applies with the bundled template and with each custom template. Examples: a participant of `convene-council`, a person who runs `pi --system-prompt "Answer only in JSON"`, and a project with file `.pi/SYSTEM.md` all get the custom prompt with the parts that Pi adds itself.
  - Origin: source. The task requires preserving a custom prompt, including prompts supplied through `SYSTEM.md`.
  - Goal: each session with a custom prompt works by this prompt.
  - Goal achievement: Full. The extension preserves Pi's custom-prompt output. Active-tool reconciliation and runtime prompt contributions retain their behavior.
  - Feasibility: Confirmed. Before each agent turn, Pi supplies the custom prompt in the `before_agent_start` prompt options. Pi uses the same option for each source, so one condition covers CLI and both file sources. The pre-implementation checks in `facts.md` captured template replacement for CLI, trusted-project, agent-directory, and council participant prompts.

- [X] FRQ-06: The documentation of extension `system-prompt` states that the extension does not change the prompt of a session with a custom prompt, and names the sources of a custom prompt.
  - Origin: formulated. Under FRQ-05, the extension preserves custom prompts supplied through `SYSTEM.md`, so users need to know when their configured template applies.
  - Goal: each session with a custom prompt works by this prompt.
  - Goal achievement: Partial. The documentation tells such users why the template does not apply, and FRQ-05 gives the behavior itself.
  - Feasibility: Confirmed. The documentation of the extension already describes its configuration and its template.

### Non-Functional Requirements
- [X] NRQ-01: The system prompt of a main agent session without a custom prompt that uses the bundled template has the same text as before the change, except the rules that FRQ-04 changes.
  - Origin: source. The user: users who rely on the bundled template must not get a sudden change of behavior.
  - Goal: main agents of existing users keep their behavior.
  - Goal achievement: Full. The text of the prompt changes only in the rules about defects outside the task.
  - Feasibility: Confirmed. The change moves no rule out of the main session, and the text before and after the change can be compared.
- [X] NRQ-02: A custom template gives the same rendered text as before the change in each session without a custom prompt.
  - Origin: formulated. Users with a custom template are out of scope, except sessions with a custom prompt that FRQ-05 covers.
  - Goal: main agents of existing users keep their behavior.
  - Goal achievement: Full. Users with a custom template see the FRQ-05 correction only in sessions that previously lost their custom prompt.
  - Feasibility: Confirmed. FRQ-02, FRQ-03, and FRQ-04 concern only the bundled template, and FRQ-05 concerns only sessions with a custom prompt.

## Open Questions
None. QST-01 is resolved by the pre-implementation real Pi runs in [facts.md](facts.md), FND-02 and FND-03. Each custom prompt reached the structured prompt options and was absent from the final prompt. The council check invoked the actual registered tool and captured its child process before a provider request.

## Technical Supplement

### Changes of the bundled template
The bundled template is `pi-package/extensions/system-prompt/prompts/system.md`. Its blocks fall into three groups by the kind of session that gets them. A session with a custom prompt gets none of them.

| Block of the bundled template | Main agent | Subagent |
| --- | --- | --- |
| `<system>` | yes | yes |
| `<role>` | yes | yes |
| `<safety>` | yes | yes |
| `<execution_limits>` | yes | yes |
| `<goal_guard>` | yes | no |
| `<scope_control>`, with new rule 3 | yes | no |
| `<interaction_and_writing>`: `<formatting>` and `<user_communication>` | yes | no |
| `<defects_outside_task>`, new block | no | yes |
| `{{appendSystemPrompt}}` | yes | yes |
| `{{contextFiles}}` | yes | yes |
| `<skills>` | yes | yes |
| `{{toolsets}}` | yes | yes |
| `<tool_guidelines>` | yes | yes |

The extension retains the baseline block order. The child-only `<defects_outside_task>` block occupies the position of `<scope_control>`.

The bundled template retains the baseline block text except for the following two edits.

Baseline rule 3 of `<scope_control>`:
```text
3. Report relevant out-of-scope findings and proposed changes. Do not make those changes without user approval.
```

Rule 3 of `<scope_control>` after the change:
```text
3. Report each defect outside task that you or another agent found as separate finding, also defect that existed before task or does not affect task. Report it in first message that ends your turn.
    1) Finding states what user or system does, what happens, and what must happen. It also names file and condition that cause defect, and proposed fix. Example: "export of report with empty date returns error 500; service must save report without date; cause: function `buildReport` in `export.go` requires date".
    2) Take facts from code that finding names. Do not reproduce defect, design fix, or fix it without user approval.
    3) Name in finding each fact that you did not check.
```

New block for subagents:
```text
<defects_outside_task>
Report each defect outside task that you found as separate finding: file and condition that cause defect, and behavior that it gives. Do not reproduce defect, design fix, or fix it without user approval.
</defects_outside_task>
```

Rule 6 of `<brevity>` stays as it is. It tells the agent to leave out a fact that has no effect on the task, and the words "or does not affect task" of new rule 3 make an exception for defects outside the task.

### Facts of Pi and of the package
- Pi passes custom-prompt text to `before_agent_start` as `customPrompt`, including CLI `--system-prompt`, trusted-project `.pi/SYSTEM.md`, and agent-directory `SYSTEM.md` inputs. See `core/agent-session.js` and `core/resource-loader.js` in `@earendil-works/pi-coding-agent`. A handler result with `systemPrompt` replaces the whole prompt; see `core/extensions/runner.js`.
- Child processes of `run-subagent` have environment variable `PI_SUBAGENT_AGENT_ID` (`pi-package/shared/subagent-environment.ts`). Child processes of `run-subagent` and of `convene-council` have `PI_AGENT_SUITE_CHILD_AGENT_PROCESS` (`pi-package/shared/child-agent-environment.ts`).

## References
- [problem.md](problem.md)
- `docs/extensions/system-prompt.md`
- `docs/extensions/run-subagent.md`
