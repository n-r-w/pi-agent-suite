import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isFileNotFoundError } from "../../shared/agent-suite-storage";
import { countKnowledgeTextTokens } from "../../shared/context-size";
import type { IdentityMetadata } from "./git-context";

/** Defines the strict global-merge state fields and digest encoding. */
const GLOBAL_MERGE_STATE_KEYS = ["schema", "localKnowledgeDigest"] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** Selects the configured token limit and target file for one knowledge scope. */
export interface KnowledgeTarget {
	readonly scope: "global" | "local";
	readonly path: string;
}

/** Reports whether a complete replacement was stored or rejected by its limit. */
export type KnowledgeReplacementResult =
	| { readonly kind: "written"; readonly tokenCount: number }
	| {
			readonly kind: "over-limit";
			readonly tokenCount: number;
			readonly tokenLimit: number;
	  };

/** Records which exact local knowledge content completed a global merge. */
export interface GlobalMergeState {
	readonly schema: "knowledge-global-merge-state/v1";
	readonly localKnowledgeDigest: string;
}

/** Supplies the independent limits enforced by the knowledge owner. */
export interface KnowledgeOwnerOptions {
	readonly globalTokenLimit: number;
	readonly localTokenLimit: number;
}

/** Owns direct catalog reads, complete replacements, deletes, and metadata files. */
export class KnowledgeOwner {
	/** Preserves the independently configured global file capacity. */
	readonly #globalTokenLimit: number;
	/** Preserves the independently configured branch-local file capacity. */
	readonly #localTokenLimit: number;

	/** Creates an owner with independently configured global and local limits. */
	public constructor(options: KnowledgeOwnerOptions) {
		this.#globalTokenLimit = options.globalTokenLimit;
		this.#localTokenLimit = options.localTokenLimit;
	}

	/** Reads one knowledge file independently and maps absence to null. */
	public async read(target: KnowledgeTarget): Promise<string | null> {
		try {
			return await readFile(target.path, "utf8");
		} catch (error) {
			if (isFileNotFoundError(error)) {
				return null;
			}
			throw error;
		}
	}

	/** Counts and completely replaces one knowledge file when it fits its limit. */
	public async replace(
		target: KnowledgeTarget,
		text: string,
	): Promise<KnowledgeReplacementResult> {
		// Counting must finish before directory creation or target opening so an
		// oversized model result cannot alter the catalog.
		const tokenCount = countKnowledgeTextTokens(text);
		const tokenLimit =
			target.scope === "global"
				? this.#globalTokenLimit
				: this.#localTokenLimit;
		if (tokenCount > tokenLimit) {
			return { kind: "over-limit", tokenCount, tokenLimit };
		}

		await mkdir(dirname(target.path), { recursive: true });
		await writeFile(target.path, text, "utf8");
		return { kind: "written", tokenCount };
	}

	/** Deletes one knowledge file independently and idempotently. */
	public async delete(target: KnowledgeTarget): Promise<void> {
		await rm(target.path, { force: true });
	}

	/** Directly replaces project identity metadata. */
	public async replaceIdentityMetadata(
		path: string,
		metadata: IdentityMetadata,
	): Promise<void> {
		await writeJson(path, metadata);
	}

	/** Reads and validates one branch's global-merge state. */
	public async readGlobalMergeState(
		path: string,
	): Promise<GlobalMergeState | null> {
		let content: string;
		try {
			content = await readFile(path, "utf8");
		} catch (error) {
			if (isFileNotFoundError(error)) {
				return null;
			}
			throw error;
		}
		return parseGlobalMergeState(content);
	}

	/** Directly replaces one branch's global-merge state. */
	public async replaceGlobalMergeState(
		path: string,
		state: GlobalMergeState,
	): Promise<void> {
		await writeJson(path, state);
	}

	/** Deletes one branch's global-merge state independently. */
	public async deleteGlobalMergeState(path: string): Promise<void> {
		await rm(path, { force: true });
	}
}

/** Hashes the exact local knowledge used by one successful global merge. */
export function createGlobalMergeState(
	localKnowledge: string,
): GlobalMergeState {
	return {
		schema: "knowledge-global-merge-state/v1",
		localKnowledgeDigest: createHash("sha256")
			.update(Buffer.from(localKnowledge, "utf8"))
			.digest("hex"),
	};
}

/** Writes one JSON catalog file directly, without a lock or temporary file. */
async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

/** Rejects damaged or unsupported global-merge state instead of hiding it. */
function parseGlobalMergeState(content: string): GlobalMergeState {
	const value: unknown = JSON.parse(content);
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).length !== GLOBAL_MERGE_STATE_KEYS.length ||
		!("schema" in value) ||
		value.schema !== "knowledge-global-merge-state/v1" ||
		!("localKnowledgeDigest" in value) ||
		typeof value.localKnowledgeDigest !== "string" ||
		!SHA256_HEX.test(value.localKnowledgeDigest)
	) {
		throw new Error("invalid global-merge state");
	}
	return {
		schema: value.schema,
		localKnowledgeDigest: value.localKnowledgeDigest,
	};
}
