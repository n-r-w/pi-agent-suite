import { uuidv7 } from "@earendil-works/pi-agent-core";

/** Creates a Pi-compatible UUIDv7 for one logical auxiliary LLM request. */
export function createAuxiliaryLlmSessionId(): string {
	return uuidv7();
}
