# Domain Glossary

- Child session file: A persisted Pi JSONL file that contains one subagent's conversation and extension journal entries.
- Current source branch: The active root-to-leaf branch of a source child session when native-fork materialization occurs.
- Fork materialization: The fork-time process that creates independent child session branches and rebased owner snapshots for a native fork.
- Fork point: The root-session entry selected as the end of the branch retained by a native fork.
- Forked hierarchy: The root session and subagent hierarchy created by a native fork.
- Inherited subagent: A retained terminal-success subagent copied into a forked hierarchy.
- Logical subagent session: A `run-subagent` session identified by a `SessionKey` and backed by a child session file.
- Native fork: Pi's `/fork` or `/clone` session operation that creates a root session with a new Pi session ID from one retained branch.
- Original hierarchy: The root session and subagent hierarchy from which Pi creates a native fork.
- Owner snapshot: A journal record that contains one owner's Pi session ID and complete rebased direct logical sessions.
- Owner-local subagent ID: A positive integer that identifies a direct subagent within one owner Pi session.
- Owner Pi session ID: The Pi session ID of the root or subagent session that directly owns an owner-local subagent ID.
- Retained root branch: The ordered root-to-fork-point entries copied into a native fork.
- Retained subagent: A terminal-success logical subagent selected from the retained root branch when directly owned by the root, or from a copied owner's current branch when nested.
- Root session: The Pi session in which the top-level `run-subagent` tools execute.
- Subagent hierarchy: The root session's recursively owned logical subagent sessions.
