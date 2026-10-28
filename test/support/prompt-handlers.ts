import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

/** Adapts legacy extension fakes to the native mutable-section handler contract. */
export function adaptPromptHandler(name: string, handler: unknown): unknown {
	return name === "before_agent_start" && typeof handler === "function"
		? (event: unknown, ctx: unknown) =>
				runPromptHandlers(
					[handler as (event: unknown, ctx: unknown) => unknown],
					event,
					ctx,
				)
		: handler;
}

/** Runs prompt contributors with native mutable sections and chained effective text. */
export async function runPromptHandlers<C>(
	handlers: readonly ((event: unknown, ctx: C) => unknown)[],
	input: unknown,
	ctx: C,
): Promise<{ systemPrompt: string } | undefined> {
	const event = input as BeforeAgentStartEvent;
	const options =
		event.systemPromptOptions ??
		({} as BeforeAgentStartEvent["systemPromptOptions"]);
	options.sections ??= {};
	let prompt = event.systemPrompt;
	let changed = false;
	await handlers.reduce(async (previous, handler) => {
		await previous;
		const result = (await handler(
			{ ...event, systemPrompt: prompt, systemPromptOptions: options },
			ctx,
		)) as { systemPrompt?: string } | undefined;
		if (result?.systemPrompt !== undefined) {
			prompt = result.systemPrompt;
			changed = true;
		} else if (options.sections["agent_suite"] !== undefined) {
			prompt = options.sections["agent_suite"].slice(1);
			changed = true;
		}
	}, Promise.resolve());
	return changed ? { systemPrompt: prompt } : undefined;
}
