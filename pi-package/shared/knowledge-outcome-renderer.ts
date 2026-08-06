import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Identifies knowledge trigger outcome messages in session history. */
export const KNOWLEDGE_OUTCOME_CUSTOM_TYPE = "knowledge-outcome";

/** Renders the outcome content without the default custom-message type label. */
export const renderKnowledgeOutcome: MessageRenderer<unknown> = (message) =>
	new Text(typeof message.content === "string" ? message.content : "", 0, 0);
