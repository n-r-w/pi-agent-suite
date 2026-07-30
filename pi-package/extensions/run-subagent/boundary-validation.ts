/** Requires every declared own key and rejects fields outside the closed shape. */
export function hasExactKeys(
	value: unknown,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[] = [],
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
	return (
		requiredKeys.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => allowedKeys.has(key))
	);
}

/** Reads one field without casting unvalidated boundary data. */
export function readField(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? Reflect.get(value, key)
		: undefined;
}

/** Reads one non-empty string field from unvalidated boundary data. */
export function readNonEmptyString(
	value: unknown,
	key: string,
): string | undefined {
	const field = readField(value, key);
	return typeof field === "string" && field.length > 0 ? field : undefined;
}
