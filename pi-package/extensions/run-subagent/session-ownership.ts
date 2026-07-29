import { SubagentToolError } from "./contracts";
import type { LogicalSession, OwnerIdentity } from "./domain";
import type { SessionCatalogQuery } from "./session-catalog";

/** Resolves one direct child while preserving stable ownership failure codes. */
export function resolveDirectChildSession(
	catalog: SessionCatalogQuery,
	owner: OwnerIdentity,
	ownerLocalSessionId: number,
): LogicalSession {
	const session = catalog.get(owner, ownerLocalSessionId);
	if (session !== undefined) {
		return session;
	}
	if (catalog.findByLocalId(ownerLocalSessionId).length > 0) {
		throw new SubagentToolError(
			"not_owner",
			`session ${ownerLocalSessionId} is not directly owned by the caller`,
		);
	}
	throw new SubagentToolError(
		"unknown_session",
		`session ${ownerLocalSessionId} is unknown`,
	);
}
