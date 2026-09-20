# Domain Terms

- Migration to Pi 0.86.1: The repository transition from Pi 0.85.1 to Pi 0.86.1.
- Preliminary finding: A statement in `analysis.md` whose accuracy has not yet been verified.
- Compatibility issue: A Pi 0.86.1 change that causes existing repository code to build or behave differently than it does with Pi 0.85.1.
- Technical solution: A justified description of the changes needed for the migration after the preliminary findings have been verified.
- Functional capability: An operation that a repository extension makes available to its users or to another repository component.
- Observable behavior: An extension result, side effect, interaction, or failure that can be detected through its public interfaces or user interface.
- Blocker: A conflict that prevents the migration from preserving a functional capability or observable behavior and requires a separate user decision before design continues for the affected area.
- System message: A Pi message with `role: "system"` that carries system prompt content, named prompt sections, or tool-set changes.
- Transcript context: The provider-facing Pi 0.86.1 context whose system prompt and tool state are represented in `messages`.
- Compaction checkpoint: `CompactionEntry.systemMessage`, which stores the resolved system prompt and tool state at a compaction boundary.
- Auxiliary LLM request: A model request made by an extension for advisory, query, compaction, knowledge, or similar work outside the primary agent request.
- Usage entry: A Pi session entry with `type: "usage"` that contains model usage not represented by an assistant response.
- Context projection: Repository behavior that replaces eligible historical tool results with shorter representations while retaining their source session entries.
