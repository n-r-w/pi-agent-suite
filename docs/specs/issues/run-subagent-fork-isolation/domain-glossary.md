# Domain Glossary

- Child session file: A persisted Pi JSONL file that contains one subagent's conversation and extension journal entries.
- Fork point: The root-session entry selected as the end of the branch retained by a native fork.
- Forked hierarchy: The root session and subagent hierarchy created by a native fork.
- Historical snapshot: The root branch and subordinate session state observable at a fork point, excluding changes recorded after that point.
- Inherited subagent: A retained subagent represented in a forked hierarchy.
- Logical subagent session: A `run-subagent` session identified by a `SessionKey` and backed by a child session file.
- Native fork: Pi's `/fork` or `/clone` session operation that creates a root session with a new Pi session ID from one retained branch.
- Original hierarchy: The root session and subagent hierarchy from which Pi creates a native fork.
- Owner-local subagent ID: A positive integer that identifies a direct subagent within one owner Pi session.
- Owner Pi session ID: The Pi session ID of the root or subagent session that directly owns an owner-local subagent ID.
- Retained root branch: The ordered root-to-fork-point entries copied into a native fork.
- Retained subagent: A logical subagent session represented by a `run-subagent` journal entry in the retained root branch or in a retained descendant branch.
- Root session: The Pi session in which the top-level `run-subagent` tools execute.
- Subagent hierarchy: The root session's recursively owned logical subagent sessions.
