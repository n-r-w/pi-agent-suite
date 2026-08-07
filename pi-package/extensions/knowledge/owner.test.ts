import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdentityMetadata } from "./git-context";
import { createGlobalMergeState, KnowledgeOwner } from "./owner";

const temporaryDirectories: string[] = [];

/** Removes every isolated catalog directory created by a test. */
afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

/** Creates an isolated catalog root under the system temporary directory. */
async function createCatalogDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "knowledge-owner-"));
	temporaryDirectories.push(directory);
	return directory;
}

/** Reports whether a path exists without changing it. */
async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe("knowledge owner", () => {
	/** Verifies that an absent knowledge file can be read before any other owner operation. */
	test("reads absent knowledge independently", async () => {
		// ARRANGE
		const catalog = await createCatalogDirectory();
		const target = {
			scope: "local" as const,
			path: join(catalog, "missing", "knowledge.md"),
		};
		const owner = new KnowledgeOwner({
			globalTokenLimit: 100,
			localTokenLimit: 100,
		});

		// ACT
		const stored = await owner.read(target);

		// ASSERT
		expect(stored).toBeNull();
	});

	/** Verifies that replacement works without a preceding owner read and then reads independently. */
	test("replaces and reads global knowledge independently", async () => {
		// ARRANGE
		const catalog = await createCatalogDirectory();
		const target = {
			scope: "global" as const,
			path: join(catalog, "project", "global", "knowledge.md"),
		};
		const owner = new KnowledgeOwner({
			globalTokenLimit: 100,
			localTokenLimit: 100,
		});

		// ACT
		const replacement = await owner.replace(target, "# Global\n\nKnowledge.");
		const stored = await owner.read(target);

		// ASSERT
		expect(replacement.kind).toBe("written");
		expect(stored).toBe("# Global\n\nKnowledge.");
	});

	/** Verifies that local and global limits are selected independently by target scope. */
	test("applies independent global and local token limits", async () => {
		// ARRANGE
		const catalog = await createCatalogDirectory();
		const text = "one two three four five six seven eight nine ten";
		const owner = new KnowledgeOwner({
			globalTokenLimit: 100,
			localTokenLimit: 1,
		});
		const globalTarget = {
			scope: "global" as const,
			path: join(catalog, "global.md"),
		};
		const localTarget = {
			scope: "local" as const,
			path: join(catalog, "local.md"),
		};

		// ACT
		const globalResult = await owner.replace(globalTarget, text);
		const localResult = await owner.replace(localTarget, text);

		// ASSERT
		expect(globalResult.kind).toBe("written");
		expect(localResult.kind).toBe("over-limit");
		expect(await pathExists(globalTarget.path)).toBe(true);
		expect(await pathExists(localTarget.path)).toBe(false);
	});

	/**
	 * Verifies that model-independent token counting rejects oversized content
	 * before any target directory or file is opened for writing.
	 */
	test("rejects oversized replacement before opening the target", async () => {
		// ARRANGE
		const catalog = await createCatalogDirectory();
		const target = {
			scope: "local" as const,
			path: join(catalog, "unopened", "knowledge.md"),
		};
		const owner = new KnowledgeOwner({
			globalTokenLimit: 1,
			localTokenLimit: 1,
		});

		// ACT
		const result = await owner.replace(
			target,
			"This replacement contains substantially more than one token.",
		);

		// ASSERT
		expect(result.kind).toBe("over-limit");
		expect(await pathExists(join(catalog, "unopened"))).toBe(false);
	});

	/** Verifies that delete is idempotent and does not require any prior owner operation. */
	test("deletes knowledge independently", async () => {
		// ARRANGE
		const catalog = await createCatalogDirectory();
		const path = join(catalog, "knowledge.md");
		await writeFile(path, "stored outside the owner");
		const target = { scope: "global" as const, path };
		const owner = new KnowledgeOwner({
			globalTokenLimit: 100,
			localTokenLimit: 100,
		});

		// ACT
		await owner.delete(target);
		await owner.delete(target);

		// ASSERT
		expect(await owner.read(target)).toBeNull();
	});

	/** Verifies direct identity metadata storage with only the credential-free schema fields. */
	test("stores credential-free project identity metadata", async () => {
		// ARRANGE
		const catalog = await createCatalogDirectory();
		const path = join(catalog, "project", "identity.json");
		const metadata: IdentityMetadata = {
			schema: "knowledge-project-identity/v1",
			key: "ed0513b170cc4769a82e13527af2de5202188504fae1fc05c30f7a3193a02541",
			profile: "github-v1",
			displayName: "pi-agent-suite",
			canonicalIdentity: "github.com/n-r-w/pi-agent-suite",
			remoteNames: ["origin"],
			redactedFetchUrls: ["github.com:n-r-w/pi-agent-suite.git"],
		};
		const owner = new KnowledgeOwner({
			globalTokenLimit: 100,
			localTokenLimit: 100,
		});

		// ACT
		await owner.replaceIdentityMetadata(path, metadata);
		const stored = await readFile(path, "utf8");

		// ASSERT
		expect(JSON.parse(stored)).toEqual(metadata);
		expect(stored).not.toContain("git@");
	});

	/** Verifies global-merge state digest creation and independent read, replace, and delete. */
	test("stores global-merge state independently", async () => {
		// ARRANGE
		const catalog = await createCatalogDirectory();
		const path = join(catalog, "branch", "global-merge-state.json");
		const state = createGlobalMergeState("# Local knowledge");
		const owner = new KnowledgeOwner({
			globalTokenLimit: 100,
			localTokenLimit: 100,
		});

		// ACT
		await owner.replaceGlobalMergeState(path, state);
		const stored = await owner.readGlobalMergeState(path);
		await owner.deleteGlobalMergeState(path);
		const deleted = await owner.readGlobalMergeState(path);

		// ASSERT
		expect(stored).toEqual({
			schema: "knowledge-global-merge-state/v1",
			localKnowledgeDigest:
				"fc7c5e5ca4884052db3a17dd2de606f76f0df5af5a546792e2f1f274d4e7758b",
		});
		expect(deleted).toBeNull();
	});
});
