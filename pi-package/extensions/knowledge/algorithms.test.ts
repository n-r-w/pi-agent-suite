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
function response(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
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
		stopReason,
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
		preferredRemotes: ["origin"],
		extraction: {
			model: undefined,
			thinking: undefined,
			systemPrompt: "extract system",
			taskPrompt: "summarize projected session",
			maxFractionDenominator: 8,
			initialFraction: 2 / 3,
			reductionCoefficient: 3 / 4,
		},
		mergeLocal: {
			model: undefined,
			thinking: undefined,
			systemPrompt: "merge local system",
			taskPrompt: "merge local task prompt",
			maxFractionDenominator: 8,
			initialFraction: 2 / 3,
			reductionCoefficient: 3 / 4,
		},
		mergeGlobal: {
			model: undefined,
			thinking: undefined,
			systemPrompt: "merge global system",
			taskPrompt: "merge global task prompt",
			maxFractionDenominator: 8,
			initialFraction: 2 / 3,
			reductionCoefficient: 3 / 4,
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
	readonly stopReasons?: readonly AssistantMessage["stopReason"][];
	readonly reportProgress?: Parameters<
		typeof runLocalKnowledgeAccumulation
	>[0]["reportProgress"];
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
			const stopReason = options.stopReasons?.[outputIndex] ?? "stop";
			outputIndex += 1;
			if (text === undefined) {
				throw new Error("unexpected completion call");
			}
			return response(text, stopReason);
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
		...(options.reportProgress === undefined
			? {}
			: { reportProgress: options.reportProgress }),
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
	 * Proves summary-source serialization keeps visible text while dropping bulky non-text payloads.
	 * Inputs and expected outputs: one replayed assistant message with thinking and tool-call payload retains only text content.
	 * Edge case: hidden payload values such as thinking signatures and tool arguments never appear in the extraction request.
	 * Dependencies: local extraction request assembly serializes replayed branch messages before model invocation.
	 */
	test("serializes only text payload in summary source", async () => {
		// Arrange: replay returns one assistant message with both visible text and hidden payload blocks.
		const owner = new RecordingOwner();
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: null, local: null },
			outputs: ["NOT_FOUND"],
			contexts,
		});
		const noisyAssistant = response("assistant visible");
		(noisyAssistant as unknown as { content: unknown }).content = [
			{
				type: "thinking",
				thinking: "internal reasoning",
				thinkingSignature: "private-signature",
			},
			{ type: "text", text: "assistant visible" },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "/private/path" },
			},
		];
		(options as { replay: NonNullable<typeof options.replay> }).replay =
			async () =>
				[noisyAssistant] as Awaited<
					ReturnType<NonNullable<typeof options.replay>>
				>;

		// Act.
		const result = await runLocalKnowledgeAccumulation(options);

		// Assert.
		expect(result).toEqual({ kind: "noop" });
		const content = String(contexts[0]?.messages[0]?.content);
		expect(content).toContain("assistant visible");
		expect(content).not.toContain("private-signature");
		expect(content).not.toContain("/private/path");
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
	 * Proves oversized merge repair resends the same request with a reduced target before replacement.
	 * Inputs and expected outputs: one fitting extraction, one oversized merge, and one fitting repair.
	 * Edge case: stored local knowledge is supplied to merge and replacement occurs only for the within-limit response.
	 * Dependencies: the owner supplies the authoritative tokenizer count used in size rejection.
	 */
	test("repairs oversized local merge before replacement", async () => {
		// Arrange: one fitting extraction, one oversized merge, and one fitting repair.
		const owner = new RecordingOwner();
		owner.overLimitTexts.set("oversized merge", {
			tokenCount: 17,
			tokenLimit: 5,
		});
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: "global", local: "stored local" },
			outputs: ["## New", "oversized merge", "## Merged"],
			contexts,
		});

		// Act: local accumulation repairs the merge size defect within the reduced-target chain.
		const result = await runLocalKnowledgeAccumulation(options);

		// Assert: the merge retry resends one reduced-target message without previous-output history.
		expect(result).toEqual({ kind: "written" });
		expect(contexts).toHaveLength(3);
		const mergeRetry = String(contexts[2]?.messages[0]?.content);
		expect(contexts[2]?.messages).toHaveLength(1);
		expect(mergeRetry).toContain("1/2 of an A4 page");
		expect(mergeRetry).toContain("Hard token ceiling: 5000 tokens");
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
	 * Proves an empty extraction output violates the response contract and fails immediately.
	 * Inputs and expected outputs: one empty extraction response throws without any storage write.
	 * Edge case: the empty response must not consume a reduced-target retry or format feedback.
	 * Dependencies: extractKnowledgeAttempt routes empty text to a contract error.
	 */
	test("fails immediately on empty extraction output", async () => {
		// Arrange: extraction returns one empty non-NOT_FOUND response.
		const owner = new RecordingOwner();
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: null, local: null },
			outputs: [""],
			contexts,
		});

		// Act and assert: the empty output fails without retries or writes.
		await expect(runLocalKnowledgeAccumulation(options)).rejects.toThrow(
			"knowledge extraction response contract was not satisfied:",
		);
		expect(contexts).toHaveLength(1);
		expect(owner.events).toEqual([]);
	});

	/**
	 * Proves truncated extraction is repaired like an oversized one regardless of output length:
	 * one reduced-target retry without history.
	 * Inputs and expected outputs: truncated extraction (with text or empty) is retried at
	 * 1/2 of an A4 page, then a fitting repair and one merge write.
	 * Edge case: the retry rebuilds a single-message context and never resends the truncated output.
	 * Dependencies: the size-target reduction chain owned by size-target.ts.
	 */
	test("treats truncated extraction as a size defect with a reduced target", async () => {
		// Arrange: each truncation variant (with text or empty) is followed by a fitting repair; merge fits once.
		for (const truncated of ["truncated output", ""]) {
			const owner = new RecordingOwner();
			const contexts: Context[] = [];
			const options = createOptions({
				owner,
				snapshots: { global: null, local: null },
				outputs: [truncated, "## New", "## Merged"],
				stopReasons: ["length", "stop", "stop"],
				contexts,
			});

			// Act: run one local accumulation over a truncated extraction response.
			const result = await runLocalKnowledgeAccumulation(options);

			// Assert: the retry resends one reduced-target message without previous-output history.
			expect(result).toEqual({ kind: "written" });
			expect(contexts).toHaveLength(3);
			expect(contexts[1]?.messages).toHaveLength(1);
			const extractionRetry = String(contexts[1]?.messages[0]?.content);
			expect(extractionRetry).toContain("1/2 of an A4 page");
			expect(extractionRetry).toContain("Hard token ceiling: 5000 tokens");
			expect(extractionRetry).not.toContain(
				"Return non-empty concise Markdown",
			);
			expect(owner.replacements.map(({ text }) => text)).toEqual(["## Merged"]);
		}
	});

	/**
	 * Proves oversized extraction walks the reduced-target chain and stops at the fraction floor.
	 * Inputs and expected outputs: oversized extraction goes 2/3 → 1/2 → 3/8 → 1/4 → 1/8 and throws
	 * at the floor because the next step cannot shrink further.
	 * Edge case: the final retry uses the minimum fraction; no storage write ever starts.
	 * Dependencies: the fixed o200k tokenizer and the configured-scale floor contract.
	 */
	test("stops oversized extraction at the fraction floor", async () => {
		// Arrange: every extraction attempt exceeds the configured token limit.
		const owner = new RecordingOwner();
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: null, local: null },
			outputs: [
				`${"oversized ".repeat(20)}`,
				`${"oversized ".repeat(20)}`,
				`${"oversized ".repeat(20)}`,
				`${"oversized ".repeat(20)}`,
				`${"oversized ".repeat(20)}`,
			],
			contexts,
			configuration: config({ localTokenLimit: 5 }),
		});

		// Act and assert: the chain reaches 1/8 and the next step cannot shrink, so extraction throws.
		await expect(runLocalKnowledgeAccumulation(options)).rejects.toThrow(
			"knowledge extraction output exceeds the knowledge token limit or was truncated",
		);
		expect(contexts).toHaveLength(5);
		const finalRetry = String(contexts[4]?.messages[0]?.content);
		expect(contexts[4]?.messages).toHaveLength(1);
		expect(finalRetry).toContain("1/8 of an A4 page");
		expect(finalRetry).toContain("Hard token ceiling: 5 tokens");
		expect(owner.events).toEqual([]);
	});

	/**
	 * Proves each reduced-target extraction retry is announced with its new size target.
	 * Inputs and expected outputs: two oversized extractions walk 2/3 → 1/2 → 3/8, then extraction fits.
	 * Edge case: the merge progress follows the last extraction retry in order.
	 * Dependencies: reportProgress is the user-visible progress boundary.
	 */
	test("reports each reduced-target extraction retry", async () => {
		// Arrange: two oversized extraction attempts walk the chain, then extraction fits.
		const owner = new RecordingOwner();
		const contexts: Context[] = [];
		const progress: string[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: null, local: null },
			outputs: [
				`${"oversized ".repeat(20)}`,
				`${"oversized ".repeat(20)}`,
				"## New",
				"## Merged",
			],
			contexts,
			configuration: config({ localTokenLimit: 5 }),
			reportProgress: (operation, reducedTarget) => {
				progress.push(
					reducedTarget === undefined
						? operation
						: `${operation}:${reducedTarget}`,
				);
			},
		});

		// Act: run one local accumulation over two oversized extraction responses.
		await runLocalKnowledgeAccumulation(options);

		// Assert: each retry announces its new size target before the merge starts.
		expect(progress).toEqual([
			"prepare_local_summary",
			"extraction_retry:1/2 of an A4 page",
			"extraction_retry:3/8 of an A4 page",
			"merge_local_knowledge",
		]);
	});

	/**
	 * Proves provider-truncated merge output is retried with a reduced target.
	 * Inputs and expected outputs: one truncated merge response is followed by one fitting repair that writes.
	 * Edge case: the truncation path mirrors extraction and never resends the truncated output.
	 * Dependencies: retryMergeWithReducedTarget and the size-target reduction chain.
	 */
	test("retries provider-truncated merge with a reduced target", async () => {
		// Arrange: global merge first truncates, then returns a fitting repair.
		const owner = new RecordingOwner();
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: "global old", local: "local new" },
			outputs: ["truncated merge", "## Merged"],
			stopReasons: ["length", "stop"],
			contexts,
		});

		// Act: global accumulation runs over one truncated merge response.
		await runGlobalKnowledgeAccumulation(options);

		// Assert: the retry resends one reduced-target message without previous-output history.
		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.messages).toHaveLength(1);
		const mergeRetry = String(contexts[1]?.messages[0]?.content);
		expect(mergeRetry).toContain("1/2 of an A4 page");
		expect(owner.replacements.map(({ text }) => text)).toEqual(["## Merged"]);
	});

	/**
	 * Proves an empty truncated merge response is still a size defect.
	 * Inputs and expected outputs: a reasoning model that spends its whole output budget on thinking
	 * returns zero text parts with stopReason "length"; the merge retry uses a reduced target, not a format error.
	 * Edge case: empty text plus truncation must not fail the merge before the size repair.
	 * Dependencies: retryMergeWithReducedTarget and the size-target reduction chain.
	 */
	test("treats empty truncated merge as a size defect with a reduced target", async () => {
		// Arrange: global merge first returns empty text truncated by the provider, then a fitting repair.
		const owner = new RecordingOwner();
		const contexts: Context[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: "global old", local: "local new" },
			outputs: ["", "## Merged"],
			stopReasons: ["length", "stop"],
			contexts,
		});

		// Act: global accumulation runs over one empty truncated merge response.
		await runGlobalKnowledgeAccumulation(options);

		// Assert: the retry resends one reduced-target message without previous-output history.
		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.messages).toHaveLength(1);
		const mergeRetry = String(contexts[1]?.messages[0]?.content);
		expect(mergeRetry).toContain("1/2 of an A4 page");
		expect(owner.replacements.map(({ text }) => text)).toEqual(["## Merged"]);
	});

	/**
	 * Proves the merge request appends the task prompt after data to prevent prompt injection.
	 * Inputs and expected outputs: one global merge captures the initial request message.
	 * Edge case: task prompt must appear after </incoming_knowledge> so data does not trail last.
	 * Dependencies: formatMergeRequest owns the exact ordering contract.
	 */
	test("appends task prompt after incoming knowledge in merge request", async () => {
		// Arrange: one fitting global merge response.
		const owner = new RecordingOwner();
		const contexts: Context[] = [];
		const progress: string[] = [];
		const options = createOptions({
			owner,
			snapshots: { global: "global old", local: "local new" },
			outputs: ["## Merged"],
			contexts,
			reportProgress: (operation, reducedTarget) => {
				progress.push(
					reducedTarget === undefined
						? operation
						: `${operation}:${reducedTarget}`,
				);
			},
		});

		// Act: global accumulation sends one merge request.
		await runGlobalKnowledgeAccumulation(options);

		// Assert: the merge request message ends with the task prompt after all data.
		const mergeMessage = String(contexts[0]?.messages[0]?.content);
		const incomingEnd = mergeMessage.lastIndexOf("</incoming_knowledge>");
		expect(incomingEnd).toBeGreaterThan(-1);
		const taskPromptStart = mergeMessage.indexOf("merge global task prompt");
		expect(taskPromptStart).toBeGreaterThan(incomingEnd);
		expect(progress).toEqual(["merge_global_knowledge"]);
	});
});
