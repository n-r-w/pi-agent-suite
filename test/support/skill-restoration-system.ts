import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import skillRestoration from "../../pi-package/extensions/skill-restoration/index";
import { RESTORATION_TYPE } from "../../pi-package/extensions/skill-restoration/restoration";
import { createPersistedSession } from "./persisted-session";
import { createSkillAssistant } from "./skill-restoration-fixtures";
import {
	RestorationObserver,
	type RestorationSnapshot,
} from "./skill-restoration-observer";

/** Provides a fake model for native and forced system-head scenarios. */
const MODEL: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "preserved-system",
	id: "fake",
	name: "Fake",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 5500,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Represents the combined response reserve and keep-recent headroom. */
const HEADROOM = 200;

/** Captures run lifecycle events and final provider snapshots. */
interface ScenarioState {
	readonly snapshots: RestorationSnapshot[];
	readonly compactions: string[];
	beforeStarts: number;
	responses: number;
}

/** Seeds preserved system state and a compaction path record. */
function prepareFixture(root: string, mode: string) {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			compaction: {
				enabled: mode === "auto",
				reserveTokens: 100,
				keepRecentTokens: 100,
			},
			retry: { enabled: false },
		}),
	);
	const skill = join(root, "skill.md");
	const fileRepeats = 2000;
	writeFileSync(skill, "skill ".repeat(fileRepeats));
	const manager = createPersistedSession(root);
	const checkpointRepeats = 3000;
	manager.appendMessage({
		role: "system",
		content: "checkpoint ".repeat(checkpointRepeats),
		sections: { checkpoint: "fixture section" },
		toolsAdded: [
			{
				name: "read",
				description: "old read declaration",
				parameters: { type: "object", properties: {} },
			},
		],
		timestamp: 2,
	});
	manager.appendMessage({
		role: "user",
		content: "fixture history",
		timestamp: 3,
	});
	const compactionId = manager.appendCompaction("fixture summary", null, 10);
	manager.appendCustomEntry(RESTORATION_TYPE, {
		compactionId,
		candidates: [skill],
	});
	return {
		agentDir,
		skill,
		manager,
		settings: SettingsManager.create(root, agentDir),
	};
}

/** Creates fake responses, including an overflow error for automatic compaction. */
function createResponse(state: ScenarioState, mode: string) {
	state.responses += 1;
	const message = {
		...createSkillAssistant([{ type: "text", text: "fixture response" }]),
		provider: MODEL.provider,
		timestamp: Date.now(),
	};
	if (mode === "auto" && state.responses === 1) {
		message.stopReason = "error";
		message.errorMessage = "maximum context length exceeded";
		message.usage = {
			...message.usage,
			input: 6000,
			output: 0,
			totalTokens: 6000,
		};
	}
	return message;
}

/** Registers a later prompt contributor and native compaction lifecycle instrumentation. */
function registerLifecycle(
	pi: ExtensionAPI,
	state: ScenarioState,
	mode: string,
): void {
	pi.on("before_agent_start", () => {
		state.beforeStarts += 1;
		if (mode === "native" || (mode === "replace" && state.beforeStarts > 1)) {
			return;
		}
		const repeats = 1500;
		return { systemPrompt: mode === "empty" ? "" : "forced ".repeat(repeats) };
	});
	pi.on("session_compact", (event) => {
		state.compactions.push(event.reason);
	});
	if (mode === "auto" || mode === "replace") {
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "automatic fixture summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));
	}
}

/** Observes the final fake-provider Context after Pi's forced-prompt projection. */
function registerProvider(
	pi: ExtensionAPI,
	state: ScenarioState,
	mode: string,
): void {
	const observer = new RestorationObserver(pi);
	pi.registerProvider(MODEL.provider, {
		api: MODEL.api,
		baseUrl: MODEL.baseUrl,
		apiKey: "fixture",
		models: [MODEL],
		streamSimple: (_model, context) => {
			const snapshot = observer.capture(context);
			if (snapshot) {
				state.snapshots.push(snapshot);
			}
			const stream = createAssistantMessageEventStream();
			const message = createResponse(state, mode);
			queueMicrotask(() => {
				if (message.stopReason === "error") {
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					stream.push({ type: "done", reason: "stop", message });
				}
				stream.end(message);
			});
			return stream;
		},
	});
}

/** Exercises native, later-forced, rerun, manual and same-run continuation request preparation. */
async function run(): Promise<void> {
	const root = process.argv[2];
	const mode = process.argv[3] ?? "native";
	if (!root) {
		throw new Error("fixture root is required");
	}
	const { agentDir, skill, manager, settings } = prepareFixture(root, mode);
	const state: ScenarioState = {
		snapshots: [],
		compactions: [],
		beforeStarts: 0,
		responses: 0,
	};
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noContextFiles: true,
		extensionFactories: [
			skillRestoration,
			(pi) => {
				registerLifecycle(pi, state, mode);
				registerProvider(pi, state, mode);
			},
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		model: MODEL,
		tools: ["read"],
		thinkingLevel: "off",
		resourceLoader: loader,
		sessionManager: manager,
		settingsManager: settings,
	});
	try {
		await session.bindExtensions({});
		await session.prompt("fixture request");
		if (mode === "replace") {
			// Manual compaction keeps this turn and summarizes the first one.
			const keptRepeats = 100;
			await session.prompt("another fixture request ".repeat(keptRepeats));
			await session.compact();
			await session.prompt("final fixture request");
		}
		process.stdout.write(
			JSON.stringify({
				...state,
				limit: MODEL.contextWindow - HEADROOM,
				skill,
			}),
		);
	} finally {
		session.dispose();
	}
}

await run();
