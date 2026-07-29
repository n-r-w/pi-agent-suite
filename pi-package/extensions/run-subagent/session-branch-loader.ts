import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseConversationSessionEntry } from "./session-entry-validation";

/** Converts the documented chunk size to bytes. */
const BYTES_PER_KIB = 1024;
/** Balances syscall count with the selected-only preview memory bound. */
const REVERSE_READ_CHUNK_KIB = 64;
const REVERSE_READ_CHUNK_BYTES = REVERSE_READ_CHUNK_KIB * BYTES_PER_KIB;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** Configures one selected-session branch cursor. */
export interface SessionBranchCursorOptions {
	/** Identifies the persisted JSONL session to read. */
	readonly sessionFile: string;
	/** Selects the active leaf, or the latest persisted entry when omitted. */
	readonly leafId?: string;
	/** Cancels pending file reads when selection changes or the screen closes. */
	readonly signal?: AbortSignal;
}

/** Reads one persisted session branch from its leaf toward the root. */
export interface SessionBranchCursor {
	/** Reports whether the cursor reached the root of the selected branch. */
	readonly complete: boolean;
	/** Returns the next dependency-complete user turn in chronological order. */
	readPreviousTurn(): Promise<readonly SessionEntry[]>;
	/** Returns every unread ancestor in chronological order. */
	readRemaining(): Promise<readonly SessionEntry[]>;
	/** Releases the file handle and rejects later reads. */
	dispose(): Promise<void>;
}

/** Reads complete UTF-8 lines from the end of one immutable file snapshot. */
class ReverseLineReader {
	private buffer = Buffer.alloc(0);
	private disposed = false;
	private position: number;

	private constructor(
		private readonly handle: FileHandle,
		fileSize: number,
		private readonly signal: AbortSignal | undefined,
	) {
		this.position = fileSize;
	}

	/** Opens one file and fixes the byte boundary used by subsequent reverse reads. */
	public static async open(
		filePath: string,
		signal?: AbortSignal,
	): Promise<ReverseLineReader> {
		throwIfAborted(signal);
		const handle = await open(filePath, "r");
		try {
			const metadata = await handle.stat();
			throwIfAborted(signal);
			return new ReverseLineReader(handle, metadata.size, signal);
		} catch (error) {
			await handle.close();
			throw error;
		}
	}

	/** Returns the preceding non-empty line without reading the complete file. */
	public async readPreviousLine(): Promise<Buffer | undefined> {
		this.requireOpen();
		throwIfAborted(this.signal);
		const separator = this.buffer.lastIndexOf(LINE_FEED);
		if (separator >= 0) {
			const line = trimTrailingCarriageReturn(
				Buffer.from(this.buffer.subarray(separator + 1)),
			);
			this.buffer = Buffer.from(this.buffer.subarray(0, separator));
			return line.length > 0 ? line : this.readPreviousLine();
		}
		if (this.position === 0) {
			return this.takeFileStartLine();
		}
		await this.prependChunk();
		return this.readPreviousLine();
	}

	/** Returns the first physical line after every later chunk has been consumed. */
	private takeFileStartLine(): Buffer | undefined {
		if (this.buffer.length === 0) {
			return undefined;
		}
		const line = trimTrailingCarriageReturn(this.buffer);
		this.buffer = Buffer.alloc(0);
		return line.length === 0 ? undefined : line;
	}

	/** Prepends one bounded byte range before retrying line segmentation. */
	private async prependChunk(): Promise<void> {
		const length = Math.min(REVERSE_READ_CHUNK_BYTES, this.position);
		const start = this.position - length;
		const chunk = Buffer.allocUnsafe(length);
		const { bytesRead } = await this.handle.read(chunk, 0, length, start);
		throwIfAborted(this.signal);
		if (bytesRead !== length) {
			throw new Error("child Pi session file changed during reverse read");
		}
		this.position = start;
		this.buffer = Buffer.concat([chunk, this.buffer]);
	}

	/** Closes the underlying descriptor exactly once. */
	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		await this.handle.close();
	}

	/** Rejects reads after ownership of the file descriptor has ended. */
	private requireOpen(): void {
		if (this.disposed) {
			throw new Error("session branch cursor is disposed");
		}
	}
}

/** Traverses only parent-linked entries while skipping newer sibling branches. */
class PersistedSessionBranchCursor implements SessionBranchCursor {
	private disposed = false;
	private nextId: string | null;
	private nextEntry: SessionEntry | undefined;

	public constructor(
		private readonly reader: ReverseLineReader,
		leaf: SessionEntry | undefined,
	) {
		this.nextEntry = leaf;
		this.nextId = leaf?.parentId ?? null;
	}

	/** Reports completion only after the selected root entry has been consumed. */
	public get complete(): boolean {
		return this.nextEntry === undefined && this.nextId === null;
	}

