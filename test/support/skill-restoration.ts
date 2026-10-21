import { RESTORATION_TYPE } from "../../pi-package/extensions/skill-restoration/restoration";
import {
	messageMetadata,
	RestorationHarness,
} from "./skill-restoration-harness";
import { runRequestScenario } from "./skill-restoration-requests";

/** Supplies the pre-compaction token estimate in fake completion events. */
const TOKENS_BEFORE = 5000;

/** Captures repeat-compaction outcomes with an older completion-event entry. */
async function repeat(
	harness: RestorationHarness,
	first: string,
	firstRecord: unknown,
): Promise<unknown> {
	const next = harness.session.appendCompaction(
		"identical",
		null,
		TOKENS_BEFORE,
	);
	await harness.emit("session_compact", {
		compactionEntry: harness.session.getEntry(first),
		fromExtension: false,
	});
	return { firstRecord, latest: harness.getRecords().at(-1)?.data, next };
}

/** Captures branch-associated records after reopening and tree navigation. */
async function replay(
	harness: RestorationHarness,
	first: string,
	firstRecord: unknown,
): Promise<unknown> {
	const firstLeaf = harness.session.getLeafId();
	if (!firstLeaf) {
		throw new Error("fixture has no leaf");
	}
	harness.reopen();
	await harness.emit("session_start");
	const other = harness.session.appendCompaction("identical", null, 10);
	await harness.emit("session_compact", {
		compactionEntry: harness.session.getEntry(first),
		fromExtension: false,
	});
	harness.session.branch(firstLeaf);
	await harness.emit("session_tree");
	const messages = await harness.prepareContext();
	return {
		first,
		other,
		firstRecord,
		record: harness.getRecords().at(-1)?.data,
		replay: messages.flatMap((message) =>
			message.role === "custom" ? [message.details] : [],
		),
	};
}

/** Keeps the same components mounted while request metadata changes. */
async function renderLive(harness: RestorationHarness): Promise<unknown> {
	const entry = harness.getRecords()[0];
	if (!entry || !harness.renderer) {
		throw new Error("fixture has no rendered record");
	}
	const width = 100;
	const theme = { fg: (_color: string, text: string) => text };
	const compact = harness.renderer(entry, { expanded: false }, theme);
	const expanded = harness.renderer(entry, { expanded: true }, theme);
	const beforeLines = compact.render(width);
	await harness.prepareContext();
	const preparedLines = compact.render(width);
	const preparedPaths = expanded.render(width);
	Object.assign(harness.ctx.model ?? {}, { contextWindow: 1 });
	await harness.prepareContext();
	const absentLines = compact.render(width);
	const absentPaths = expanded.render(width);
	await harness.emit("session_tree");
	return {
		beforeLines,
		preparedLines,
		preparedPaths,
		absentLines,
		absentPaths,
		resetLines: compact.render(width),
		resetPaths: expanded.render(width),
		skill: harness.skill,
		asset: harness.asset,
	};
}

/** Runs one behavior scenario inside child-local temporary state. */
async function run(): Promise<unknown> {
	const root = process.argv[2];
	const scenario = process.argv[3];
	if (!root || !scenario) {
		throw new Error("fixture root and scenario are required");
	}
	const harness = new RestorationHarness(root, scenario);
	await harness.emit("session_start");
	const first = harness.session.appendCompaction(
		"identical",
		harness.kept,
		TOKENS_BEFORE,
	);
	await harness.emit("session_compact", {
		compactionEntry: harness.session.getEntry(first),
		fromExtension: scenario === "custom",
	});
	const saved = harness.getRecords();
	const firstRecord = saved[0]?.data;
	if (["changes", "budgets", "interleaved"].includes(scenario)) {
		return runRequestScenario(harness, scenario);
	}
	const width = 100;
	const theme = { fg: (_color: string, text: string) => text };
	const entry = saved[0];
	if (scenario === "renderer-live") {
		return renderLive(harness);
	}
	const beforeLines = entry
		? harness.renderer?.(entry, { expanded: false }, theme).render(width)
		: [];
	const initial = await harness.prepareContext();
	const repeated = await harness.prepareContext(initial);
	if (scenario === "repeat") {
		return repeat(harness, first, firstRecord);
	}
	if (scenario === "replay") {
		return replay(harness, first, firstRecord);
	}
	if (scenario === "malformed") {
		harness.session.appendCustomEntry(RESTORATION_TYPE, {
			compactionId: first,
			files: "bad",
		});
		return {
			inserted: (await harness.prepareContext()).filter(
				(message) => message.role === "custom",
			).length,
		};
	}
	return {
		beforeLines,
		records: saved.length,
		warnings: harness.warnings.length,
		firstRecord,
		roles: initial.map((message) => message.role),
		stable:
			JSON.stringify(messageMetadata(initial)) ===
			JSON.stringify(messageMetadata(repeated)),
		compactLines: entry
			? harness.renderer?.(entry, { expanded: false }, theme).render(width)
			: [],
		expandedLines: entry
			? harness.renderer?.(entry, { expanded: true }, theme).render(width)
			: [],
		skill: harness.skill,
		asset: harness.asset,
	};
}

process.stdout.write(JSON.stringify(await run()));
