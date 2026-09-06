# Domain Glossary

- Workflow: A managed sequence of stages controlled by the workflow extension.
- Workflow tool: Any provider tool whose name starts with `workflow_`.
- Workflow state: Persisted data for an active or completed workflow.
- Workflow journal: The ordered model-facing workflow records in session history.
- Workflow journal continuity: Publication of records required by restored workflow state, independent of current agent selection and current workflow-tool visibility.
- Activation options: Catalog workflows that the model can activate through `workflow_activate`.
- Empty activation-options record: The model-facing message `<workflow_activation_options />`.
- Replacement record: An empty activation-options record that invalidates an earlier non-empty activation-options record in the same context segment.
- Redundant empty record: An empty activation-options record published when the same context segment contains no earlier non-empty activation-options record.
- Context segment: The provider-visible session history after the latest session start, branch summary, or compaction boundary.
