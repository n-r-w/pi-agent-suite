import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { MAX_VARIANT_CHARACTERS, MAX_VARIANT_LINES } from "./limits.js";
import {
	MERMAID_STRUCTURAL_WARNING_CODES,
	type MermaidAsciiVariants,
	type MermaidBlockRenderResult,
	type MermaidDiagnosticCode,
	type MermaidRenderOperationResult,
	type MermaidSourceBlock,
	type MermaidStructuralWarningCode,
} from "./types.js";
import {
	parseMermaidAsciiVariant,
	parseMermaidExplanation,
} from "./validation.js";

/** Maximum time allowed for one response-level render operation. */
const RENDER_TIMEOUT_MS = 5_000;
/** Bounded total standard output retained from one worker operation. */
const MAX_STDOUT_BYTES = 1_200_000;
/** Bounded diagnostic stream size retained for process classification. */
const MAX_STDERR_BYTES = 64_000;
/** Node exit code commonly used after an abort caused by V8 exhaustion. */
const V8_ABORT_EXIT_CODE = 134;
/** Worker path resolved beside the client in source and packaged layouts. */
const WORKER_PATH = fileURLToPath(
	new URL("./render-worker.js", import.meta.url),
);
/** Bun standalone executables need this mode to execute a JavaScript entry file. */
const BUN_WORKER_ENVIRONMENT = { BUN_BE_BUN: "1" };
/** Structural warning codes accepted from the isolated parser boundary. */
const STRUCTURAL_WARNING_CODES = new Set<MermaidStructuralWarningCode>(
	MERMAID_STRUCTURAL_WARNING_CODES,
);
/** Worker failure codes allowed inside an otherwise valid response. */
const WORKER_FAILURE_CODES = new Set<MermaidDiagnosticCode>([
	"invalid_syntax",
	"output_limit_exceeded",
	"render_failed",
]);

interface MermaidWorkerProcess {
	kill(signal: string): boolean;
	stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
	stdin: {
		end(value: string): void;
		on(event: "error", listener: (error: Error) => void): unknown;
	};
	stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
	once(
		event: "close",
		listener: (code: number | null, signal: string | null) => void,
	): unknown;
	once(event: "error", listener: (error: Error) => void): unknown;
}

export interface MermaidRenderClientDependencies {
	clearScheduledTimeout(token: unknown): void;
	scheduleTimeout(callback: () => void, delayMs: number): unknown;
	spawnWorker(): MermaidWorkerProcess;
}

export interface MermaidRenderClient {
	dispose(): void;
	render(
		blocks: readonly MermaidSourceBlock[],
		signal?: AbortSignal,
	): Promise<MermaidRenderOperationResult>;
}

interface ActiveRender {
	abort(): void;
}

/** Production process and timer dependencies kept injectable for deterministic tests. */
const DEFAULT_DEPENDENCIES: MermaidRenderClientDependencies = {
	clearScheduledTimeout: (token) =>
		clearTimeout(token as ReturnType<typeof setTimeout>),
	scheduleTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	spawnWorker: () =>
		spawn(process.execPath, [WORKER_PATH], {
			...(typeof process.versions["bun"] === "string"
				? { env: BUN_WORKER_ENVIRONMENT }
				: {}),
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		}) as unknown as MermaidWorkerProcess,
};

/** Creates the isolated Mermaid renderer client. */
export function createMermaidRenderClient(
	dependencies: MermaidRenderClientDependencies = DEFAULT_DEPENDENCIES,
): MermaidRenderClient {
	const activeRenders = new Set<ActiveRender>();
	return {
		dispose(): void {
			for (const activeRender of [...activeRenders]) {
				activeRender.abort();
			}
		},
		render: (blocks, signal) =>
			renderBlocks(blocks, signal, dependencies, activeRenders),
	};
}

/** Starts one bounded child process after cheap empty and cancellation checks. */
function renderBlocks(
	blocks: readonly MermaidSourceBlock[],
	signal: AbortSignal | undefined,
	dependencies: MermaidRenderClientDependencies,
	activeRenders: Set<ActiveRender>,
): Promise<MermaidRenderOperationResult> {
	if (blocks.length === 0) {
		return Promise.resolve({ status: "completed", results: [] });
	}
	if (signal?.aborted === true) {
		return Promise.resolve({ status: "aborted" });
	}
	try {
		return new RenderExecution(
			blocks,
			signal,
			dependencies,
			activeRenders,
		).start(dependencies.spawnWorker());
	} catch {
		return Promise.resolve(
			failedOperation(
				blocks,
				"render_process_failed",
				"The renderer process could not be started.",
			),
		);
	}
}

/** Owns the mutable resources for one child process and one settlement result. */
class RenderExecution implements ActiveRender {
	private child: MermaidWorkerProcess | undefined;
	private readonly stderrChunks: Buffer[] = [];
	private stderrBytes = 0;
	private readonly stdoutChunks: Buffer[] = [];
	private stdoutBytes = 0;
	private settled = false;
	private timeoutToken: unknown;
	private resolve: ((result: MermaidRenderOperationResult) => void) | undefined;

