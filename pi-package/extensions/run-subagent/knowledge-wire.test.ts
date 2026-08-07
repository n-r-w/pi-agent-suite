import { describe, expect, test } from "bun:test";
import {
	parseKnowledgeRuntimeOperation,
	parseKnowledgeRuntimeResponse,
} from "./knowledge-wire";

const SCOPE = {
	projectDirectoryName: `project-${"a".repeat(64)}`,
	branchName: "feature/a",
} as const;

describe("knowledge runtime wire", () => {
	/**
	 * Proves every knowledge IPC operation and response has one closed validated shape.
	 * Inputs and expected outputs: read/acquire scopes, release/cancel IDs, snapshots, leases, and acknowledgments round-trip.
	 * Edge case: nullable snapshot fields and a read-only branch scope remain distinct from missing fields.
	 * Dependencies: no bridge state changes occur in this boundary parser.
	 */
	test("parses the complete closed knowledge operation matrix", () => {
		// Arrange and act: parse each approved operation payload and root response.
		const read = parseKnowledgeRuntimeOperation("knowledge_read", {
			scope: SCOPE,
		});
		const acquire = parseKnowledgeRuntimeOperation("knowledge_acquire", {
			scope: { ...SCOPE, branchName: null },
		});
		const release = parseKnowledgeRuntimeOperation("knowledge_release", {
			leaseId: "lease-1",
		});
		const cancel = parseKnowledgeRuntimeOperation("knowledge_cancel", {
			requestId: "request-1",
		});
		const snapshots = parseKnowledgeRuntimeResponse("knowledge_read", {
			global: "global",
			local: null,
		});
		const lease = parseKnowledgeRuntimeResponse("knowledge_acquire", {
			leaseId: "lease-1",
			snapshots: { global: null, local: "local" },
		});
		const releaseResult = parseKnowledgeRuntimeResponse("knowledge_release", {
			acknowledged: true,
		});

		// Assert: only validated values leave the unknown boundary.
		expect(read).toEqual({
			operation: "knowledge_read",
			payload: { scope: SCOPE },
		});
		expect(acquire).toEqual({
			operation: "knowledge_acquire",
			payload: { scope: { ...SCOPE, branchName: null } },
		});
		expect(release).toEqual({
			operation: "knowledge_release",
			payload: { leaseId: "lease-1" },
		});
		expect(cancel).toEqual({
			operation: "knowledge_cancel",
			payload: { requestId: "request-1" },
		});
		expect(snapshots).toEqual({ global: "global", local: null });
		expect(lease).toEqual({
			leaseId: "lease-1",
			snapshots: { global: null, local: "local" },
		});
		expect(releaseResult).toEqual({ acknowledged: true });
	});

	/**
	 * Proves malformed input remains unknown and fails closed without echoing sensitive values.
	 * Inputs and expected outputs: extra keys, missing keys, wrong primitives, and nested prompt/URL/credential fields all return undefined.
	 * Edge case: valid outer keys cannot authorize an invalid nested scope, snapshot, or lease.
	 * Dependencies: callers receive only a fixed generic bridge error for undefined parse results.
	 */
	test("rejects malformed payloads without producing raw-data errors", () => {
		// Arrange: every value contains a distinct structural defect and some contain prohibited raw data.
		const secret = "https://user:password@example.invalid/private.git";
		const malformed = [
			parseKnowledgeRuntimeOperation("knowledge_read", {
				scope: { ...SCOPE, prompt: secret },
			}),
			parseKnowledgeRuntimeOperation("knowledge_acquire", {
				scope: { projectDirectoryName: "", branchName: "feature/a" },
			}),
			parseKnowledgeRuntimeOperation("knowledge_release", {
				leaseId: "lease-1",
				knowledge: secret,
			}),
			parseKnowledgeRuntimeOperation("knowledge_cancel", { requestId: 1 }),
			parseKnowledgeRuntimeResponse("knowledge_read", {
				global: secret,
				local: null,
				extra: true,
			}),
			parseKnowledgeRuntimeResponse("knowledge_acquire", {
				leaseId: "lease-1",
				ownerId: "runtime-1",
				snapshots: { global: null, local: null },
			}),
			parseKnowledgeRuntimeResponse("knowledge_release", {
				acknowledged: false,
			}),
		];

		// Act and assert: no parser throws or returns a partially trusted object.
		expect(malformed).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});
