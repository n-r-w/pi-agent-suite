import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	SessionEntry,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";

export interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

export interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly tools: ToolDefinition[];
}

export interface CompletionCall {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions | undefined;
}

export interface ContextFakeOptions {
	readonly authResult?: Awaited<
		ReturnType<ContextFake["modelRegistry"]["getApiKeyAndHeaders"]>
	>;
}

export interface ContextFake {
	readonly cwd: string;
	readonly hasUI?: boolean;
	readonly model: Model<Api> | undefined;
	readonly modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| {
					readonly ok: true;
					readonly apiKey?: string;
					readonly headers?: Record<string, string>;
			  }
			| { readonly ok: false; readonly error: string }
		>;
	};
	readonly sessionManager: {
		getEntries(): unknown[];
		getBranch(): SessionEntry[];
		getLeafId(): string | null;
	};
	readonly ui: {
		notify(message: string, type?: string): void;
	};
}

/** Creates the ExtensionAPI fake used by council registration and composition tests. */
export function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const tools: ToolDefinition[] = [];
	let activeTools: string[] = [];

	const unsupported = (methodName: string): never => {
		throw new Error(`ExtensionAPI fake does not support ${methodName}`);
	};

	return {
		handlers,
		tools,
		events: {
			emit(): void {
				unsupported("events.emit");
			},
			on(): () => void {
				return unsupported("events.on");
			},
		},
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
		registerCommand(): void {
			unsupported("registerCommand");
		},
		registerShortcut(): void {
			unsupported("registerShortcut");
		},
		appendEntry(): void {
			unsupported("appendEntry");
		},
		getAllTools(): ToolDefinition[] {
			return [...tools];
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(toolNames: string[]): void {
			activeTools = [...toolNames];
		},
		getCommands(): never[] {
			return unsupported("getCommands");
		},
		getThinkingLevel(): string {
			return "medium";
		},
		setThinkingLevel(): void {
			unsupported("setThinkingLevel");
		},
		async setModel(): Promise<boolean> {
			return unsupported("setModel");
		},
		setLabel(): void {
			unsupported("setLabel");
		},
		modelRegistry: undefined,
	} as unknown as ExtensionApiFake;
}

/** Creates a fake extension execution context with model registry and branch state. */
export function createContext(
	models: readonly Model<Api>[],
	entries: readonly SessionEntry[] = [],
	options: ContextFakeOptions = {},
): ContextFake & {
	readonly notifications: Array<{
		readonly message: string;
		readonly type: string | undefined;
	}>;
} {
	const notifications: Array<{
		readonly message: string;
		readonly type: string | undefined;
	}> = [];
	return {
		cwd: "/tmp/project",
		notifications,
		model: models[0],
		modelRegistry: createModelRegistry(models, options.authResult),
		sessionManager: createSessionManager(entries),
		ui: { notify: (message, type) => notifications.push({ message, type }) },
	};
}

/** Creates a queued fake for participant and final-answer model responses. */
export function createCompletionQueue(
	responses: Array<AssistantMessage["content"] | Error>,
): {
	readonly calls: CompletionCall[];
	readonly completeSimple: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
} {
	const calls: CompletionCall[] = [];
	return {
		calls,
		async completeSimple(
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		): Promise<AssistantMessage> {
			calls.push({ model, context, options });
			const next = responses.shift();
			if (next === undefined) {
				throw new Error("missing queued completion response");
			}
			if (next instanceof Error) {
				throw next;
			}
			return createAssistantMessage(model, next);
		},
	};
}

/** Creates a fake model registry for participant model resolution. */
function createModelRegistry(
	models: readonly Model<Api>[],
	authResult: ContextFakeOptions["authResult"],
): ContextFake["modelRegistry"] {
	return {
		find(provider: string, modelId: string): Model<Api> | undefined {
			return models.find(
				(model) => model.provider === provider && model.id === modelId,
			);
		},
		async getApiKeyAndHeaders() {
			return (
				authResult ?? {
					ok: true,
					apiKey: "council-api-key",
					headers: { "x-council": "enabled" },
				}
			);
		},
	};
}

/** Creates the session-manager subset used by the extension. */
function createSessionManager(
	entries: readonly SessionEntry[],
): ContextFake["sessionManager"] {
	return {
		getEntries(): unknown[] {
			return [...entries];
		},
		getBranch(): SessionEntry[] {
			return [...entries];
		},
		getLeafId(): string | null {
			return entries.at(-1)?.id ?? null;
		},
	};
}

/** Creates one assistant message returned by the fake model. */
function createAssistantMessage(
	model: Model<Api>,
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}
