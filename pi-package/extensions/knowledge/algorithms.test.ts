import { describe, expect, test } from "bun:test";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { KnowledgeSnapshots } from "../../shared/knowledge-runtime";
import {
	runGlobalKnowledgeAccumulation,
	runLocalKnowledgeAccumulation,
} from "./algorithms";
import type { KnowledgeConfig } from "./config";
import type { IdentityMetadata } from "./git-context";
import {
	createGlobalMergeState,
	type GlobalMergeState,
	type KnowledgeReplacementResult,
	type KnowledgeTarget,
} from "./owner";
import { createBranchPaths, createProjectPaths } from "./paths";

/** One deterministic model with enough context for protocol tests. */
const MODEL = {
	provider: "test-provider",
	id: "test-model",
	name: "Test model",
	api: "test-api",
	baseUrl: "https://invalid.example",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_000,
} as Model<Api>;

/** Credential-free metadata persisted only with completed knowledge writes. */
const IDENTITY_METADATA: IdentityMetadata = {
	schema: "knowledge-project-identity/v1",
	key: "a".repeat(64),
	profile: "github-v1",
	displayName: "project",
	canonicalIdentity: "github.com/example/project",
	remoteNames: ["origin"],
	redactedFetchUrls: ["https://github.com/example/project.git"],
};

