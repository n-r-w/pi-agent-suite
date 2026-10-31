import {
	type ApiStreamSimpleFunction,
	openAIResponsesApi,
	registerSessionResourceCleanup,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readOpenAIWebSocketConfig } from "./config";
import { ConnectionPool } from "./connection-pool";
import { createStreamFunction, type TransportState } from "./stream";

/** Implementation of the `openai-responses` API that the extension sends in WebSocket mode. */
export interface OpenAIWebSocketDependencies {
	readonly responsesApi: { readonly streamSimple: ApiStreamSimpleFunction };
}

/** Creates the extension entry point over the given `openai-responses` implementation. */
export function createOpenAIWebSocketExtension(
	dependencies: OpenAIWebSocketDependencies,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		const config = readOpenAIWebSocketConfig();
		if (config.kind === "invalid") {
			reportConfigIssueOnce(pi, config.issue);
			return;
		}
		if (config.kind === "disabled") {
			return;
		}
		let warned = false;
		let report = (message: string): void => {
			process.stderr.write(`${message}\n`);
		};
		const state: TransportState = {
			pool: new ConnectionPool(),
			httpSessions: new Set(),
			warn: (message) => {
				if (!warned) {
					warned = true;
					report(message);
				}
			},
		};
		pi.registerProvider("openai", {
			api: "openai-responses",
			streamSimple: createStreamFunction(
				dependencies.responsesApi.streamSimple,
				state,
			),
		});
		// Covers modes that dispose a session without the session_shutdown event.
		const unregisterCleanup = registerSessionResourceCleanup((sessionId) =>
			state.pool.closeAll(sessionId),
		);
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) {
				report = (message) => ctx.ui.notify(message, "warning");
			}
		});
		pi.on("session_shutdown", () => {
			state.pool.closeAll();
			unregisterCleanup();
		});
	};
}

/** Reports an invalid configuration at the first session start; pi keeps its own HTTP transport. */
function reportConfigIssueOnce(pi: ExtensionAPI, issue: string): void {
	let reported = false;
	pi.on("session_start", (_event, ctx) => {
		if (reported) {
			return;
		}
		reported = true;
		const message = `[openai-websocket] ${issue}. Extension disabled.`;
		if (ctx.hasUI) {
			ctx.ui.notify(message, "error");
		} else {
			process.stderr.write(`${message}\n`);
		}
	});
}

/** Extension entry point: sends model requests of the `openai` provider in WebSocket mode. */
export default function openAIWebSocket(pi: ExtensionAPI): void {
	createOpenAIWebSocketExtension({ responsesApi: openAIResponsesApi() })(pi);
}
