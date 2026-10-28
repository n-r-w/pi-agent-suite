import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	getCurrentSystemMessage,
	getSystemMessageText,
} from "@earendil-works/pi-ai";
import {
	type BeforeAgentStartEvent,
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	getPromptComposition,
	markPromptCompositionStale,
} from "./prompt-composition.ts";

/** Creates an isolated extension runtime with observable hook registration. */
function createPi() {
	const handlers = new Map<
		string,
		((event: { messages: AgentMessage[] }) => unknown)[]
	>();
	const pi = {
		events: createEventBus(),
		on(
			name: string,
			handler: (event: { messages: AgentMessage[] }) => unknown,
		) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

test("shares one outgoing presentation hook across extension APIs", () => {
	const { pi, handlers } = createPi();
	const other = { ...pi } as ExtensionAPI;
	expect(getPromptComposition(other)).toBe(getPromptComposition(pi));
	expect(handlers.get("context_with_system")).toHaveLength(1);
});

test("publishes native sections without forcing a complete prompt", () => {
	const { pi } = createPi();
	const event = {
		systemPrompt: "base",
		systemPromptOptions: { sections: {} },
	} as BeforeAgentStartEvent;
	const composition = getPromptComposition(pi);
	const result = composition.publish(event, "rendered");
	expect(result).toBeUndefined();
	expect(Object.keys(event.systemPromptOptions.sections)).toHaveLength(1);
	expect(event.systemPromptOptions.forceSystemPrompt).toBeUndefined();
});

test("keeps historical positions and tool declarations when prompt state changes", () => {
	const { pi } = createPi();
	const composition = getPromptComposition(pi);
	const event = {
		systemPrompt: "base",
		systemPromptOptions: { sections: {} },
	} as BeforeAgentStartEvent;
	composition.publish(event, "first");
	const [name] = Object.keys(event.systemPromptOptions.sections);
	if (!name) {
		throw new Error("Missing native section");
	}
	const first: AgentMessage = {
		role: "system",
		content: "",
		sections: { automatic: "native", [name]: `<${name}>\n\nfirst\n</${name}>` },
		timestamp: 1,
	};
	const user: AgentMessage = { role: "user", content: "request", timestamp: 2 };
	const update: AgentMessage = {
		role: "system",
		content: "",
		sections: { [name]: `<${name}>\n\nsecond\n</${name}>` },
		toolsAdded: [
			{
				name: "read",
				description: "Read",
				parameters: { type: "object", properties: {} },
			},
		],
		timestamp: 3,
	};
	const before = composition.present([first, user]);
	const after = composition.present([first, user, update]);
	expect(after.slice(0, before.length)).toEqual(before);
	expect(after[1]).toBe(user);
	expect(after[2]?.role).toBe("system");
	expect(
		after[2] && "toolsAdded" in after[2] ? after[2].toolsAdded : undefined,
	).toBe(update.toolsAdded);
	const initial = after[0];
	expect(
		initial?.role === "system" ? Object.keys(initial.sections ?? {}) : [],
	).toEqual([name]);
});

test("leaves native prompt presentation unchanged when no contributor replaces it", () => {
	const { pi } = createPi();
	const messages: AgentMessage[] = [
		{ role: "system", content: "native", timestamp: 1 },
		{ role: "user", content: "request", timestamp: 2 },
	];
	expect(getPromptComposition(pi).present(messages)).toEqual(messages);
});

test("restores native sections when the recorded package section is removed", () => {
	const { pi } = createPi();
	const composition = getPromptComposition(pi);
	const event = {
		systemPrompt: "base",
		systemPromptOptions: { sections: {} },
	} as BeforeAgentStartEvent;
	composition.publish(event, "rendering");
	const sections = Object.fromEntries(
		Object.entries(event.systemPromptOptions.sections).map(([name, value]) => [
			name,
			`<${name}>\n${value}\n</${name}>`,
		]),
	);
	const name = Object.keys(sections)[0];
	if (!name) {
		throw new Error("Missing native section");
	}
	const messages: AgentMessage[] = [
		{
			role: "system",
			content: "",
			sections: { automatic: "native", ...sections },
			timestamp: 1,
		},
		{ role: "system", content: "", sections: { [name]: null }, timestamp: 2 },
	];
	const current = getCurrentSystemMessage(composition.present(messages));
	expect(Object.keys(current?.sections ?? {})).toEqual(["automatic"]);
});

test("retains an empty rendering through native storage and effective-prompt accounting", () => {
	const { pi } = createPi();
	const composition = getPromptComposition(pi);
	const event = {
		systemPrompt: "base",
		systemPromptOptions: { sections: {} },
	} as BeforeAgentStartEvent;
	composition.publish(event, "");
	const sections = Object.fromEntries(
		Object.entries(event.systemPromptOptions.sections)
			.filter(([, value]) => Boolean(value))
			.map(([name, value]) => [name, `<${name}>\n${value}\n</${name}>`]),
	);
	const native = {
		role: "system" as const,
		content: "",
		sections: { automatic: "native", ...sections },
		timestamp: 1,
	};
	const projected = getCurrentSystemMessage(composition.present([native]));
	expect(Object.keys(projected?.sections ?? {})).toEqual(
		Object.keys(event.systemPromptOptions.sections),
	);
	const ctx = {
		getSystemPrompt: () => getSystemMessageText(native),
		sessionManager: { buildSessionProjection: () => ({ messages: [native] }) },
	} as unknown as Parameters<typeof composition.getEffectivePrompt>[0];
	expect(composition.getEffectivePrompt(ctx)).toBe(composition.read(event));
});

test("uses native section identity when prompt text includes a storage-tag example", () => {
	const { pi } = createPi();
	const composition = getPromptComposition(pi);
	const prompt = "Example: <agent_suite>\n\nexample\n</agent_suite>";
	const ctx = {
		getSystemPrompt: () => prompt,
		sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
	} as unknown as Parameters<typeof composition.getEffectivePrompt>[0];
	expect(composition.getEffectivePrompt(ctx)).toBe(prompt);
});

test("retires independently loaded composition on session shutdown", () => {
	const first = createPi();
	const second = createPi();
	second.pi.events = first.pi.events;
	const old = getPromptComposition(first.pi);
	first.handlers.get("session_shutdown")?.[0]?.({ messages: [] });
	expect(getPromptComposition(second.pi)).not.toBe(old);
});

test("installs a fresh presentation hook after extension-runtime replacement", () => {
	const first = createPi();
	const second = createPi();
	second.pi.events = first.pi.events;
	const old = getPromptComposition(first.pi);
	markPromptCompositionStale({ ...first.pi } as ExtensionAPI);
	expect(getPromptComposition(second.pi)).not.toBe(old);
	expect(second.handlers.get("context_with_system")).toHaveLength(1);
});
