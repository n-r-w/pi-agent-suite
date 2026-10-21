import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import skillRestoration from "../../pi-package/extensions/skill-restoration/index";
import { RESTORATION_TYPE } from "../../pi-package/extensions/skill-restoration/restoration";
import { buildActiveToolDefinitions } from "../../pi-package/shared/active-tool-definitions";
import { createPersistedSession } from "./persisted-session";
import { createSkillAssistant } from "./skill-restoration-fixtures";

/** Supplies ample room for the default restoration fixture. */
const CONTEXT_WINDOW = 10000;

/** Captures entry rendering independently of model-message text. */
type Renderer = (
	entry: unknown,
	options: unknown,
	theme: unknown,
) => { render(width: number): string[] };

/** Provides isolated branch state and callable extension lifecycle hooks. */
export class RestorationHarness {
	/** Retains the selected session for branch and reopen scenarios. */
	session: SessionManager;
	/** Identifies the skill file declared in the command catalog. */
	readonly skill: string;
	/** Supplies a loaded asset under the declared skill directory. */
	readonly asset: string;
	/** Captures once-only invalid-config notifications. */
	readonly warnings: string[] = [];
	/** Captures extension callbacks by lifecycle event. */
	readonly handlers = new Map<
		string,
		(event: unknown, ctx: ExtensionContext) => unknown
	>();
	/** Captures the custom-entry renderer. */
	renderer: Renderer | undefined;
	/** Supplies fake Pi session context backed by real session storage. */
	readonly ctx: ExtensionContext;
	/** Supplies the extension API boundary. */
	readonly pi: ExtensionAPI;
	/** Identifies the first retained user entry. */
	readonly kept: string;

	/** Creates isolated settings, skill files and successful read history. */
	constructor(root: string, scenario: string) {
		const configDir = join(root, "suite", "skill-restoration");
		const skillDir = join(root, "skills", "sample");
		for (const dir of [configDir, skillDir, join(root, "agent")]) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(
			join(root, "agent", "settings.json"),
			JSON.stringify({
				compaction: {
					enabled: true,
					reserveTokens: 100,
					keepRecentTokens: 100,
				},
			}),
		);
		if (scenario === "invalid") {
			writeFileSync(join(configDir, "config.json"), '{"unknown":true}');
		}
		if (scenario === "disabled") {
			writeFileSync(join(configDir, "config.json"), '{"enabled":false}');
		}
		this.skill = join(skillDir, "SKILL.md");
		this.asset = join(skillDir, "asset.md");
		writeFileSync(this.skill, "fixture skill data");
		writeFileSync(this.asset, "fixture asset data");
		this.session = createPersistedSession(root);
		this.kept = this.seedHistory();
		const contextWindow = scenario === "repeat" ? 1 : CONTEXT_WINDOW;
		this.ctx = {
			cwd: root,
			model: { provider: "fake", id: "fake", contextWindow },
			sessionManager: this.session,
			getSystemPrompt: () => "system fixture",
			ui: { notify: (message: string) => this.warnings.push(message) },
		} as unknown as ExtensionContext;
		this.pi = this.createAPI();
		skillRestoration(this.pi);
	}

	/** Seeds a successful asset read followed by a skill command and retained turn. */
	private seedHistory(): string {
		this.session.appendMessage(
			createSkillAssistant([
				{
					type: "toolCall",
					id: "load",
					name: "read",
					arguments: { path: this.asset },
				},
			]),
		);
		this.session.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: "load",
			content: [{ type: "text", text: "previous data" }],
			isError: false,
			timestamp: 2,
		});
		this.session.appendMessage({
			role: "user",
			content: `<skill name="sample" location="${this.skill}">fixture command</skill>`,
			timestamp: 3,
		});
		return this.session.appendMessage({
			role: "user",
			content: "retained fixture",
			timestamp: 4,
		});
	}

	/** Connects callbacks, commands, active tools and append-only storage. */
	private createAPI(): ExtensionAPI {
		return {
			on: (
				event: string,
				handler: (event: unknown, ctx: ExtensionContext) => unknown,
			) => this.handlers.set(event, handler),
			registerEntryRenderer: (_type: string, renderer: Renderer) => {
				this.renderer = renderer;
			},
			getCommands: () => [
				{ name: "sample", source: "skill", sourceInfo: { path: this.skill } },
			],
			getActiveTools: () => ["read"],
			getAllTools: () => [
				{
					name: "read",
					description: "fixture",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
					},
				},
			],
			appendEntry: (type: string, data: unknown) =>
				this.session.appendCustomEntry(type, data),
		} as unknown as ExtensionAPI;
	}

	/** Emits one registered lifecycle event. */
	async emit(event: string, data: unknown = {}): Promise<unknown> {
		return this.handlers.get(event)?.(data, this.ctx);
	}

	/** Rebuilds the request and applies the restoration handler. */
	async prepareContext(
		messages = this.session.buildSessionContext().messages,
	): Promise<AgentMessage[]> {
		this.session.appendMessage({
			role: "system",
			content: "",
			sections: { runtime: this.ctx.getSystemPrompt() },
			toolsAdded: buildActiveToolDefinitions(this.pi),
			timestamp: 1,
		});
		const visible = messages.filter((message) => message.role !== "system");
		const result = (await this.emit("context", { messages: visible })) as
			| { messages: AgentMessage[] }
			| undefined;
		return result?.messages ?? visible;
	}

	/** Returns branch-local restoration records. */
	getRecords(): Extract<SessionEntry, { type: "custom" }>[] {
		return this.session
			.getBranch()
			.filter(
				(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
					entry.type === "custom" && entry.customType === RESTORATION_TYPE,
			);
	}

	/** Reopens persisted state with a fresh extension instance. */
	reopen(): void {
		const path = this.session.getSessionFile();
		if (!path) {
			throw new Error("fixture session was not persisted");
		}
		this.session = SessionManager.open(path);
		Object.assign(this.ctx, { sessionManager: this.session });
		skillRestoration(this.pi);
	}
}

/** Projects stable structured message metadata without exposing prompt text to assertions. */
export function messageMetadata(messages: AgentMessage[]): unknown[] {
	return messages.map((message) =>
		message.role === "custom"
			? {
					role: message.role,
					details: message.details,
					timestamp: message.timestamp,
				}
			: { role: message.role },
	);
}
