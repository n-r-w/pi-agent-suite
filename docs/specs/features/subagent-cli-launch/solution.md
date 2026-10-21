# Technical Solution: Launch of a subagent from the command line

## Problem Statement
[problem.md](problem.md) and requirements [prd.md](prd.md). Terms are in [terms.md](terms.md).

## Proposed Solution
run-subagent owns the new CLI flag `--subagent <id>` and applies the named subagent definition in a process without a Pi parent. It puts the definition into the selected-agent slot of `agent-runtime-composition`, so the paths that a main process already uses deliver the prompt, tools, workflows, callable subagents, and model of the agent. `agent-runtime-composition` also tells other extensions that the process runs a launched subagent: main-agent-selection then does nothing, and system-prompt gives the process the child-agent role.

### Exchange of launch requests between extensions
Methods for FRQ-01, FRQ-02, and FRQ-03.

- Facts:
  - The Pi loader returns a flag value only to the extension that registered the flag (`getFlag` in `core/extensions/loader.js` of `@earendil-works/pi-coding-agent` checks `extension.flags`). So run-subagent alone reads `--subagent`, and main-agent-selection alone reads `--agent`.
  - Pi loads each extension with its own copy of the shared modules. The only channel between extensions is the event bus, and `getAgentRuntimeComposition` in `pi-package/shared/agent-runtime-composition.ts` already shares one composition through it.
  - `pi-package/package.json` lists main-agent-selection before run-subagent, so the `session_start` handler of main-agent-selection runs before the handler of run-subagent.
- Method: `agent-runtime-composition` holds two resolvers that the owners of the flags register when they load. run-subagent registers a resolver that returns the value of `--subagent`, and main-agent-selection registers a resolver that returns the value of `--agent`. Each extension calls a resolver when it needs the value, so the order of `session_start` handlers does not matter.
- Alternative: both extensions register flag `subagent`. The loader keeps one value per flag name, so both would read it. The solution rejects it, because two owners of one CLI flag contradict the separation of launch options that FRQ-01 requires.

### Application of the subagent definition
Methods for FRQ-01 and FRQ-03.

- Method: in `session_start`, when `--subagent` has a value, run-subagent:
  - finds the definition in the agent registry among definitions with `type: subagent` or `type: both`;
  - resolves the model and thinking level of the definition by the same rules that `resolveLaunchConfiguration` in `pi-package/extensions/run-subagent/agent-policy.ts` uses for a child, and applies them to the session as main-agent-selection applies the model of a main agent;
  - fills the selected-agent slot of `agent-runtime-composition` with the prompt, tools, workflows, callable subagents, and model of the definition.
- Effects of the slot, from the current code:
  - `agent-runtime-composition` appends the prompt of the slot to the system prompt and applies its tools;
  - workflow of a process without the child marker reads the allowed workflows from the slot (`pi-package/extensions/workflow/index.ts`);
  - `resolveEffectiveCallableAgentPolicy` of run-subagent takes the callable subagents from the slot when no child agent ID is set;
  - usage records the agent ID of the slot for the session.
- Alternative: apply the definition through the paths of a supervised child, where the prompt and tools come from `PI_SUBAGENT_*` variables. The solution rejects it, because workflow and usage of a process without the child marker read only the slot, and the marker itself makes them wait for a Pi parent.
- Rename of the slot: the slot and its types are named for a main agent, for example `setMainAgentContribution`, `getMainAgentContribution`, `MainAgentContribution`, and `MainAgentRuntimeInfo`, and after this change they also hold a launched subagent. The solution renames them for the selected agent of the session, for example `setSelectedAgentContribution`. The slot is internal to the package, so the rename changes no contract outside it: it touches `agent-runtime-composition` and its readers in main-agent-selection, run-subagent, workflow, usage, and footer, with their tests. Names inside main-agent-selection, for example `loadSelectableAgents` and the name of the extension itself, stay as they are, because this extension selects only main agents.
- In a process with a launched subagent, main-agent-selection skips the restoration of the saved agent and flag `--agent`, as it does in a supervised child process. It also leaves the slot unchanged on `/agent`, on its shortcut, and for a pending selection.
### Agent role
Method for FRQ-02.

