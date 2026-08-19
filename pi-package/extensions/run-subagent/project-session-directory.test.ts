import { describe, expect, test } from "bun:test";
import {
	encodeProjectSessionDirectory,
	projectSessionDirectory,
} from "./project-session-directory";

describe("project session directory", () => {
	test("matches Pi's resolved cwd encoding", () => {
		expect(encodeProjectSessionDirectory("/Users/example/project:demo")).toBe(
			"--Users-example-project-demo--",
		);
		expect(encodeProjectSessionDirectory("/Users\\example/project")).toBe(
			"--Users-example-project--",
		);
	});

	test("joins the encoded project directory under the session root", () => {
		expect(projectSessionDirectory("/sessions", "/Users/example/project")).toBe(
			"/sessions/--Users-example-project--",
		);
	});
});
