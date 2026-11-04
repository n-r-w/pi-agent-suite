import { isSingleLineText } from "../../shared/text-contracts";

/** Describes an author-defined workflow classification in presentation order. */
export interface WorkflowKind {
	readonly id: string;
	readonly description: string;
}

/** Validates the closed ordered kinds file at its load boundary. */
export function validateWorkflowKinds(value: unknown): readonly WorkflowKind[] {
	if (!Array.isArray(value)) {
		throw new Error("workflow kinds must be an array");
	}
	const ids = new Set<string>();
	return value.map((entry: unknown) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error("workflow kind must be an object");
		}
		if (
			Object.keys(entry).some((key) => key !== "id" && key !== "description")
		) {
			throw new Error("workflow kind contains an unsupported key");
		}
		const id = readKindText(Reflect.get(entry, "id"), "id").normalize("NFC");
		const description = readKindText(
			Reflect.get(entry, "description"),
			"description",
		);
		if (ids.has(id)) {
			throw new Error(`duplicate workflow kind id ${id}`);
		}
		ids.add(id);
		return { id, description };
	});
}

/** Reads a single-line kind attribute using the workflow text convention. */
function readKindText(value: unknown, name: string): string {
	if (!isSingleLineText(value)) {
		throw new Error(
			`workflow kind ${name} must be non-empty single-line text without surrounding whitespace`,
		);
	}
	return value;
}

/** Enforces catalog membership for new definitions without constraining saved snapshots. */
export function requireKnownWorkflowKind(
	kind: string | undefined,
	kinds: readonly WorkflowKind[],
): void {
	if (kind !== undefined && !kinds.some(({ id }) => id === kind)) {
		throw new Error(`unknown workflow kind ${kind}`);
	}
}
