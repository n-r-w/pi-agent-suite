# Technical Solution: System prompt by kind of agent session

## Problem Statement
[problem.md](problem.md) describes the problem, and [prd.md](prd.md) holds the requirements. In short:
- Extension `system-prompt` renders one template for every session, so a subagent gets the rules for a conversation with a person.
- The extension replaces a custom prompt, so a council participant and a user with `--system-prompt` or `SYSTEM.md` lose their own prompt.
- Rule 3 of `<scope_control>` of the bundled template does not state what a report about a defect outside the task contains.

## Proposed Solution
The solution has four parts:
1. The extension skips each session with a custom prompt.
2. The template gets parts for one kind of session.
3. The bundled template uses these parts and gets the new rules about defects.
4. The documentation describes both changes.

### Redesign check
If the requirements had existed from the start, the extension would still render one template and skip sessions with a custom prompt, and the template would mark the blocks of each kind of session. The smallest change gives the same design, so the solution adds nothing beyond it.

### Kind of session
The extension classifies each session into one of two kinds:
- **main agent:** the process has no marker of a child agent process;
- **child agent:** the process has the marker. `run-subagent` sets it for each subagent, and `convene-council` sets it for each participant.

Reasons:
- The package already marks each child agent process by environment variable `PI_AGENT_SUITE_CHILD_AGENT_PROCESS`, and extensions `usage`, `footer`, `knowledge`, and `completion-sound` read it by function `isChildAgentProcess` of `shared/child-agent-environment.ts`. The extension follows this pattern: it reads the process environment in its own small module and passes it to the shared function.
- The marker of `run-subagent` alone (`PI_SUBAGENT_AGENT_ID`) would also meet FRQ-02. The shared marker covers each child agent process that the package starts. Such a process works on a task of another agent or extension and talks to no person, so the conversation rules do not fit any of them. A council participant has a custom prompt, so the next section skips its session before the kind of session matters.

The kind of a process does not change while the process runs, so the extension determines it once when it loads.

### Session with a custom prompt (FRQ-05)
Pi gives each handler of `before_agent_start` the prompt options of the session. Field `customPrompt` of these options holds the custom prompt from flag `--system-prompt` or from a file `SYSTEM.md` (`core/agent-session.js` and `core/resource-loader.js` of Pi). When this field has text, the handler of `system-prompt` returns no prompt, and Pi keeps the prompt that it builds from the custom prompt.

Consequences:
- The check depends neither on the template nor on the kind of session, so it applies to the bundled template and to each custom template.
- The handler keeps its reconciliation of active tools in such a session. Today the handler reconciles tools in each session before it renders the template, so skipping the reconciliation would change the set of tools of sessions with a custom prompt, and no requirement asks for this.
- The prompt of a selected agent still reaches the session. The handler of `shared/agent-runtime-composition.ts` appends the agent prompts to the prompt that Pi or `system-prompt` produced, and this change does not touch it.
- A user who has a file `SYSTEM.md` now loses the template of the extension in each session, including subagents in a project with `.pi/SYSTEM.md`. The user accepted this: such a user does not need the template.

### Parts of a template for one kind of session (FRQ-01, FRQ-02)
A template can mark a part that only one kind of session gets:
- `{{#mainAgent}}` and `{{/mainAgent}}` enclose a part for main agents;
- `{{#childAgent}}` and `{{/childAgent}}` enclose a part for child agents;
- text outside these parts goes to each session, as now.

The form `{{#name}}...{{/name}}` is the form of sections in Mustache templates, and it uses the delimiters that template variables already use.

Data structure: when the extension loads a template, it splits the template into a sequence of parts. Each part holds text and the kind of session that gets it, or no kind when the part goes to each session. When it renders the prompt, the extension takes the parts for the kind of the current session and then substitutes template variables, as it does now. So the extension parses the template once, and each later render only selects parts.

Validation: the template file is external input, so the extension checks it once when it loads it, next to the existing check of unknown variables. A template is invalid when a marker has no pair, when one part opens inside another, or when a marker names an unknown kind of session. For an invalid template, the extension reports the issue and keeps the original prompt of Pi, as it does now for a template that it cannot read. Rendering such a template would put a part for main agents into child agent sessions or show markers to the model.

