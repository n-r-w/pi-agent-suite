import {
	type ApiStreamSimpleFunction,
	openAIResponsesApi,
	registerSessionResourceCleanup,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

/** Extension entry point: sends model requests of the `openai` provider in WebSocket mode. */
export default function openAIWebSocket(pi: ExtensionAPI): void {
	createOpenAIWebSocketExtension({ responsesApi: openAIResponsesApi() })(pi);
}
