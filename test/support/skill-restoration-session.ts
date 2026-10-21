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
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import skillRestoration from "../../pi-package/extensions/skill-restoration/index";
import { RESTORATION_TYPE } from "../../pi-package/extensions/skill-restoration/restoration";
import systemPrompt from "../../pi-package/extensions/system-prompt/index";
import { createPersistedSession } from "./persisted-session";
import { createSkillAssistant } from "./skill-restoration-fixtures";
import {
	RestorationObserver,
	type RestorationSnapshot,
} from "./skill-restoration-observer";

/** Supplies a network-free model for native summaries and subsequent requests. */
const MODEL: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "skill-runtime",
	id: "fake",
	name: "Fake",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Seeds skill ownership and history large enough to require native summarization. */
function seed(
	root: string,
	skill: string,
): { manager: SessionManager; kept: string } {
	const manager = createPersistedSession(root);
	manager.appendMessage({
		role: "user",
		content: `<skill name="sample" location="${skill}">fixture</skill>`,
		timestamp: 2,
	});
	const historicalRepeats = 1000;
	manager.appendMessage(
		createSkillAssistant([
			{ type: "text", text: "historical data ".repeat(historicalRepeats) },
		]),
	);
	const kept = manager.appendMessage({
		role: "user",
		content: "recent fixture",
		timestamp: 4,
	});
	manager.appendMessage(
		createSkillAssistant([{ type: "text", text: "recent reply" }]),
	);
	return { manager, kept };
}

/** Installs fake completions and captures final-provider request estimates. */
function registerRuntime(
	pi: ExtensionAPI,
	requests: RestorationSnapshot[],
	onSummary: () => void,
	model: Model<"openai-completions">,
): void {
	const observer = new RestorationObserver(pi);
	pi.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "fixture",
		models: [model],
		streamSimple: (_model, context) => {
			const snapshot = observer.capture(context);
			if (snapshot) {
				requests.push(snapshot);
			}
			onSummary();
			const stream = createAssistantMessageEventStream();
			const message = createSkillAssistant([
				{ type: "text", text: "fixture summary or response" },
			]);
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		},
	});
}

/** Creates isolated skill files and Pi compaction settings. */
function prepareDisk(root: string): { agentDir: string; skill: string } {
	const agentDir = join(root, "agent");
	const skillDir = join(agentDir, "skills", "sample");
	mkdirSync(skillDir, { recursive: true });
	const skill = join(skillDir, "SKILL.md");
	writeFileSync(
		skill,
		"---\nname: sample\ndescription: Fixture\n---\nSkill fixture data",
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
			retry: { enabled: false },
		}),
	);
	return { agentDir, skill };
}

/** Prepares disk and model inputs for native, custom and package-prompt budget checks. */
function prepareFixture(root: string, mode: string) {
	const { agentDir, skill } = prepareDisk(root);
	const model =
		mode === "prompt-budget" ? { ...MODEL, contextWindow: 50000 } : MODEL;
	if (mode === "prompt-budget") {
		const repeats = 47000;
		writeFileSync(
			skill,
			"---\nname: sample\ndescription: Fixture\n---\n" +
				"data ".repeat(repeats),
		);
	}
	return {
		agentDir,
		skill,
		model,
		settings: SettingsManager.create(root, agentDir),
		...seed(root, skill),
	};
}

/** Collects runtime outcomes without including model-message text. */
function collectOutcome(
	manager: SessionManager,
	requests: RestorationSnapshot[],
	summaries: number,
	skill: string,
) {
	return {
		summaries,
		requests,
		records: manager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "custom" && entry.customType === RESTORATION_TYPE,
			).length,
		skill,
		sessionFile: manager.getSessionFile(),
	};
}

/** Exercises native and extension compaction through real Pi session boundaries. */
async function run(): Promise<void> {
	const root = process.argv[2];
	const mode = process.argv[3];
	if (!root || !mode) {
		throw new Error("fixture root and mode are required");
	}
	const { agentDir, skill, model, settings, manager, kept } = prepareFixture(
		root,
		mode,
	);
	const requests: RestorationSnapshot[] = [];
	let summaryRequests = 0;
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noContextFiles: true,
		extensionFactories: [
			systemPrompt,
			skillRestoration,
			(pi) => {
				registerRuntime(
					pi,
					requests,
					() => {
						summaryRequests += 1;
					},
					model,
				);
				if (mode === "custom" || mode === "prompt-budget") {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "fixture custom summary",
							firstKeptEntryId: kept,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				}
			},
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		model,
		thinkingLevel: "off",
		resourceLoader: loader,
		sessionManager: manager,
		settingsManager: settings,
	});
	try {
		await session.bindExtensions({});
		await session.compact();
		const summaries = summaryRequests;
		await session.prompt("first request");
		await session.prompt("second request");
		process.stdout.write(
			JSON.stringify(collectOutcome(manager, requests, summaries, skill)),
		);
	} finally {
		session.dispose();
	}
}

await run();
