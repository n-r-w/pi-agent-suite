import { expect, test } from "bun:test";
import { parseRestorationConfig } from "./config";

test("restoration config accepts only an optional boolean enabled value", () => {
	expect(parseRestorationConfig("{}")).toEqual({
		kind: "valid",
		enabled: true,
	});
	expect(parseRestorationConfig('{"enabled":true}')).toEqual({
		kind: "valid",
		enabled: true,
	});
	expect(parseRestorationConfig('{"enabled":false}')).toEqual({
		kind: "valid",
		enabled: false,
	});
	for (const content of [
		"{",
		"null",
		"[]",
		'{"enabled":1}',
		'{"enabled":null}',
		'{"extra":true}',
	]) {
		expect(parseRestorationConfig(content)).toEqual({ kind: "invalid" });
	}
});
