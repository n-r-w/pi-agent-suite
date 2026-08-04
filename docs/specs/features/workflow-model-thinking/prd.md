# Idea: Workflow model and thinking settings

## Requirements

1. Settings are available only for ready-made workflows from the YAML catalog.
2. A workflow and each of its stages can define the following nested object:
   ```yaml
   model:
     id: provider/model
     thinking: high
   ```
3. `model.id` and `model.thinking` are independently optional.
4. Settings are applied when a workflow is activated and when a stage transition occurs.
5. Each parameter uses this precedence order:
   `stage → workflow → agent → current Pi runtime value`.
6. When a parameter is omitted at one level, the value from the next level is used.
7. When a parameter is omitted at every level, the current Pi runtime value is preserved.
8. A model identifier uses the `provider/model` format.
9. A thinking level uses one of these values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
10. One shared model and thinking contract is used by every configuration boundary that accepts these parameters.
11. An unknown model or unsupported thinking level causes Pi to return an error during workflow execution.
12. The workflow does not perform an automatic fallback.
13. The LLM does not select a model independently.

## Open Questions

None.
