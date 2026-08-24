# Domain Glossary

- **Workflow**: A validated stage graph with one current stage and a set of allowed transitions.
- **Active workflow**: A workflow with status `active` whose instructions govern the model's current work.
- **Current stage**: The final stage in the active workflow route.
- **Tool call**: One tool invocation emitted by a model response.
- **Reasoning turn**: One completed assistant turn whose final message contains reasoning text, a reasoning signature, or a redaction marker.
- **Activity unit**: One completed tool call, or one completed reasoning turn when that turn has no tool calls.
- **Tool loop**: Consecutive model responses and tool calls inside one agent run.
- **Workflow reminder**: A model-facing message that restates current active workflow state without changing that state.
- **Workflow journal**: The append-only sequence of hidden persistent messages with `customType: "workflow"`.
- **Context segment**: Provider-visible history after the latest compaction or branch summary boundary.
- **Reminder interval**: The configured number of activity units between model-facing messages that carry current workflow state.
