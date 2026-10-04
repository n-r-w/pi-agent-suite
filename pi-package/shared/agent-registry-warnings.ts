import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Context required to display registry warnings and identify the active session. */
export interface AgentRegistryWarningContext {
	/** Whether Pi can display interactive notifications. */
	readonly hasUI?: boolean;
	/** User notification surface. */
	readonly ui: {
		/** Displays one registry warning. */
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	/** Session identity used to reset repeated-warning suppression. */
	readonly sessionManager: {
		/** Returns the session identity, including ephemeral sessions. */
		getSessionId(): string;
	};
}

/** Exchanges the reporter across separately loaded extension module copies. */
const REPORTER_REQUEST_CHANNEL = "pi-harness:agent-registry-warnings:request";

/** Mutable request slot for synchronous event-bus lookup. */
interface ReporterSlot {
	/** Reporter owned by the active extension runtime. */
	reporter: AgentRegistryWarningReporter | undefined;
}

/** Caches each extension API's reference to the runtime-shared reporter. */
const reportersByPi = new WeakMap<ExtensionAPI, AgentRegistryWarningReporter>();

/** Displays distinct registry warnings once per session through the latest context. */
class AgentRegistryWarningReporter {
	/** Most recent session context supplied by either registry consumer. */
	private context: AgentRegistryWarningContext | undefined;
	/** Session whose warnings have already been displayed. */
	private sessionId: string | undefined;
	/** Full warning messages already displayed in the active session. */
	private readonly reportedWarnings = new Set<string>();

	/** Updates the notification surface and starts a fresh warning set for a new session. */
	setContext(ctx: AgentRegistryWarningContext): void {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== this.sessionId) {
			this.reportedWarnings.clear();
			this.sessionId = sessionId;
		}
		this.context = ctx;
	}

	/** Reports a previously unseen warning to the TUI or stderr. */
	readonly report = (warning: string): void => {
		if (this.reportedWarnings.has(warning)) {
			return;
		}
		const message = `[agent-registry] ${warning}`;
		if (this.context !== undefined && this.context.hasUI !== false) {
			this.context.ui.notify(message, "warning");
		} else {
			process.stderr.write(`${message}\n`);
		}
		this.reportedWarnings.add(warning);
	};
}

/** Returns a registry warning reporter shared by extensions in one Pi runtime. */
export function getAgentRegistryWarningReporter(
	pi: ExtensionAPI,
	ctx?: AgentRegistryWarningContext,
): (warning: string) => void {
	let reporter = reportersByPi.get(pi);
	if (reporter === undefined) {
		const slot: ReporterSlot = { reporter: undefined };
		pi.events?.emit(REPORTER_REQUEST_CHANNEL, slot);
		reporter = slot.reporter ?? new AgentRegistryWarningReporter();
		reportersByPi.set(pi, reporter);
		if (slot.reporter === undefined) {
			const sharedReporter = reporter;
			pi.events?.on(REPORTER_REQUEST_CHANNEL, (data: unknown) => {
				(data as ReporterSlot).reporter = sharedReporter;
			});
		}
	}
	if (ctx !== undefined) {
		reporter.setContext(ctx);
	}
	return reporter.report;
}
