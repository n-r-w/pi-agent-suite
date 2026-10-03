# Terms

- Subagent: a child Pi worker started or continued by run-subagent.
- Required package: `pi-package`, which supplies the subagent runtime and is explicitly loaded for every worker.
- Additional extension: an extension outside the required package, including Pi's built-in extensions.
- Extension source: a file, directory, or `builtin:<name>` identifier accepted by Pi's `-e` option.
- `none`: loading only the required package.
- `all`: loading the required package and extensions enabled by ordinary user and project Pi settings.
- `explicit`: loading the required package and only the extension sources listed in `include`.
- Tool policy: the `tools` field in an agent definition, which restricts tools after extensions register them.
