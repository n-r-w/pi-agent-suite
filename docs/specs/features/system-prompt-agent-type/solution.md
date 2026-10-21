# Technical Solution: System prompt by kind of agent session

## Problem Statement
[problem.md](problem.md) describes the problem, and [prd.md](prd.md) holds the requirements. In short:
- Without role selection, `system-prompt` renders the conversation rules for subagents as well as main agents.
- Before UNT-01, the extension replaced custom prompts from CLI `--system-prompt`, a trusted project's `.pi/SYSTEM.md`, and the Pi agent directory's `SYSTEM.md`. Council participants also lost their custom prompts.
- Rule 3 of `<scope_control>` of the bundled template does not state what a report about a defect outside the task contains.

## Proposed Solution
The solution has four parts:
1. For a session with a nonempty custom prompt, the extension reconciles active tools and returns no template replacement.
2. The template gets parts for one kind of session.
3. The bundled template uses these parts and gets the new rules about defects.
4. The documentation describes both changes.

### Redesign check
A design built with these requirements from the start would use one template with role-specific sections and preserve Pi's custom prompts. The proposed handler condition and section selection meet those requirements without an additional template or configuration flag.

### Kind of session
The extension classifies each session into one of two kinds:
- **main agent:** the process has no marker of a child agent process;
- **child agent:** the process has the marker. `run-subagent` sets it for each subagent, and `convene-council` sets it for each participant.

Reasons:
- The package already marks each child agent process by environment variable `PI_AGENT_SUITE_CHILD_AGENT_PROCESS`, and extensions `usage`, `footer`, `knowledge`, and `completion-sound` read it by function `isChildAgentProcess` of `shared/child-agent-environment.ts`. The extension follows this pattern: it reads the process environment in its own small module and passes it to the shared function.
- The marker of `run-subagent` alone (`PI_SUBAGENT_AGENT_ID`) would also meet FRQ-02. The shared marker covers each child agent process that the package starts. Such a process works on a task of another agent or extension and talks to no person, so the conversation rules do not fit any of them. A council participant has a custom prompt, so the next section skips its session before the kind of session matters.

The kind of a process does not change while the process runs, so the extension determines it once when it loads.

### Session with a custom prompt (FRQ-05)
Pi supplies the session's prompt options to each `before_agent_start` handler. The `customPrompt` field contains text from CLI `--system-prompt`, a trusted project's `.pi/SYSTEM.md`, or the Pi agent directory's `SYSTEM.md`. See Pi's `core/agent-session.js` and `core/resource-loader.js`. For a truthy `customPrompt`, the ready-template handler reconciles active tools and returns no replacement. Pi therefore retains the prompt it builds from the custom prompt. An empty custom-prompt string permits template rendering.

Consequences:
- The check depends neither on the template nor on the kind of session, so it applies to the bundled template and to each custom template.
- The ready-template handler retains active-tool reconciliation before the custom-prompt condition. Tool availability therefore remains subject to the runtime policy.
- Runtime composition still appends the selected-agent prompt and eligible tool prompt contributions to the prompt from Pi or `system-prompt`. See `pi-package/shared/agent-runtime-composition.ts`, `AgentRuntimeCompositionImpl`.
- When Pi supplies a custom prompt from `SYSTEM.md`, the extension preserves Pi's prompt in that session, including subagent sessions that load a trusted project's `.pi/SYSTEM.md`.

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

The `system-prompt` row in `README.md` states that the extension replaces Pi's base prompt unless the session has a custom prompt. The extension documentation names CLI and both `SYSTEM.md` sources.

### Checks
- UNT-01 behavior tests in `pi-package/extensions/system-prompt/index.test.ts` cover custom-prompt preservation, tool reconciliation, selected-agent prompt contributions, and absent or empty custom prompts. UNT-02 tests cover role-section selection and invalid templates. These feature tests use synthetic fixture values and check rendering logic. They preserve the project prohibition on testing prompt content.
- NRQ-01 needs a one-time comparison during the implementation: the main prompt that the bundled template gives before the change and after it differs only in rule 3 of `<scope_control>`.
- QST-01 is resolved by real Pi runs in `facts.md`. Repeat the same probes after implementation to check custom-prompt preservation and active tools.

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

None. QST-01 is resolved by the pre-implementation probes in [facts.md](facts.md). CLI, trusted-project, agent-directory, and actual council participant custom prompts were present in structured options and absent from the final runtime prompt. The debug extension recorded active tools and exited before provider calls. Repeat these observations after implementation.

## References
- [problem.md](problem.md) - problem statement.
- [prd.md](prd.md) - requirements and the approved text of the bundled template.
- `pi-package/extensions/system-prompt/index.ts` - the extension that renders the template.
- `pi-package/shared/child-agent-environment.ts` - the marker of a child agent process.
- `pi-package/shared/agent-runtime-composition.ts` - the handler that appends agent prompts.
- `docs/extensions/system-prompt.md` - the documentation of the extension.
