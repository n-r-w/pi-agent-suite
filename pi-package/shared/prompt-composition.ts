import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Native storage section for the completed package-rendered prompt. */
const PACKAGE_SECTION = "agent_suite";
/** Cross-extension lookup channel for independently loaded module instances. */
const REQUEST_CHANNEL = "pi-harness:prompt-composition:request";
/** Shared boundary and its extension-runtime lifecycle state. */
interface CompositionHolder {
	composition: PromptComposition;
	stale: boolean;
}
/** Per-extension cache of the shared presentation boundary. */
const compositions = new WeakMap<ExtensionAPI, CompositionHolder>();

/** Composes rendered package instructions while retaining native history positions. */
export class PromptComposition {
	/** Installs one outgoing presentation hook for this runtime. */
	public constructor(pi: ExtensionAPI) {
		pi.on("context_with_system", (event) => ({
			messages: this.present(event.messages),
		}));
		pi.on("session_shutdown", () => markPromptCompositionStale(pi));
	}

	/** Returns the completed text from earlier contributors in this handler chain. */
	public read(event: BeforeAgentStartEvent): string {
		const stored = event.systemPromptOptions.sections[PACKAGE_SECTION];
		return stored === undefined ? event.systemPrompt : stored.slice(1);
	}

	/** Records a contributor's completed rendering without enabling forced projection. */
	public publish(event: BeforeAgentStartEvent, prompt: string): void {
		// Pi omits empty custom sections, so a storage newline also represents an empty rendering.
		event.systemPromptOptions.sections[PACKAGE_SECTION] = `\n${prompt}`;
	}

	/** Returns the effective rendered prompt used for request-budget estimates. */
	public getEffectivePrompt(ctx: ExtensionContext): string {
		const current = getCurrentSystemMessage(
			ctx.sessionManager.buildSessionProjection().messages,
		);
		const stored = current?.sections?.[PACKAGE_SECTION];
		return typeof stored === "string"
			? unwrapPromptSection(stored)
			: ctx.getSystemPrompt();
	}

	/** Projects recorded prompt changes at their original positions and retains tool deltas. */
	public present(messages: AgentMessage[]): AgentMessage[] {
		const nativeSections: Record<string, string> = {};
		let previous: Record<string, string> = {};
		return messages.map((message) => {
			if (message.role !== "system") {
				return message;
			}
			for (const [name, value] of Object.entries(message.sections ?? {})) {
				if (value === null) {
					delete nativeSections[name];
				} else {
					nativeSections[name] = value;
				}
			}
			const stored = nativeSections[PACKAGE_SECTION];
			const effective =
				stored === undefined
					? { ...nativeSections }
					: {
							[PACKAGE_SECTION]: unwrapPromptSection(stored),
						};
			if (stored === undefined && !(PACKAGE_SECTION in previous)) {
				previous = effective;
				return message;
			}
			const sections = diffPresentedSections(previous, effective);
			previous = effective;
			return {
				...message,
				content: stored === undefined ? message.content : "",
				sections,
			};
		});
	}
}

/** Removes pi's section wrapper and the package's empty-rendering storage newline. */
function unwrapPromptSection(stored: string): string {
	return stored.slice(
		`<${PACKAGE_SECTION}>\n\n`.length,
		-`\n</${PACKAGE_SECTION}>`.length,
	);
}

/** Computes replacements and removals between consecutive effective prompt states. */
function diffPresentedSections(
	previous: Record<string, string>,
	current: Record<string, string>,
): Record<string, string | null> {
	const sections: Record<string, string | null> = {};
	for (const name of Object.keys(previous)) {
		if (!(name in current)) {
			sections[name] = null;
		}
	}
	for (const [name, value] of Object.entries(current)) {
		if (previous[name] !== value) {
			sections[name] = value;
		}
	}
	return sections;
}

/** Acquires the shared boundary through pi's synchronous cross-extension event bus. */
export function getPromptComposition(pi: ExtensionAPI): PromptComposition {
	const cached = compositions.get(pi);
	if (cached && !cached.stale) {
		return cached.composition;
	}
	const slot: { holder?: CompositionHolder } = {};
	pi.events?.emit(REQUEST_CHANNEL, slot);
	const holder =
		slot.holder && !slot.holder.stale
			? slot.holder
			: {
					composition: new PromptComposition(pi),
					stale: false,
				};
	if (holder !== slot.holder) {
		pi.events?.on(REQUEST_CHANNEL, (data: unknown) => {
			(data as typeof slot).holder = holder;
		});
	}
	compositions.set(pi, holder);
	return holder.composition;
}

/** Retires the outgoing hook when pi replaces the extension runtime. */
export function markPromptCompositionStale(pi: ExtensionAPI): void {
	const slot: { holder: CompositionHolder | undefined } = {
		holder: compositions.get(pi),
	};
	pi.events?.emit(REQUEST_CHANNEL, slot);
	if (slot.holder) {
		slot.holder.stale = true;
	}
}
