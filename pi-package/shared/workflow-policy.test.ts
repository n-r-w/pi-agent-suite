import { describe, expect, test } from "bun:test";
import {
	hasAllowedWorkflowSource,
	isWorkflowAllowed,
	parseChildWorkflowPolicy,
	publishWorkflowCatalogPolicy,
	resolveWorkflowPolicy,
} from "./workflow-policy";

/** Catalog carrier key matching the production global. */
const CATALOG_KEY = "__piHarnessWorkflowCatalogPolicy";

/** Removes any catalog left by a previous test so each case starts clean. */
function resetCatalog(): void {
	delete (globalThis as Record<string, unknown>)[CATALOG_KEY];
}

describe("workflow policy boundary", () => {
	/** Proves absent, empty, and explicit configured policies keep distinct meanings. */
	test("resolves exact and NFC-equivalent names to canonical catalog IDs", () => {
		resetCatalog();
		publishWorkflowCatalogPolicy({
			ids: ["Review", "delivery", "Café"],
		});

		expect(resolveWorkflowPolicy(undefined)).toEqual({
			kind: "resolved",
			policy: undefined,
		});
		expect(resolveWorkflowPolicy([])).toEqual({
			kind: "resolved",
			policy: [],
		});
		expect(
			resolveWorkflowPolicy(["Review", "delivery", "Cafe\u0301"]),
		).toEqual({
			kind: "resolved",
			policy: ["Review", "delivery", "Café"],
		});
	});

	/** Proves exact case variants remain distinct while NFC-equivalent catalog IDs collide. */
	test("uses exact NFC workflow identity", () => {
		resetCatalog();
		const caseVariants = publishWorkflowCatalogPolicy({
			ids: ["Review", "review"],
		});
		expect(caseVariants.error).toBeUndefined();
		expect(resolveWorkflowPolicy(["review"])).toEqual({
			kind: "resolved",
			policy: ["review"],
		});

		const canonicalVariants = publishWorkflowCatalogPolicy({
			ids: ["Café", "Cafe\u0301"],
		});
		expect(canonicalVariants.error?.message).toContain("Cafe\u0301");
		expect(resolveWorkflowPolicy(["Café"]).kind).toBe("error");
	});

	/** Proves invalid names and duplicates fail without returning partial canonical IDs. */
	test.each([
		[["Review", "missing"], "missing"],
		[["Review", "Review"], "duplicate"],
		[[" Review"], "single-line"],
	])("rejects configured workflow policy %j", (names, issue) => {
		resetCatalog();
		publishWorkflowCatalogPolicy({ ids: ["Review", "delivery"] });
		const result = resolveWorkflowPolicy(names);
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.issue.toLowerCase()).toContain(issue);
		}
	});

	/** Proves only explicit non-empty policy depends on a valid current catalog. */
	test("resolves unrestricted and empty policy through catalog failure", () => {
		resetCatalog();
		publishWorkflowCatalogPolicy({
			ids: [],
			error: new Error("catalog invalid"),
		});
		expect(resolveWorkflowPolicy(undefined).kind).toBe("resolved");
		expect(resolveWorkflowPolicy([]).kind).toBe("resolved");
		const explicit = resolveWorkflowPolicy(["Review"]);
		expect(explicit.kind).toBe("error");
		if (explicit.kind === "error") {
			expect(explicit.issue).toContain("catalog invalid");
		}
	});

	/** Proves child JSON preserves omitted, empty, and canonical explicit policies. */
	test("parses transported child workflow policy against the published catalog", () => {
		resetCatalog();
		publishWorkflowCatalogPolicy({ ids: ["Review", "delivery"] });
		expect(parseChildWorkflowPolicy(undefined)).toEqual({
			kind: "resolved",
			policy: undefined,
		});
		expect(parseChildWorkflowPolicy("[]")).toEqual({
			kind: "resolved",
			policy: [],
		});
		expect(parseChildWorkflowPolicy('["Review"]')).toEqual({
			kind: "resolved",
			policy: ["Review"],
		});
	});

	/** Proves malformed, duplicate, and unknown child values fail closed. */
	test.each([
		"{",
		'"Review"',
		'["Review", 1]',
		'["Review", "Review"]',
		'["missing"]',
	])("rejects child workflow policy %s", (raw) => {
		resetCatalog();
		publishWorkflowCatalogPolicy({ ids: ["Review"] });
		expect(parseChildWorkflowPolicy(raw).kind).toBe("error");
	});

	/** Proves membership and context source eligibility share one policy rule. */
	test("checks current and removed saved workflows through policy membership", () => {
		expect(isWorkflowAllowed(undefined, "removed")).toBe(true);
		expect(isWorkflowAllowed([], "Review")).toBe(false);
		expect(isWorkflowAllowed(["Review"], "Review")).toBe(true);
		expect(isWorkflowAllowed(["Review"], "review")).toBe(false);
		expect(isWorkflowAllowed(["Café"], "Cafe\u0301")).toBe(true);
		expect(hasAllowedWorkflowSource(undefined, [], "removed")).toBe(true);
		expect(hasAllowedWorkflowSource(["Review"], [], "review")).toBe(false);
		expect(hasAllowedWorkflowSource(["Review"], [], "Review")).toBe(true);
		expect(hasAllowedWorkflowSource([], ["Review"], "Review")).toBe(false);
		expect(hasAllowedWorkflowSource(["Review"], ["delivery"], "Review")).toBe(
			true,
		);
		expect(hasAllowedWorkflowSource(["Review"], ["delivery"], "delivery")).toBe(
			false,
		);
	});
});
