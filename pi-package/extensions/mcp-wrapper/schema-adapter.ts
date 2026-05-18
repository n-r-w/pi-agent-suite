import { type TSchema, Type } from "typebox";

const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} } as const;

export interface SchemaAdapterResult {
	readonly kind: "valid";
	readonly parameters: TSchema;
}

/** Passes MCP JSON Schema through to Pi tool registration. */
export function adaptMcpInputSchema(schema: unknown): SchemaAdapterResult {
	const inputSchema = (schema ?? EMPTY_INPUT_SCHEMA) as TSchema;
	return {
		kind: "valid",
		parameters: Type.Unsafe<Record<string, unknown>>(inputSchema),
	};
}
