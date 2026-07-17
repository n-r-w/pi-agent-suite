# mermaid

## Purpose

`mermaid` renders supported Mermaid blocks from completed assistant responses as durable ASCII previews in the Pi terminal interface.

The original Mermaid block remains the source of truth. ASCII output is a preview and may differ from Mermaid 11 rendering.

## Behavior

- Automatic rendering runs only in TUI mode after a final assistant turn.
- Responses ending with `toolUse`, `error`, or `aborted` are ignored.
- Each Mermaid block creates a durable custom entry that stays outside model context.
- Successful previews do not add Mermaid source or ASCII output to model context.
- Known compatibility warnings and detected failures are queued as one hidden diagnostic for the next user turn.
- The diagnostic does not trigger a model turn.
- Pi holds a queued next-turn diagnostic in memory until the next prompt. It can be lost if the session ends first.
- User cancellation and session shutdown terminate active automatic rendering without creating an entry or diagnostic.

## Model guidance

While loaded, the extension appends per-turn system guidance scoped only to replies shown to the user in chat. It permits simple supported Mermaid families in fenced `mermaid` blocks without YAML frontmatter or backticks inside labels. The guidance does not apply to Markdown files and does not create a session message or TUI output.

## Supported diagram types

- `graph`
- `flowchart`
- `stateDiagram`
- `stateDiagram-v2`
- `sequenceDiagram`
- `classDiagram`
- `erDiagram`
- `xychart`
- `xychart-beta`

Other top-level types create a failed preview entry containing `Unsupported Mermaid diagram type`.

## Preview display

- The collapsed entry shows the first 10 diagram rows.
- The `app.tools.expand` keybinding shows all rows.
- Diagram rows preserve layout spaces and are clipped to terminal display width without wrapping.
- Warning text remains visible in collapsed and expanded views.
- Failed entries display only their safe explanation.
- Expanded entries do not repeat Mermaid source.

## Known compatibility warnings

The extension reports documented `beautiful-mermaid@1.1.3` defects for:

- `--o` and `--x` flowchart edge endings;
- sequence notes before the first message;
- edges connected to a declared subgraph identifier;
- inline HTML formatting tags other than renderer-supported `<br>` and `<br/>` line breaks;
- labels containing terminal-wide characters.

Mermaid comment lines are excluded from compatibility checks because the renderer does not display them.

The isolated worker uses the pinned renderer's public parser for `--o`, `--x`, and subgraph-edge checks. The parent process validates the returned finite warning codes and performs only the sequence-note and display-risk checks that the parser cannot express.

These checks identify known defects only. They do not validate semantic equivalence between Mermaid and the ASCII preview.

## Isolation and limits

Rendering runs in a child JavaScript process under the current Node or Bun runtime. The extension does not use a shell or make network requests.

| Limit | Value |
| --- | --- |
| Render timeout | 5 seconds per assistant response |
| Source per block | 400 lines and 20,000 characters |
| Output per variant | 1,000 lines and 100,000 characters |
| Captured worker output | 1,200,000 bytes on standard output and 64,000 bytes on standard error |
| Variants | `default` and `tight` |

There is no fixed block-count limit. Every block that satisfies the per-block source limits is sent to the same bounded worker operation.

The parent process validates worker JSON and structural warning codes as untrusted data, rejects empty previews, removes terminal controls without removing layout spaces, and discards partial output after process-level failures. Session replay applies the same variant bounds, sanitizes diagnostic text, and rebuilds display-width metadata from stored preview text. Isolation failures never fall back to in-process rendering.

## Diagnostics

Durable failure entries store only their safe explanation. Renderer and process failure codes remain transient and are not written to the session.

Any failed blocks produce one hidden next-turn message:

```text
Mermaid rendering failed. Please simplify the diagram. Supported types: flowchart, state, sequence, class, er, xychart.
```

The model message omits block numbers, source hashes, diagnostic codes, failure details, Mermaid source, and ASCII output. Compatibility warnings remain separate and include only each unique explanation.

## Configuration

The first version has no configuration file. Limits and renderer version are fixed so behavior remains predictable and testable.
