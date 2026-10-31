import type { ContinuationRecord } from "./continuation";
import { closeSocket } from "./socket";

/** Idle time after which the extension closes a pooled connection: 5 minutes. */
const IDLE_LIMIT_MS = 300_000;

/** Age after which the extension stops using a connection: 55 minutes, while OpenAI closes connections after 60. */
const AGE_LIMIT_MS = 3_300_000;

/** Interval of the check that closes expired idle connections. */
const SWEEP_INTERVAL_MS = 60_000;

/** `WebSocket.readyState` of an open connection. */
const OPEN_READY_STATE = 1;

/** An open connection to the Responses endpoint that serves one response at a time. */
export interface Connection {
	readonly socket: WebSocket;
	/** Key in the pool; undefined for a connection that serves one request and closes. */
	readonly poolKey: string | undefined;
	readonly sessionId: string | undefined;
	readonly openedAt: number;
	lastUsedAt: number;
	busy: boolean;
	continuation: ContinuationRecord | undefined;
}

/** Where a request wants its connection: a pooled one under `poolKey`, or its own when `poolKey` is undefined. */
export interface ConnectionTarget {
	readonly poolKey: string | undefined;
	readonly sessionId: string | undefined;
}

/** Open connections of one pi process, reused by the model requests of the same session and model. */
export class ConnectionPool {
	readonly #connections = new Map<string, Connection>();
	#sweepTimer: ReturnType<typeof setInterval> | undefined;

	/** Returns the idle pooled connection of the target, or a new connection that `open` creates. */
	async acquire(
		target: ConnectionTarget,
		open: () => Promise<WebSocket>,
	): Promise<Connection> {
		const pooled =
			target.poolKey === undefined
				? undefined
				: this.#connections.get(target.poolKey);
		if (pooled !== undefined && !pooled.busy) {
			if (isUsable(pooled, Date.now())) {
				pooled.busy = true;
				return pooled;
			}
			this.#close(pooled);
		}
		const socket = await open();
		const now = Date.now();
		const poolKey =
			target.poolKey !== undefined && !this.#connections.has(target.poolKey)
				? target.poolKey
				: undefined;
		const connection: Connection = {
			socket,
			poolKey,
			sessionId: target.sessionId,
			openedAt: now,
			lastUsedAt: now,
			busy: true,
			continuation: undefined,
		};
		if (poolKey !== undefined) {
			this.#connections.set(poolKey, connection);
			this.#startSweep();
		}
		return connection;
	}

	/** Returns a connection after its response; `keep` false, or a connection outside the pool, closes it. */
	release(connection: Connection, keep: boolean): void {
		connection.busy = false;
		connection.lastUsedAt = Date.now();
		const pooled =
			connection.poolKey !== undefined &&
			this.#connections.get(connection.poolKey) === connection;
		if (!(keep && pooled)) {
			this.#close(connection);
		}
	}

	/** Closes the pooled connections of one session, or of all sessions when `sessionId` is undefined. */
	closeAll(sessionId?: string): void {
		for (const connection of [...this.#connections.values()]) {
			if (sessionId === undefined || connection.sessionId === sessionId) {
				this.#close(connection);
			}
		}
	}

	#close(connection: Connection): void {
		closeSocket(connection.socket);
		if (
			connection.poolKey !== undefined &&
			this.#connections.get(connection.poolKey) === connection
		) {
			this.#connections.delete(connection.poolKey);
		}
		if (this.#connections.size === 0) {
			clearInterval(this.#sweepTimer);
			this.#sweepTimer = undefined;
		}
	}

	#startSweep(): void {
		if (this.#sweepTimer !== undefined) {
			return;
		}
		this.#sweepTimer = setInterval(() => {
			const now = Date.now();
			for (const connection of [...this.#connections.values()]) {
				if (!(connection.busy || isUsable(connection, now))) {
					this.#close(connection);
				}
			}
		}, SWEEP_INTERVAL_MS);
		// The check must not keep a finished pi process alive.
		this.#sweepTimer.unref?.();
	}
}

/** Returns true when a connection is open and within its idle and age limits. */
function isUsable(connection: Connection, now: number): boolean {
	return (
		connection.socket.readyState === OPEN_READY_STATE &&
		now - connection.lastUsedAt < IDLE_LIMIT_MS &&
		now - connection.openedAt < AGE_LIMIT_MS
	);
}