- Fact: system-prompt chooses the role once when it loads, and selects the template sections in `before_agent_start`.
- Method: system-prompt determines the role in `before_agent_start`. The role is child agent when the process has the child marker or when `agent-runtime-composition` reports a launched subagent.
- The other readers of the child marker (usage, knowledge, footer, cmux, completion-sound, workflow, and algorithms) keep their behavior. A process with a launched subagent has no Pi parent, so for them it stays a root process.

### Delegation depth
Method for FRQ-05.

- Fact: `readCurrentDepth` in `pi-package/extensions/run-subagent/entry-config.ts` reads `PI_SUBAGENT_DEPTH` and returns 0 without it. `resolveLaunchConfiguration` gives a child the depth of its parent plus 1, and `filterSubagentTools` removes subagent tools when the depth reaches `maxDepth`.
- Method: run-subagent gives a process with a launched subagent depth 1 when `PI_SUBAGENT_DEPTH` is absent. Its own children then get depth 2.

### Failure of the launch
Method for FRQ-03 and FRQ-04.

- Fact: main-agent-selection already holds incoming input until the start of a session settles: its `input` handler waits for the restoration and handles the input itself after a failed restoration.
- Method: run-subagent holds incoming input in the same way until it has applied the definition. When it cannot apply it, run-subagent writes the reason to stderr, handles each input without a run of the agent, and requests shutdown of the process by `ctx.shutdown()`. Reasons include:
  - no definition with the ID;
  - a definition with `type: main` or an invalid definition;
  - a model of the definition that Pi cannot resolve or has no credentials for;
  - `--agent` set in the same process;
  - run-subagent disabled by `enabled: false` in its configuration, so it cannot apply the definition.
- Fact, from real Pi 1.3.0 runs: `ctx.shutdown()` ends a print-mode process with exit code 0, and in RPC mode it ends the process with exit code 0 after the next command of the launcher or when stdin closes. So run-subagent sets exit code 1 for the end of the process after a failed launch. In RPC mode, the process ends at the first command of the launcher, before any run of the agent. An end with no input at all would need `process.exit` in `session_start`, which skips the `session_start` and `session_shutdown` handlers of other extensions.
- Stderr is the only output that RPC and print modes deliver to the launcher without its own protocol. A `warning` notification reaches an RPC launcher only when it handles extension UI requests.

### Compatibility
Method for NRQ-01.

- Each new branch runs only when `--subagent` has a value. Without the flag, run-subagent, main-agent-selection, and system-prompt follow their current code paths.
- Checks: the existing tests of the three extensions, and a real Pi run by rule 5 of "Testing rules" in `AGENTS.md`. The run dumps the system prompt and active tools of a main agent, of a subagent of run-subagent, and of a launched subagent.

### Documentation
- `docs/extensions/run-subagent.md`: flag `--subagent`, its errors, and the depth of a launched subagent.
- `docs/extensions/main-agent-selection.md`: behavior in a process with a launched subagent.
- `docs/extensions/system-prompt.md`: the role rule in section "Role sections".

## Overengineering and Overspecification Considerations
- Resolver of `--subagent` in `agent-runtime-composition`: main-agent-selection and system-prompt need the value, and the loader shows a flag only to its owner. FRQ-02 and FRQ-03 need it.
- Resolver of `--agent` in `agent-runtime-composition`: run-subagent needs to detect both flags for the error of FRQ-03.
- Holding of input until the definition is applied: FRQ-04 forbids work of the agent before the error.
- Rename of the selected-agent slot: the requirements can be met without it, and the task requires it, so that the names of the slot describe each agent that it holds.
- No other element goes beyond the smallest change that meets the requirements.
- The implementer decides: the names of the composition methods, the text of error messages, the exit code if `ctx.shutdown()` allows a choice, and the layout of tests.

## Open Questions

None.

## References
- `pi-package/shared/agent-runtime-composition.ts` - shared slot of the selected agent and exchange through the event bus.
- `pi-package/extensions/run-subagent/agent-policy.ts` - launch configuration of a child and callable-agent policy.
- `pi-package/extensions/main-agent-selection/index.ts` - flag `--agent`, restoration, and the input gate.
- `pi-package/extensions/system-prompt/index.ts` - role selection and template rendering.
- `core/extensions/loader.js` of `@earendil-works/pi-coding-agent` - scope of `getFlag`.
