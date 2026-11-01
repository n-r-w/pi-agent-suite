/** HTTP response with server-sent events, as the Responses API sends over HTTP. */
export function sseResponse(events: readonly object[]): Response {
	const body = events
		.map(
			(event) =>
				`event: ${(event as { type?: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
		)
		.join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}
