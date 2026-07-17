/** Finite renderer and process failures accepted at runtime. */
export const MERMAID_DIAGNOSTIC_CODES = [
	"invalid_syntax",
	"output_limit_exceeded",
	"render_timeout",
	"render_memory_limit",
	"render_process_failed",
	"invalid_worker_response",
	"render_failed",
] as const;
export type MermaidDiagnosticCode = (typeof MERMAID_DIAGNOSTIC_CODES)[number];

/** Top-level Mermaid tokens accepted by beautiful-mermaid 1.1.3. */
export const MERMAID_DIAGRAM_TYPES = [
	"graph",
	"flowchart",
	"stateDiagram",
	"stateDiagram-v2",
	"sequenceDiagram",
	"classDiagram",
	"erDiagram",
	"xychart",
	"xychart-beta",
] as const;
export type MermaidDiagramType = (typeof MERMAID_DIAGRAM_TYPES)[number];

export interface MermaidSourceBlock {
	diagramType: MermaidDiagramType;
	source: string;
	sourceHash: string;
}

export type MermaidExtractionResult =
	| { status: "accepted"; block: MermaidSourceBlock }
	| { status: "failed"; explanation: string };

/** Known renderer defects accepted at runtime and in persisted warning entries. */
export const MERMAID_COMPATIBILITY_WARNING_CODES = [
	"circle_edge_omission",
	"cross_edge_omission",
	"early_sequence_note_omission",
	"subgraph_endpoint_phantom_node",
	"literal_html_tag",
	"wide_character_alignment",
] as const;
export type MermaidCompatibilityWarningCode =
	(typeof MERMAID_COMPATIBILITY_WARNING_CODES)[number];

/** Structural defect codes produced only through the pinned parser boundary. */
export const MERMAID_STRUCTURAL_WARNING_CODES = [
	"circle_edge_omission",
	"cross_edge_omission",
	"subgraph_endpoint_phantom_node",
] as const satisfies readonly MermaidCompatibilityWarningCode[];
export type MermaidStructuralWarningCode =
	(typeof MERMAID_STRUCTURAL_WARNING_CODES)[number];

export interface MermaidCompatibilityWarning {
	code: MermaidCompatibilityWarningCode;
	explanation: string;
}

export interface MermaidAsciiVariant {
	maxLineWidth: number;
	text: string;
}

export interface MermaidAsciiVariants {
	default: MermaidAsciiVariant;
	tight: MermaidAsciiVariant;
}

export type MermaidBlockRenderResult =
	| {
			status: "rendered";
			compatibilityWarnings: MermaidStructuralWarningCode[];
			sourceHash: string;
			variants: MermaidAsciiVariants;
	  }
	| {
			status: "failed";
			sourceHash: string;
			diagnosticCode: MermaidDiagnosticCode;
			explanation: string;
	  };

export type MermaidRenderOperationResult =
	| { status: "completed"; results: MermaidBlockRenderResult[] }
	| { status: "aborted" };

export type MermaidRenderEntry =
	| {
			status: "rendered";
			variants: MermaidAsciiVariants;
	  }
	| {
			status: "warning";
			variants: MermaidAsciiVariants;
			warnings: MermaidCompatibilityWarning[];
	  }
	| {
			status: "failed";
			explanation: string;
	  };