/** Creates one text-only auxiliary response accepted by the shared response extractor. */
function response(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: MODEL.provider,
		model: MODEL.id,
		api: MODEL.api,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Fake owner that records direct-write ordering and can reject selected merge outputs by size. */
class RecordingOwner {
	readonly events: string[] = [];
	readonly replacements: Array<{ target: KnowledgeTarget; text: string }> = [];
	readonly deletions: KnowledgeTarget[] = [];
	state: GlobalMergeState | null = null;
	overLimitTexts = new Map<
		string,
		{ tokenCount: number; tokenLimit: number }
	>();

	/** Records replacement attempts and returns configured token-limit outcomes. */
	public async replace(
		target: KnowledgeTarget,
		text: string,
	): Promise<KnowledgeReplacementResult> {
		this.events.push(`replace:${target.scope}:${text}`);
		this.replacements.push({ target, text });
		const overLimit = this.overLimitTexts.get(text);
		return overLimit === undefined
			? { kind: "written", tokenCount: 3 }
			: { kind: "over-limit", ...overLimit };
	}

	/** Deletes one knowledge target after successful transfer to durable destination. */
	public async delete(target: KnowledgeTarget): Promise<void> {
		this.events.push(`delete:${target.scope}`);
		this.deletions.push(target);
	}

	/** Returns the exact local digest from the last successful global replacement. */
	public async readGlobalMergeState(): Promise<GlobalMergeState | null> {
		this.events.push("read-state");
		return this.state;
	}

	/** Persists the digest only after the global file replacement event. */
	public async replaceGlobalMergeState(
		_path: string,
		state: GlobalMergeState,
	): Promise<void> {
		this.events.push("write-state");
		this.state = state;
	}

	/** Records identity metadata persistence without exposing its content. */
	public async replaceIdentityMetadata(): Promise<void> {
		this.events.push("write-identity");
	}
}

/** Creates runtime configuration with test prompts and finite retries. */
function config(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
	return {
		enabled: true,
		dataDir: "/catalog",
		globalTokenLimit: 5_000,
		localTokenLimit: 5_000,
		primaryBranches: ["main", "master"],
		extraction: {
			model: undefined,
			thinking: undefined,
			systemPrompt: "extract system",
			taskPrompt: "summarize projected session",
			retryCount: 1,
		},
		merge: {
			model: undefined,
			thinking: undefined,
			systemPrompt: "merge system",
			retryCount: 2,
		},
		...overrides,
	};
}

/** Builds one isolated algorithm invocation with injected replay and completion seams. */
function createOptions(options: {
	readonly owner: RecordingOwner;
	readonly snapshots: KnowledgeSnapshots;
	readonly outputs: readonly string[];
	readonly contexts: Context[];
	readonly configuration?: KnowledgeConfig;
}): Parameters<typeof runLocalKnowledgeAccumulation>[0] {
	const projectPaths = createProjectPaths("/catalog", "project-a-digest");
	const branchPaths = createBranchPaths(projectPaths, "feature/a");
	let outputIndex = 0;
	return {
		config: options.configuration ?? config(),
		ctx: {
			model: MODEL,
			modelRegistry: {
				find: () => MODEL,
				getApiKeyAndHeaders: async () => ({ ok: true }),
			},
		} as unknown as ExtensionContext,
		owner: options.owner,
		projectPaths,
		branchPaths,
		identityMetadata: IDENTITY_METADATA,
		snapshots: options.snapshots,
		branchEntries: [
			{
				type: "custom",
				id: "source-entry",
				parentId: null,
				timestamp: "t",
				customType: "source",
				data: {},
			},
		] as SessionEntry[],
		loadedSkillRoots: ["/skills"],
		currentThinking: "high",
		completeSimple: async (_model, context) => {
			options.contexts.push(context);
			const text = options.outputs[outputIndex];
			outputIndex += 1;
			if (text === undefined) {
				throw new Error("unexpected completion call");
			}
			return response(text);
		},
		signal: undefined,
		replay: async ({ branchEntries }) => {
			expect(branchEntries).toEqual([
				{
					type: "custom",
					id: "source-entry",
					parentId: null,
					timestamp: "t",
					customType: "source",
					data: {},
				},
			]);
			return [
				{
					role: "user",
					content: "projected current branch",
					timestamp: 1,
				},
			];
		},
	};
}

describe("knowledge accumulation algorithms", () => {
	/**
	 * Proves exact NOT_FOUND ends local extraction without merge or storage changes.
	 * Inputs and expected outputs: projected branch context is wrapped as explicit summary source in one extraction user message.
	 * Edge case: absent stored local knowledge remains absent and identity metadata is not created.
	 * Dependencies: injected replay proves the current branch is the extraction source.
	 */
	test("treats exact NOT_FOUND as a local no-op after context projection", async () => {
		// Arrange: extraction has one exact no-knowledge response.
		const owner = new RecordingOwner();
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: null, local: null },
			outputs: ["NOT_FOUND"],
			contexts,
		});

		// Act: run one local accumulation under an already-granted lease.
		const result = await runLocalKnowledgeAccumulation(options);

		// Assert: extraction receives one explicit task message with wrapped source and no writes happen.
		expect(result).toEqual({ kind: "noop" });
		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.messages).toHaveLength(1);
		expect(contexts[0]?.messages[0]?.role).toBe("user");
		expect(String(contexts[0]?.messages[0]?.content)).toContain(
			"<summary_source>",
		);
		expect(String(contexts[0]?.messages[0]?.content)).toContain(
			"projected current branch",
		);
		expect(String(contexts[0]?.messages[0]?.content)).toContain(
			"</summary_source>",
		);
		expect(owner.events).toEqual([]);
	});

	/**
	 * Proves extraction receives current knowledge snapshots so duplicate filtering rules are actionable.
	 * Inputs and expected outputs: one global and one local snapshot appear in the extraction user message before summary source.
	 * Edge case: both sections are present in one outer knowledge block when both snapshots exist.
	 * Dependencies: extraction request assembly is the only source of knowledge-block injection.
	 */
	test("includes current knowledge block in extraction request", async () => {
		// Arrange: existing global and local knowledge are available at extraction start.
		const owner = new RecordingOwner();
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: "## Global\nKnown", local: "## Local\nKnown" },
			outputs: ["NOT_FOUND"],
			contexts,
		});

		// Act: run one local extraction cycle.
		const result = await runLocalKnowledgeAccumulation(options);

		// Assert: extraction request includes current knowledge and source transcript.
		expect(result).toEqual({ kind: "noop" });
		const content = String(contexts[0]?.messages[0]?.content);
		expect(content).toContain("<knowledge>");
		expect(content).toContain("<global>");
		expect(content).toContain("## Global\nKnown");
		expect(content).toContain("<local>");
		expect(content).toContain("## Local\nKnown");
		expect(content).toContain("</knowledge>");
		expect(content).toContain("<summary_source>");
		expect(content).toContain("projected current branch");
	});

	/**
	 * Proves local format feedback and oversized merge feedback use finite configured retries.
	 * Inputs and expected outputs: marker-invalid extraction repairs once; oversized merge reports 17 against unchanged limit 5, then writes repaired Markdown.
	 * Edge case: stored local knowledge is supplied to merge and replacement occurs only for the within-limit response.
	 * Dependencies: the owner supplies the authoritative tokenizer count used in feedback.
	 */
	test("repairs invalid extraction and oversized local merge before replacement", async () => {
		// Arrange: one extraction defect, one positive repair, one oversized merge, and one fitting repair.
		const owner = new RecordingOwner();
		owner.overLimitTexts.set("oversized merge", {
			tokenCount: 17,
			tokenLimit: 5,
		});
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: "global", local: "stored local" },
			outputs: [
				"NOT_FOUND with explanation",
				"## New",
				"oversized merge",
				"## Merged",
			],
			contexts,
		});

		// Act: local accumulation repairs both protocol defects within configured allowances.
		const result = await runLocalKnowledgeAccumulation(options);

		// Assert: feedback carries runtime-significant marker and exact count/limit values.
		expect(result).toEqual({ kind: "written" });
		expect(contexts).toHaveLength(4);
		expect(String(contexts[1]?.messages.at(-1)?.content)).toContain(
			"NOT_FOUND",
		);
		expect(String(contexts[3]?.messages.at(-1)?.content)).toContain("17");
		expect(String(contexts[3]?.messages.at(-1)?.content)).toContain("5");
		expect(owner.replacements.map(({ text }) => text)).toEqual([
			"oversized merge",
			"## Merged",
		]);
		expect(owner.events.at(-1)).toBe("write-identity");
	});

	/**
	 * Proves absent and exact-digest local knowledge skip global model work.
	 * Inputs and expected outputs: absent local and unchanged local each return no-op with zero completions and replacements.
	 * Edge case: unchanged comparison hashes the exact Markdown string rather than normalized content.
	 * Dependencies: createGlobalMergeState owns the exact SHA-256 digest contract.
	 */
	test("skips global LLM work for absent or unchanged local knowledge", async () => {
		// Arrange: run absent and exact-digest cases with completion fakes that would fail if called.
		const absentOwner = new RecordingOwner();
		const absentContexts: Context[] = [];
		const absent = createOptions({
			owner: absentOwner,
			snapshots: { global: "global", local: null },
			outputs: [],
			contexts: absentContexts,
		});
		const unchangedOwner = new RecordingOwner();
		unchangedOwner.state = createGlobalMergeState("exact local\n");
		const unchangedContexts: Context[] = [];
		const unchanged = createOptions({
			owner: unchangedOwner,
			snapshots: { global: "global", local: "exact local\n" },
			outputs: [],
			contexts: unchangedContexts,
		});

		// Act: both no-change conditions run.
		const absentResult = await runGlobalKnowledgeAccumulation(absent);
		const unchangedResult = await runGlobalKnowledgeAccumulation(unchanged);

		// Assert: only the changed-content check reads merge state; neither path calls the LLM or writes.
		expect(absentResult).toEqual({ kind: "noop" });
		expect(unchangedResult).toEqual({ kind: "noop" });
		expect(absentContexts).toEqual([]);
		expect(unchangedContexts).toEqual([]);
		expect(absentOwner.events).toEqual([]);
		expect(unchangedOwner.events).toEqual(["read-state"]);
	});

	/**
	 * Proves changed local knowledge replaces global knowledge and removes transferred local knowledge.
	 * Inputs and expected outputs: changed local plus absent global produces one global replacement, one local deletion, then state and identity writes.
	 * Edge case: local transfer cleanup deletes only the local target and never the global target.
	 * Dependencies: the owner event log makes write ordering observable.
	 */
	test("merges changed local into global, deletes local, and persists digest", async () => {
		// Arrange: one fitting global merge response.
		const owner = new RecordingOwner();
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: null, local: "## Local" },
			outputs: ["## Global"],
			contexts,
		});

		// Act: global accumulation completes successfully.
		const result = await runGlobalKnowledgeAccumulation(options);

		// Assert: global replacement is followed by local cleanup, then digest and identity persistence.
		expect(result).toEqual({ kind: "written" });
		expect(owner.replacements).toHaveLength(1);
		expect(owner.replacements[0]?.target.scope).toBe("global");
		expect(owner.deletions).toEqual([
			{ scope: "local", path: options.branchPaths.knowledgeFile },
		]);
		expect(owner.events).toEqual([
			"read-state",
			"replace:global:## Global",
			"delete:local",
			"write-state",
			"write-identity",
		]);
		expect(owner.state).toEqual(createGlobalMergeState("## Local"));
	});

	/**
	 * Proves finite oversized-merge exhaustion leaves pre-write storage and digest state unchanged.
	 * Inputs and expected outputs: three oversized responses consume initial plus two retries and reject.
	 * Edge case: each feedback keeps the configured limit while reporting its response's actual count.
	 * Dependencies: owner over-limit outcomes prove no direct write started.
	 */
	test("leaves storage unchanged when merge retries are exhausted", async () => {
		// Arrange: every allowed global merge response exceeds the same configured limit.
		const owner = new RecordingOwner();
		owner.overLimitTexts.set("large-1", { tokenCount: 11, tokenLimit: 5 });
		owner.overLimitTexts.set("large-2", { tokenCount: 12, tokenLimit: 5 });
		owner.overLimitTexts.set("large-3", { tokenCount: 13, tokenLimit: 5 });
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: "before", local: "changed" },
			outputs: ["large-1", "large-2", "large-3"],
			contexts,
		});

		// Act and assert: exhaustion fails before local deletion, state, or identity writes.
		await expect(runGlobalKnowledgeAccumulation(options)).rejects.toThrow(
			"merge output exceeds the knowledge token limit",
		);
		expect(owner.replacements.map(({ text }) => text)).toEqual([
			"large-1",
			"large-2",
			"large-3",
		]);
		expect(owner.deletions).toEqual([]);
		expect(owner.events.filter((event) => event === "write-state")).toEqual([]);
		expect(owner.events.filter((event) => event === "write-identity")).toEqual(
			[],
		);
		expect(String(contexts[2]?.messages.at(-1)?.content)).toContain("12");
		expect(String(contexts[2]?.messages.at(-1)?.content)).toContain("5");
	});
});