Each marker stands on its own line in the bundled template. The extension removes such a line with its line break, so a part that a session gets reads as if the template had no markers. NRQ-01 needs this: the main prompt keeps its text.

Compatibility:
- A custom template without markers renders the same text as before (NRQ-02).
- A template with markers used with an older version of the package shows the markers as unsupported variables: the older version removes them with a warning and gives the text of both parts to each session. The bundled template ships with the package, so this concerns only a custom template that its author changed before updating the package.

### Content of the bundled template (FRQ-01 to FRQ-04)
The bundled template `pi-package/extensions/system-prompt/prompts/system.md` changes as section "Changes of the bundled template" of [prd.md](prd.md) describes:
- `<goal_guard>`, `<scope_control>`, and `<interaction_and_writing>` stand inside one part for main agents;
- rule 3 of `<scope_control>` gets the new text;
- block `<defects_outside_task>` stands inside a part for child agents, in the place of `<scope_control>`;
- the other blocks stay outside the parts.

### Documentation (FRQ-06)
`docs/extensions/system-prompt.md` describes:
- that the extension keeps the prompt of a session with a custom prompt, and the three sources of such a prompt: flag `--system-prompt`, `.pi/SYSTEM.md` of a trusted project, and `SYSTEM.md` of the Pi agent directory;
- the parts for one kind of session, what main agent and child agent mean, and when a template is invalid;
- the changed bundled template.

The row of `system-prompt` in the table of extensions in `README.md` says that the extension replaces the base prompt of Pi. It gets the condition "unless the session has a custom prompt", so the short description stays true.

### Checks
- Behavior tests in `pi-package/extensions/system-prompt/index.test.ts` cover the selection of parts by kind of session, the skip of a session with a custom prompt, the reconciliation of tools in such a session, and each case of an invalid template. They use fixture templates and check which parts reach the result, not the text of the bundled template, as rule 5 of "Testing rules" of `AGENTS.md` requires.
- NRQ-01 needs a one-time comparison during the implementation: the main prompt that the bundled template gives before the change and after it differs only in rule 3 of `<scope_control>`.
- QST-01 needs a run of real Pi.

## Overengineering and Overspecification Considerations
Elements and their reasons:
- Parts of a template for one kind of session: FRQ-01 and FRQ-02 need one bundled template that gives different blocks to main agents and child agents. The user chose this form over two template files, because two files would duplicate the common blocks.
- Validation of markers at load: without it, an error in a custom template puts the rules of main agents into child agent sessions without a warning.
- Classification of a session by the shared marker of a child agent process: the extension reuses the existing marker and function and adds no new marker.
- The skip of a session with a custom prompt: FRQ-05.
- Reconciliation of tools in a session with a custom prompt: it keeps the current set of tools of such sessions. Without it, this change would alter tools that no requirement names.
- The edit of `README.md`: without it, the short description of the extension contradicts FRQ-05.

The design adds no configuration parameter, no new marker of a process, and no second template file.

Overspecification: the document leaves to the implementer how the extension splits the template into parts, the wording of each issue that it reports, the name of the module that reads the process environment, and the fixtures of tests.

## Open Questions

### QST-01: Does a session with a custom prompt lose this prompt in a real run?
  - Purpose: confirm the conclusion that the code of Pi and of `system-prompt` gives. Without an answer, the change may fix a case that does not occur.
  - Impact: the skip of a session with a custom prompt.
  - Answer: the final system prompt of three sessions: Pi with `--system-prompt`, Pi in a project with `.pi/SYSTEM.md`, and a participant of `convene-council`. The same run after the change shows that each of them keeps its custom prompt.
  - Done: the code of Pi and of `system-prompt` was traced; see sections Evidence and Current State of [problem.md](problem.md).
  - Resolution: during the implementation, before and after the change of the extension, by real Pi with a temporary extension that dumps the system prompt, as rule 5 of "Validation rules" of `AGENTS.md` describes.

## References
- [problem.md](problem.md) - problem statement.
- [prd.md](prd.md) - requirements and the planned text of the bundled template.
- `pi-package/extensions/system-prompt/index.ts` - the extension that renders the template.
- `pi-package/shared/child-agent-environment.ts` - the marker of a child agent process.
- `pi-package/shared/agent-runtime-composition.ts` - the handler that appends agent prompts.
- `docs/extensions/system-prompt.md` - the documentation of the extension.
