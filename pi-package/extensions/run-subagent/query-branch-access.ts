import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SubagentToolError } from "./contracts";
import type { OwnerIdentity } from "./domain";
import { errorMessage } from "./error-message";
import { sanitizePublicSubagentErrorMessage } from "./public-error";
import type { QueryBranchResponse } from "./query-branch-wire";
import type { SessionCatalogQuery } from "./session-catalog";
import { parseConversationSessionEntry } from "./session-entry-validation";
import { resolveDirectChildSession } from "./session-ownership";
import { SessionSnapshotError } from "./session-snapshot-loader";

const SUBAGENT_NOT_READY =
	"Subagent is not ready, please try again after some time";
const SUBAGENT_CONVERSATION_EMPTY = "Subagent has no conversation to query";
const SUBAGENT_CONVERSATION_INVALID = "Subagent conversation is invalid";

/** Loads one saved Pi conversation branch after owner authorization. */
interface SavedSessionBranchLoader {
	load(sessionFile: string): Promise<readonly SessionEntry[]>;
}

/** Owns direct-child authorization and saved branch validation at the root. */
export class QueryBranchAccess {
	public constructor(
		private readonly catalog: SessionCatalogQuery,
		private readonly loader: SavedSessionBranchLoader,
	) {}

	/** Returns one authorized non-empty branch without invoking the child agent. */
	public async load(
		owner: OwnerIdentity,
		sessionId: number,
	): Promise<QueryBranchResponse> {
		let sessionFile: string;
		try {
			sessionFile = resolveDirectChildSession(
				this.catalog,
				owner,
				sessionId,
			).childSessionFile;
		} catch (error) {
			if (
				error instanceof SubagentToolError &&
				(error.code === "unknown_session" || error.code === "not_owner")
			) {
				return {
					kind: "failed",
					failure: { code: error.code, message: error.details.message },
				};
			}
			return queryFailure(error);
		}

		let loadedBranch: readonly SessionEntry[];
		try {
			loadedBranch = await this.loader.load(sessionFile);
		} catch (error) {
			return queryLoadFailure(error);
		}
		if (loadedBranch.length === 0) {
			return queryFailureMessage(SUBAGENT_CONVERSATION_EMPTY);
		}
		try {
			const branch = loadedBranch.map((entry, index) =>
				parseConversationSessionEntry(
					entry,
					`saved query branch entry ${index}`,
				),
			);
			return { kind: "ok", branch: Object.freeze(branch) };
		} catch {
			return queryFailureMessage(SUBAGENT_CONVERSATION_INVALID);
		}
	}
}

/** Maps classified loading defects without exposing storage details. */
function queryLoadFailure(error: unknown): QueryBranchResponse {
	if (error instanceof SessionSnapshotError) {
		if (error.kind === "unavailable") {
			return queryFailureMessage(SUBAGENT_NOT_READY);
		}
		if (error.kind === "empty") {
			return queryFailureMessage(SUBAGENT_CONVERSATION_EMPTY);
		}
		if (error.kind === "invalid") {
			return queryFailureMessage(SUBAGENT_CONVERSATION_INVALID);
		}
		return queryFailure(error.cause ?? error);
	}
	return queryFailure(error);
}

/** Preserves one unknown diagnostic after the common public sanitization. */
function queryFailure(error: unknown): QueryBranchResponse {
	return queryFailureMessage(
		sanitizePublicSubagentErrorMessage(errorMessage(error)),
	);
}

/** Creates one query-specific failed response with safe public text. */
function queryFailureMessage(message: string): QueryBranchResponse {
	return {
		kind: "failed",
		failure: {
			code: "query_failed",
			message: sanitizePublicSubagentErrorMessage(message),
		},
	};
}
