import process from "node:process";

import { parseMermaid, renderMermaidASCII } from "beautiful-mermaid";

import {
	MAX_SOURCE_CHARACTERS,
	MAX_SOURCE_LINES,
	MAX_VARIANT_CHARACTERS,
	MAX_VARIANT_LINES,
} from "./limits.js";

/** Spacious horizontal node separation used by the default preview. */
const DEFAULT_PADDING_X = 5;
/** Reduced horizontal node separation used by the tight preview. */
const TIGHT_PADDING_X = 2;
/** Node border padding shared by both preview variants. */
const BOX_BORDER_PADDING = 1;
/** Parser-related errors that can be safely classified without exposing their message. */
const SYNTAX_ERROR_PATTERN = /(?:parse|syntax|unexpected|invalid)/i;
/** Diagram headers handled by the pinned structural flowchart parser. */
const FLOWCHART_HEADER_PATTERN = /^\s*(?:flowchart|graph)\b/i;

/** Reads one complete request while preserving UTF-8 decoder state across chunks. */
async function readRequestPayload() {
	process.stdin.setEncoding("utf8");
	let payload = "";
	for await (const chunk of process.stdin) {
		payload += chunk;
	}
	return payload;
}

/** Narrows unknown JSON objects before reading named fields. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the worker request independently from parent-process preflight. */
function parseRequest(payload) {
	const parsed = JSON.parse(payload);
	if (
		!isRecord(parsed) ||
		!Array.isArray(parsed.blocks) ||
		parsed.blocks.length === 0
	) {
		throw new Error("worker request has an invalid block collection");
	}
	return {
		blocks: parsed.blocks.map(parseBlock),
	};
}

/** Validates one source block at the process boundary. */
function parseBlock(value) {
	if (
		!isRecord(value) ||
		typeof value.source !== "string" ||
		typeof value.sourceHash !== "string" ||
		value.source.length === 0 ||
		value.source.length > MAX_SOURCE_CHARACTERS ||
		value.source.split("\n").length > MAX_SOURCE_LINES
	) {
		throw new Error("worker request contains an invalid source block");
	}
	return { source: value.source, sourceHash: value.sourceHash };
}

/** Renders one block while keeping renderer exceptions local to that block. */
function renderBlock(block) {
	try {
		const defaultText = renderMermaidASCII(block.source, {
			boxBorderPadding: BOX_BORDER_PADDING,
			colorMode: "none",
			paddingX: DEFAULT_PADDING_X,
		});
		const tightText = renderMermaidASCII(block.source, {
			boxBorderPadding: BOX_BORDER_PADDING,
			colorMode: "none",
			paddingX: TIGHT_PADDING_X,
		});
		if (defaultText.trim().length === 0 || tightText.trim().length === 0) {
			return {
				status: "failed",
				sourceHash: block.sourceHash,
				diagnosticCode: "render_failed",
				explanation: "The renderer produced an empty Mermaid preview.",
			};
		}
		if (variantExceedsLimit(defaultText) || variantExceedsLimit(tightText)) {
			return {
				status: "failed",
				sourceHash: block.sourceHash,
				diagnosticCode: "output_limit_exceeded",
				explanation:
					"The renderer produced a variant larger than the configured limit.",
			};
		}
		return {
			status: "rendered",
			compatibilityWarnings: detectStructuralWarnings(block.source),
			sourceHash: block.sourceHash,
			variants: {
				default: { text: defaultText },
				tight: { text: tightText },
			},
		};
	} catch (error) {
		const syntaxError = isSyntaxError(error);
		return {
			status: "failed",
			sourceHash: block.sourceHash,
			diagnosticCode: syntaxError ? "invalid_syntax" : "render_failed",
			explanation: syntaxError
				? "The renderer rejected the Mermaid syntax."
				: "The renderer could not produce an ASCII preview.",
		};
	}
}

/** Detects structural defects through the parser used by the pinned renderer. */
function detectStructuralWarnings(source) {
	if (!FLOWCHART_HEADER_PATTERN.test(source)) {
		return [];
	}
	const warnings = [];
	if (operatorChangesEdges(source, "--o", "--x")) {
		warnings.push("circle_edge_omission");
	}
	if (operatorChangesEdges(source, "--x", "--o")) {
		warnings.push("cross_edge_omission");
	}
	const graph = parseMermaid(source);
	if (hasSubgraphEndpoint(graph)) {
		warnings.push("subgraph_endpoint_phantom_node");
	}
	return warnings;
}

/** Detects whether normalizing one unsupported ending restores parsed edges. */
function operatorChangesEdges(source, operator, otherOperator) {
	if (!source.includes(operator)) {
		return false;
	}
	const baselineSource = source.replaceAll(otherOperator, "-->");
	const normalizedSource = baselineSource.replaceAll(operator, "-->");
	return (
		parseMermaid(normalizedSource).edges.length >
		parseMermaid(baselineSource).edges.length
	);
}

/** Detects parsed edges that use a declared top-level or nested subgraph ID. */
function hasSubgraphEndpoint(graph) {
	const identifiers = new Set();
	const memberNodeIds = new Set();
	collectSubgraphIdentifiers(graph.subgraphs, identifiers, memberNodeIds);
	const isPhantomIdentifier = (identifier) =>
		identifiers.has(identifier) && !memberNodeIds.has(identifier);
	return (
		[...identifiers].some(
			(identifier) =>
				graph.nodes.has(identifier) && isPhantomIdentifier(identifier),
		) ||
		graph.edges.some(
			(edge) =>
				isPhantomIdentifier(edge.source) || isPhantomIdentifier(edge.target),
		)
	);
}

/** Collects parser-derived subgraph identifiers and intentional member nodes. */
function collectSubgraphIdentifiers(subgraphs, identifiers, memberNodeIds) {
	for (const subgraph of subgraphs) {
		identifiers.add(subgraph.id);
		for (const nodeId of subgraph.nodeIds) {
			memberNodeIds.add(nodeId);
		}
		collectSubgraphIdentifiers(subgraph.children, identifiers, memberNodeIds);
	}
}

/** Enforces worker-side output limits before JSON serialization. */
function variantExceedsLimit(text) {
	return (
		text.length > MAX_VARIANT_CHARACTERS ||
		text.split("\n").length > MAX_VARIANT_LINES
	);
}

/** Classifies parser failures without returning untrusted exception text. */
function isSyntaxError(error) {
	return error instanceof Error && SYNTAX_ERROR_PATTERN.test(error.message);
}

/** Writes exactly one JSON response or a bounded process-level failure. */
async function main() {
	try {
		const request = parseRequest(await readRequestPayload());
		process.stdout.write(
			JSON.stringify({ results: request.blocks.map(renderBlock) }),
		);
	} catch {
		process.stderr.write("Mermaid worker rejected its request.\n");
		process.exitCode = 1;
	}
}

await main();
