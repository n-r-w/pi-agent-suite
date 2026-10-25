# Terms

- Working directory: the directory from which a child Pi process resolves relative paths.
- Physical directory: the absolute filesystem directory after resolving symlinks.
- Immediate caller: the Pi agent that directly invokes `subagent_start`, including a subagent that delegates to another subagent.
- Continuation: a new invocation of a saved terminal logical session, started by steering or a management-screen message.
- Owner directory: the directory used to group saved child sessions in the package's existing session storage.
