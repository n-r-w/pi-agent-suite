export const TOOL_NAME = "convene_council";
export const ISSUE_PREFIX = "[convene-council]";
export const CONVENE_COUNCIL_EXTENSION_DIR = "convene-council";
export const ENABLED_CONFIG_KEY = "enabled";

export const DEFAULT_PARTICIPANT_ITERATION_LIMIT = 3;
export const DEFAULT_FINAL_ANSWER_PARTICIPANT = "llm2";
export const DEFAULT_RESPONSE_DEFECT_RETRIES = 1;
export const DEFAULT_PROVIDER_REQUEST_RETRIES = 4;
export const DEFAULT_PROVIDER_RETRY_DELAY_MS = 1_000;

export const COUNCIL_CONTEXT_TOO_LARGE_ERROR = "context is too large";

export const THINKING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
export const PARTICIPANT_IDS = ["llm1", "llm2"] as const;
export const PARTICIPANT_STATUSES = ["AGREE", "DIFF", "NEED_INFO"] as const;