	/** Returns one user turn so tool results retain their preceding tool calls. */
	public async readPreviousTurn(): Promise<readonly SessionEntry[]> {
		this.requireOpen();
		if (this.complete) {
			return [];
		}
		const reverseTurn: SessionEntry[] = [];
		await this.collectPreviousTurn(reverseTurn);
		return reverseTurn.reverse();
	}

	/** Consumes the rest of the selected branch with one chronological result. */
	public async readRemaining(): Promise<readonly SessionEntry[]> {
		this.requireOpen();
		const reverseEntries: SessionEntry[] = [];
		await this.collectRemaining(reverseEntries);
		return reverseEntries.reverse();
	}

	/** Releases the reverse reader and makes later reads fail explicitly. */
	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		await this.reader.dispose();
	}

	/** Collects one complete turn through sequential parent-linked reads. */
	private async collectPreviousTurn(target: SessionEntry[]): Promise<void> {
		if (this.complete) {
			return;
		}
		const entry = await this.takeNextEntry();
		target.push(entry);
		if (!isUserMessageEntry(entry)) {
			await this.collectPreviousTurn(target);
		}
	}

	/** Collects every unread ancestor without concurrent file-handle access. */
	private async collectRemaining(target: SessionEntry[]): Promise<void> {
		if (this.complete) {
			return;
		}
		target.push(await this.takeNextEntry());
		await this.collectRemaining(target);
	}

	/** Resolves the next required parent while ignoring unrelated append-order rows. */
	private async takeNextEntry(): Promise<SessionEntry> {
		if (this.nextEntry !== undefined) {
			const entry = this.nextEntry;
			this.nextEntry = undefined;
			return entry;
		}
		const expectedId = this.nextId;
		if (expectedId === null) {
			throw new Error("session branch cursor reached its root unexpectedly");
		}
		const entry = await readPreviousSessionEntry(this.reader);
		if (entry === undefined) {
			throw new Error(
				"child Pi session file does not contain the selected branch parent",
			);
		}
		if (entry.id !== expectedId) {
			return this.takeNextEntry();
		}
		this.nextId = entry.parentId;
		return entry;
	}

	/** Rejects calls after the selected-session owner releases this cursor. */
	private requireOpen(): void {
		if (this.disposed) {
			throw new Error("session branch cursor is disposed");
		}
	}
}

/** Finds the latest complete persisted entry without loading the session file. */
export async function readLatestSessionEntryId(
	sessionFile: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const reader = await ReverseLineReader.open(sessionFile, signal);
	try {
		return (await readPreviousSessionEntry(reader))?.id;
	} finally {
		await reader.dispose();
	}
}

/** Opens one lazy reverse cursor for a persisted session branch. */
export async function openSessionBranchCursor(
	options: SessionBranchCursorOptions,
): Promise<SessionBranchCursor> {
	const reader = await ReverseLineReader.open(
		options.sessionFile,
		options.signal,
	);
	try {
		const leaf = await findLeafEntry(reader, options.leafId);
		return new PersistedSessionBranchCursor(reader, leaf);
	} catch (error) {
		await reader.dispose();
		throw error;
	}
}

/** Scans append order backward until the requested leaf or latest entry is found. */
async function findLeafEntry(
	reader: ReverseLineReader,
	leafId: string | undefined,
): Promise<SessionEntry | undefined> {
	const entry = await readPreviousSessionEntry(reader);
	if (entry === undefined) {
		if (leafId === undefined) {
			return undefined;
		}
		throw new Error("child Pi session file does not contain the selected leaf");
	}
	return leafId === undefined || entry.id === leafId
		? entry
		: findLeafEntry(reader, leafId);
}

/** Parses one reverse JSONL row and stops cleanly at the session header. */
async function readPreviousSessionEntry(
	reader: ReverseLineReader,
): Promise<SessionEntry | undefined> {
	const line = await reader.readPreviousLine();
	if (line === undefined) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(line.toString("utf8"));
	} catch (error) {
		throw new Error("child Pi session file contains invalid JSON", {
			cause: error,
		});
	}
	if (isSessionHeader(value)) {
		return undefined;
	}
	return parseConversationSessionEntry(value, "child Pi session file");
}

/** Detects the one header row that is not part of the parent-linked branch. */
function isSessionHeader(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>)["type"] === "session"
	);
}

/** Marks user messages as safe boundaries for dependency-complete preview turns. */
function isUserMessageEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

/** Preserves explicit Error cancellation while normalizing other abort reasons. */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted !== true) {
		return;
	}
	throw signal.reason instanceof Error
		? signal.reason
		: new Error("session branch loading was cancelled");
}

/** Removes Windows line endings after byte-safe reverse segmentation. */
function trimTrailingCarriageReturn(line: Buffer): Buffer {
	return line.at(-1) === CARRIAGE_RETURN ? line.subarray(0, -1) : line;
}
