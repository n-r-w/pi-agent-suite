import { describe, expect, test } from "bun:test";
import type { LogicalSession, OwnerIdentity } from "./domain";
import { SessionCatalog } from "./session-catalog";

const OWNER: OwnerIdentity = {
	ownerPiSessionId: "owner",
	ownerSessionFile: "/tmp/owner.jsonl",
};

/** Builds one complete logical-session fact for catalog tests. */
function session(ownerPiSessionId: string, id: number): LogicalSession {
	return {
		key: { ownerPiSessionId, ownerLocalSessionId: id },
		childPiSessionId: `child-${ownerPiSessionId}-${id}`,
		childSessionDir: "/tmp",
		childSessionFile: `/tmp/${ownerPiSessionId}-${id}.jsonl`,
		agentId: "SubAgentCoder",
		taskName: "Trace runtime",
		creationOrder: id,
		invocationId: `invocation-${ownerPiSessionId}-${id}`,
		runtimeLeaseId: `lease-${ownerPiSessionId}-${id}`,
		state: "active",
	};
}

describe("SessionCatalog", () => {
	test("keeps owner-local IDs separate and updates one stable key", () => {
		// Purpose: the catalog must qualify reusable numeric IDs by direct Pi owner identity.
		// Input and expected output: two owners add local ID 1, one update affects only owner, and lists keep creation order.
		// Edge case: foreign lookup still finds both sessions by local ID for not_owner classification.
		// Dependencies: in-memory production catalog only.
		const catalog = new SessionCatalog();
		catalog.add(session("owner", 2));
		catalog.add(session("owner", 1));
		catalog.add(session("other", 1));
		catalog.update(
			{ ownerPiSessionId: "owner", ownerLocalSessionId: 1 },
			{
				invocationId: "continued",
				runtimeLeaseId: "continued-lease",
				state: "terminal-success",
			},
		);

		expect({
			ownerIds: catalog.list(OWNER).map((item) => item.key.ownerLocalSessionId),
			ownerOne: catalog.get(OWNER, 1),
			sharedIdOwners: catalog
				.findByLocalId(1)
				.map((item) => item.key.ownerPiSessionId)
				.sort(),
		}).toMatchObject({
			ownerIds: [1, 2],
			ownerOne: {
				invocationId: "continued",
				runtimeLeaseId: "continued-lease",
				state: "terminal-success",
			},
			sharedIdOwners: ["other", "owner"],
		});
	});

	test("publishes stable changes and lists every owner deterministically", () => {
		// Purpose: management projection must observe accepted catalog mutations without gaining catalog write access.
		// Input and expected output: add, replace, and update notify in order while listAll groups owners and keeps creation order.
		// Edge case: unsubscribe prevents later updates from reaching the projection listener.
		// Dependencies: in-memory production catalog only.
		// ARRANGE: subscribe before adding sessions in deliberately mixed owner order.
		const catalog = new SessionCatalog();
		const notifications: string[] = [];
		const unsubscribe = catalog.subscribe((item) =>
			notifications.push(`${item.key.ownerPiSessionId}:${item.state}`),
		);
		catalog.add(session("z-owner", 2));
		catalog.add(session("a-owner", 2));
		catalog.add(session("a-owner", 1));

		// ACT: replace and update one stable session, then unsubscribe before a final update.
		catalog.replace({ ...session("a-owner", 1), taskName: "Reconstructed" });
		catalog.update(session("a-owner", 1).key, {
			state: "terminal-success",
		});
		unsubscribe();
		catalog.update(session("z-owner", 2).key, { state: "terminal-failure" });

		// ASSERT: global order and notification lifetime remain deterministic.
		expect({
			ordered: catalog
				.listAll()
				.map(
					(item) =>
						`${item.key.ownerPiSessionId}:${item.key.ownerLocalSessionId}`,
				),
			notifications,
		}).toEqual({
			ordered: ["a-owner:1", "a-owner:2", "z-owner:2"],
			notifications: [
				"z-owner:active",
				"a-owner:active",
				"a-owner:active",
				"a-owner:active",
				"a-owner:terminal-success",
			],
		});
	});

	test("rejects duplicate and unknown mutations", () => {
		// Purpose: coordinator bugs must not silently replace accepted identity or mutate a missing stable key.
		// Input and expected output: duplicate add and unknown update each throw.
		// Edge case: the original accepted session remains unchanged.
		// Dependencies: in-memory production catalog only.
		const catalog = new SessionCatalog();
		catalog.add(session("owner", 1));

		expect(() => catalog.add(session("owner", 1))).toThrow();
		expect(() =>
			catalog.update(
				{ ownerPiSessionId: "owner", ownerLocalSessionId: 2 },
				{ state: "terminal-aborted" },
			),
		).toThrow();
		expect(catalog.get(OWNER, 1)?.state).toBe("active");
	});
});
