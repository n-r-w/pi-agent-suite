# Domain Glossary

- **Workflow**: A validated stage graph with one current stage and a set of allowed transitions.
- **Active workflow**: A workflow with status `active` whose instructions govern the model's current work.
- **Current stage**: The final stage in the active workflow route.
- **Tool call**: One tool invocation emitted by a model response.
- **Tool loop**: Consecutive model responses and tool calls inside one agent run.
- **Workflow reminder**: A model-facing message that restates current active workflow state without changing that state.
- **Workflow journal**: The append-only sequence of hidden persistent messages with `customType: "workflow"`.
- **Context segment**: Provider-visible history after the latest compaction or branch summary boundary.
- **Reminder interval**: The configured number of tool calls between model-facing messages that carry current workflow state.