	public constructor(
		private readonly blocks: readonly MermaidSourceBlock[],
		private readonly signal: AbortSignal | undefined,
		private readonly dependencies: MermaidRenderClientDependencies,
		private readonly activeRenders: Set<ActiveRender>,
	) {}

	/** Attaches bounded streams and starts the request after every cleanup hook exists. */
	public start(
		child: MermaidWorkerProcess,
	): Promise<MermaidRenderOperationResult> {
		this.child = child;
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.activeRenders.add(this);
			child.stdout.on("data", (chunk) => this.captureStdout(chunk));
			child.stderr.on("data", (chunk) => this.captureStderr(chunk));
			child.stdin.on("error", () => this.handleProcessError());
			child.once("error", () => this.handleProcessError());
			child.once("close", (code, signal) => this.handleClose(code, signal));
			this.signal?.addEventListener("abort", this.abort, { once: true });
			if (this.signal?.aborted === true) {
				this.abort();
				return;
			}
			this.timeoutToken = this.dependencies.scheduleTimeout(
				() => this.handleTimeout(),
				RENDER_TIMEOUT_MS,
			);
			child.stdin.end(formatWorkerRequest(this.blocks));
		});
	}

	/** Converts user cancellation or session disposal into a context-free abort. */
	public readonly abort = (): void => this.settle({ status: "aborted" }, true);

	/** Captures standard output until its response-level byte bound is reached. */
	private captureStdout(chunk: Buffer): void {
		if (this.settled) {
			return;
		}
		this.stdoutBytes += chunk.length;
		if (this.stdoutBytes > MAX_STDOUT_BYTES) {
			this.fail(
				"output_limit_exceeded",
				"The renderer produced more output than the configured limit.",
			);
			return;
		}
		this.stdoutChunks.push(chunk);
	}

	/** Captures standard error only for bounded process failure classification. */
	private captureStderr(chunk: Buffer): void {
		if (this.settled) {
			return;
		}
		this.stderrBytes += chunk.length;
		if (this.stderrBytes > MAX_STDERR_BYTES) {
			this.fail(
				"output_limit_exceeded",
				"The renderer produced more diagnostic output than the configured limit.",
			);
			return;
		}
		this.stderrChunks.push(chunk);
	}

	/** Converts spawn and runtime process errors into one safe failure per block. */
	private handleProcessError(): void {
		this.fail(
			"render_process_failed",
			"The renderer process failed before producing a result.",
		);
	}

	/** Classifies process exit before parsing a successful response. */
	private handleClose(code: number | null, processSignal: string | null): void {
		if (this.settled) {
			return;
		}
		const stderr = Buffer.concat(this.stderrChunks).toString("utf8");
		if (code !== 0) {
			const memoryFailure = isMemoryFailure(code, processSignal, stderr);
			this.settle(
				failedOperation(
					this.blocks,
					memoryFailure ? "render_memory_limit" : "render_process_failed",
					memoryFailure
						? "The renderer exhausted available memory."
						: "The renderer process exited without a usable result.",
				),
				false,
			);
			return;
		}
		this.settle(
			parseWorkerResponse(
				Buffer.concat(this.stdoutChunks).toString("utf8"),
				this.blocks,
			),
			false,
		);
	}

	/** Converts the deterministic operation deadline into a timeout failure. */
	private handleTimeout(): void {
		this.fail(
			"render_timeout",
			"The renderer exceeded the five-second time limit.",
		);
	}

	/** Creates a failed operation and terminates the untrusted child. */
	private fail(code: MermaidDiagnosticCode, explanation: string): void {
		this.settle(failedOperation(this.blocks, code, explanation), true);
	}

	/** Releases operation resources before exposing exactly one result. */
	private settle(
		result: MermaidRenderOperationResult,
		terminate: boolean,
	): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		if (this.timeoutToken !== undefined) {
			this.dependencies.clearScheduledTimeout(this.timeoutToken);
		}
		this.signal?.removeEventListener("abort", this.abort);
		this.activeRenders.delete(this);
		if (terminate) {
			this.child?.kill("SIGKILL");
		}
		this.resolve?.(result);
	}
}

/** Serializes only the source fields required by the worker. */
function formatWorkerRequest(blocks: readonly MermaidSourceBlock[]): string {
	return JSON.stringify({
		blocks: blocks.map(({ source, sourceHash }) => ({ source, sourceHash })),
	});
}

