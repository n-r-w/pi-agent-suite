/** Request body of the Responses API, as the OpenAI SDK serializes it. */
export type ResponsesRequestBody = Readonly<Record<string, unknown>>;

/** The last completed response of a connection, which the server keeps in memory for an incremental request. */
export interface ContinuationRecord {
	/** Full body of the request that produced the response. */
	readonly request: ResponsesRequestBody;
	readonly responseId: string;
	/**
	 * Items of the response in the form that pi sends them in the next request. Undefined until the capture
	 * starts; the promise gives undefined when the capture fails.
	 */
	responseItems: Promise<readonly unknown[] | undefined> | undefined;
}

/** Builds the `response.create` message: incremental when `body` continues `record`, otherwise full. */
export async function buildCreateMessage(
	body: ResponsesRequestBody,
	record: ContinuationRecord | undefined,
): Promise<Record<string, unknown>> {
	const { stream: _stream, ...fields } = body;
	const responseItems = await record?.responseItems;
	const delta =
		record === undefined || responseItems === undefined
			? undefined
			: findInputDelta(body, record.request, responseItems);
	if (record === undefined || delta === undefined) {
		return { type: "response.create", ...fields };
	}
	return {
		type: "response.create",
		...fields,
		previous_response_id: record.responseId,
		input: delta,
	};
}

/** Returns the input items added after the recorded response, or undefined when `body` does not continue it. */
function findInputDelta(
	body: ResponsesRequestBody,
	recordedRequest: ResponsesRequestBody,
	responseItems: readonly unknown[],
): unknown[] | undefined {
	const { input, ...fields } = body;
	const { input: recordedInput, ...recordedFields } = recordedRequest;
	if (
		!Array.isArray(input) ||
		!Array.isArray(recordedInput) ||
		JSON.stringify(fields) !== JSON.stringify(recordedFields)
	) {
		return undefined;
	}
	const baseline = [...recordedInput, ...responseItems];
	const prefix = input.slice(0, baseline.length);
	if (
		prefix.length < baseline.length ||
		JSON.stringify(prefix) !== JSON.stringify(baseline)
	) {
		return undefined;
	}
	return input.slice(baseline.length);
}
