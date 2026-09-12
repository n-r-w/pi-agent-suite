# Home path expansion

Path-valued extension settings and tool inputs accept these home-directory prefixes:

- `~` and `~/...`
- `$HOME` and `$HOME/...`
- `${HOME}` and `${HOME}/...`

The shared `expandHomePath` function resolves these prefixes through `node:os.homedir()` before absolute-path validation or relative-path resolution. It leaves `~user`, other environment variables, embedded aliases, and ordinary relative or absolute paths unchanged.

The contract applies to `PI_AGENT_SUITE_DIR`, configured prompt and data paths, `vision.image_path`, `consult-advisor.debugPayloadFile`, `mcp-wrapper` stdio `command` and `cwd`, and `completion-sound.command`. Opaque process arguments and environment values remain unchanged. `project-rules.rulesDir` remains a project-relative path by design.

Regression tests cover all accepted prefixes, unsupported lookalikes, shared suite-directory resolution, extension startup validation, vision image loading, and path-valued process commands.