/** Parses and validates the complete worker response as untrusted JSON. */
function parseWorkerResponse(
	payload: string,
	blocks: readonly MermaidSourceBlock[],
): MermaidRenderOperationResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload) as unknown;
	} catch {
		return failedOperation(
			blocks,
			"invalid_worker_response",
			"The renderer returned malformed JSON.",
		);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed["results"])) {
		return invalidResponse(blocks);
	}
	const rawResults = parsed["results"];
	if (rawResults.length !== blocks.length) {
		return invalidResponse(blocks);
	}

	const results: MermaidBlockRenderResult[] = [];
	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		const rawResult = rawResults[index];
		if (
			block === undefined ||
			!isRecord(rawResult) ||
			rawResult["sourceHash"] !== block.sourceHash
		) {
			return invalidResponse(blocks);
		}
		if (hasOversizedWorkerVariant(rawResult)) {
			return failedOperation(
				blocks,
				"output_limit_exceeded",
				"The renderer produced a variant larger than the configured limit.",
			);
		}
		const result = parseWorkerBlockResult(rawResult);
		if (result === undefined) {
			return invalidResponse(blocks);
		}
		results.push(result);
	}
	return { status: "completed", results };
}

/** Detects a structurally visible variant that exceeds persistence limits. */
function hasOversizedWorkerVariant(value: Record<string, unknown>): boolean {
	if (value["status"] !== "rendered" || !isRecord(value["variants"])) {
		return false;
	}
	return [value["variants"]["default"], value["variants"]["tight"]].some(
		(variant) =>
			isRecord(variant) &&
			typeof variant["text"] === "string" &&
			(variant["text"].length > MAX_VARIANT_CHARACTERS ||
				variant["text"].split("\n").length > MAX_VARIANT_LINES),
	);
}

/** Validates one result and recomputes display metadata after sanitization. */
function parseWorkerBlockResult(
	value: Record<string, unknown>,
): MermaidBlockRenderResult | undefined {
	const sourceHash = value["sourceHash"];
	if (typeof sourceHash !== "string") {
		return undefined;
	}
	if (value["status"] === "rendered") {
		const variants = parseWorkerVariants(value["variants"]);
		const compatibilityWarnings = parseStructuralWarnings(
			value["compatibilityWarnings"],
		);
		return variants === undefined || compatibilityWarnings === undefined
			? undefined
			: {
					status: "rendered",
					compatibilityWarnings,
					sourceHash,
					variants,
				};
	}
	if (
		value["status"] !== "failed" ||
		!isWorkerFailureCode(value["diagnosticCode"])
	) {
		return undefined;
	}
	const explanation = parseMermaidExplanation(value["explanation"]);
	return explanation === undefined
		? undefined
		: {
				status: "failed",
				sourceHash,
				diagnosticCode: value["diagnosticCode"],
				explanation,
			};
}

/** Validates finite structural warning codes returned by the worker parser. */
function parseStructuralWarnings(
	value: unknown,
): MermaidStructuralWarningCode[] | undefined {
	if (!Array.isArray(value) || value.length > STRUCTURAL_WARNING_CODES.size) {
		return undefined;
	}
	const warnings = new Set<MermaidStructuralWarningCode>();
	for (const warning of value) {
		if (
			typeof warning !== "string" ||
			!STRUCTURAL_WARNING_CODES.has(warning as MermaidStructuralWarningCode) ||
			warnings.has(warning as MermaidStructuralWarningCode)
		) {
			return undefined;
		}
		warnings.add(warning as MermaidStructuralWarningCode);
	}
	return [...warnings];
}

/** Validates exactly two worker variant objects. */
function parseWorkerVariants(value: unknown): MermaidAsciiVariants | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const defaultVariant = parseMermaidAsciiVariant(value["default"]);
	const tightVariant = parseMermaidAsciiVariant(value["tight"]);
	return defaultVariant === undefined || tightVariant === undefined
		? undefined
		: { default: defaultVariant, tight: tightVariant };
}

/** Produces one safe failure per source block without retaining partial output. */
function failedOperation(
	blocks: readonly MermaidSourceBlock[],
	diagnosticCode: MermaidDiagnosticCode,
	explanation: string,
): MermaidRenderOperationResult {
	return {
		status: "completed",
		results: blocks.map(({ sourceHash }) => ({
			status: "failed",
			sourceHash,
			diagnosticCode,
			explanation,
		})),
	};
}

/** Produces the common invalid-response failure. */
function invalidResponse(
	blocks: readonly MermaidSourceBlock[],
): MermaidRenderOperationResult {
	return failedOperation(
		blocks,
		"invalid_worker_response",
		"The renderer returned a response that does not match the expected contract.",
	);
}

/** Distinguishes V8 heap exhaustion from other abnormal process exits. */
function isMemoryFailure(
	code: number | null,
	processSignal: string | null,
	stderr: string,
): boolean {
	const normalizedStderr = stderr.toLowerCase();
	return (
		code === V8_ABORT_EXIT_CODE ||
		processSignal === "SIGABRT" ||
		normalizedStderr.includes("heap out of memory") ||
		normalizedStderr.includes("allocation failed")
	);
}

/** Narrows finite worker-owned failure codes. */
function isWorkerFailureCode(
	value: unknown,
): value is "invalid_syntax" | "output_limit_exceeded" | "render_failed" {
	return (
		typeof value === "string" &&
		WORKER_FAILURE_CODES.has(value as MermaidDiagnosticCode)
	);
}

/** Narrows unknown JSON values before reading named fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
