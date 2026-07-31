import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { projectWorkflowContext } from "./context";
import {
	activateWorkflow,
	transitionWorkflow,
	validateWorkflowDefinition,
} from "./workflow";

const prompts = {
	extensionDescription: "Use <stages> & choose safely.",
	activateDescription: "activate",
	transitionDescription: "transition",
};

/** Creates a graph whose text and identifiers prove XML text and attribute escaping. */
function workflow(
	id = "delivery",
): ReturnType<typeof validateWorkflowDefinition> {
	return validateWorkflowDefinition(
		id,
		{
			description: "Build & review",
			stages: [
				{ id: "start", description: 'Start "now"', initial: true },
				{ id: "done", description: "Done", final: true },
			],
			transitions: [
				{ from: "start", to: "done", type: "advance" },
				{ from: "done", to: "start", type: "rework" },
			],
		},
		"fixture.yaml",
	);
}

/** Reads content only from the custom message produced by the projection boundary. */
function customContent(message: AgentMessage | undefined): string {
	if (message?.role !== "custom") {
		throw new Error("expected a custom workflow message");
	}
	return String(message.content);
}

describe("workflow context projection", () => {
	/** Proves prior chained messages are preserved and exactly one hidden transient message is appended. */
	test("projects activation options before activation", () => {
		const prior = [
			{ role: "user", content: "keep me", timestamp: 1 },
		] as AgentMessage[];
		const projected = projectWorkflowContext(
			prior,
			prompts,
			[workflow()],
			undefined,
		);
		expect(projected).toHaveLength(2);
		expect(projected[0]).toBe(prior[0]);
		expect(projected[1]).toMatchObject({
			role: "custom",
			customType: "workflow",
			display: false,
		});
		const content = customContent(projected[1]);
		expect(content).toContain("Use &lt;stages&gt; &amp; choose safely.");
		expect(content).toContain(
			'<workflow id="delivery" description="Build &amp; review" />',
		);
		expect(content).not.toContain("<active_workflow");
	});

	/** Proves saved-state status, availability, conditional flags, and active-catalog exclusion. */
	test("projects one active snapshot without exposing its route", () => {
		const activeWorkflow = workflow();
		const state = transitionWorkflow(activateWorkflow(activeWorkflow), "done");
		const other = workflow("other");
		const projected = projectWorkflowContext(
			[],
			prompts,
			[activeWorkflow, other],
			state,
		);
		const content = customContent(projected[0]);
		expect(content).toContain(
			'<workflow id="other" description="Build &amp; review" />',
		);
		expect(content).not.toContain('<workflow id="delivery" description=');
		expect(content).toContain(
			'<active_workflow id="delivery" active_stage_id="done">',
		);
		expect(content).toContain(
			'id="start" description="Start &quot;now&quot;" status="completed" initial="true"',
		);
		expect(content).toContain(
			'id="done" description="Done" status="in_progress" final="true"',
		);
		expect(content).toContain('<transition to="start" type="rework" />');
		expect(content).not.toContain("<route");
	});

	/** Proves a saved snapshot remains projectable with an explicitly empty current catalog. */
	test("renders self-closing activation options for a saved-only state", () => {
		const state = activateWorkflow(workflow());
		const content = customContent(
			projectWorkflowContext([], prompts, [], state)[0],
		);
		expect(content).toContain("<workflow_activation_options />");
		expect(content).toContain("<active_workflow");
	});
});
