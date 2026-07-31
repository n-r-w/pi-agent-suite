/** Identifies the selected agent inside a child Pi process. */
export const SUBAGENT_AGENT_ID_ENV = "PI_SUBAGENT_AGENT_ID";
/** Carries the child process's root-relative delegation depth. */
export const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
/** Carries the selected agent definition's raw tool patterns as JSON. */
export const SUBAGENT_TOOL_PATTERNS_ENV = "PI_SUBAGENT_TOOL_PATTERNS";
/** Carries resolved canonical workflow IDs for the selected child agent. */
export const SUBAGENT_WORKFLOW_IDS_ENV = "PI_SUBAGENT_WORKFLOW_IDS";
/** Carries the root-supervised runtime lease identity. */
export const SUBAGENT_RUNTIME_LEASE_ENV = "PI_SUBAGENT_RUNTIME_LEASE_ID";
/** Carries the child Pi session identity validated by Node IPC. */
export const SUBAGENT_OWNER_SESSION_ENV = "PI_SUBAGENT_OWNER_PI_SESSION_ID";
