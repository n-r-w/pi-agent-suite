export interface PromptSection {
	readonly id: string;
	readonly title: string;
}

export interface PromptSectionValue {
	readonly sectionId: string;
	readonly value: string;
}

export const PROMPT_SECTIONS: readonly PromptSection[] = [
	{ id: "goal", title: "Goal" },
	{ id: "task", title: "Task" },
	{ id: "context", title: "Context" },
	{ id: "criteria", title: "Criteria" },
	{ id: "constraints", title: "Constraints" },
	{ id: "work-order", title: "Work order" },
];

/** Builds the final user message from configured sections and non-empty user values. */
export function formatStructuredPrompt(
	sections: readonly PromptSection[],
	values: readonly PromptSectionValue[],
): string {
	const valuesBySection = new Map(
		values.map((value) => [value.sectionId, value.value.trim()]),
	);
	const blocks = sections.flatMap((section) => {
		const value = valuesBySection.get(section.id);
		if (value === undefined || value.length === 0) {
			return [];
		}

		return [`## ${section.title}\n${value}`];
	});

	return blocks.join("\n\n");
}
