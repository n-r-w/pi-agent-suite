/** Converts an unknown V2 failure to the message exposed at its owning boundary. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
