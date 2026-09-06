# Subagent built-in tool rendering

Pi 0.85.1 no longer resolves built-in renderers inside `ToolExecutionComponent`. The subagent presentation registry passed `undefined` for built-ins, which selected generic JSON rendering instead of native file titles and edit diffs.

The registry now takes renderers from the public `create*ToolDefinition` factories and passes display-only definitions to the component. It preserves Pi's call, result, and shell renderers without importing internal modules or enabling tool execution. Package and unknown-tool routing remain separate.

Regression tests in `pi-package/extensions/run-subagent/builtin-tool-rendering.test.ts` compare all seven built-in presentations with Pi's native definitions. They also check an edit title and diff in both collapsed and expanded views through the real `ToolExecutionComponent`, without file operations or model calls.
