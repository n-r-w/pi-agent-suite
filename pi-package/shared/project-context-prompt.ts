/** Pi-loaded project context file that should be visible in model system prompts. */
export interface ProjectContextFile {
	/** Source path reported by Pi for the context file. */
	readonly path: string;
	/** Full text loaded from the context file. */
	readonly content: string;
}

/** Appends Pi-loaded project context files to an extension-owned system prompt. */
export function appendProjectContext(
	systemPrompt: string,
	contextFiles: readonly ProjectContextFile[],
): string {
	if (contextFiles.length === 0) {
		return systemPrompt;
	}

	const projectContext = contextFiles
		.map(({ path, content }) => `## ${path}\n\n${content}`)
		.join("\n\n");
	return `${systemPrompt}\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n${projectContext}`;
}
