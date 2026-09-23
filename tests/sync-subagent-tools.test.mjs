import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const runtimeAgentDir = await mkdtemp(join(tmpdir(), "sync-subagent-tools-agent-dir-"));
let piApi;
let syncExtension;
try {
	process.env.PI_CODING_AGENT_DIR = runtimeAgentDir;
	piApi = await import("@earendil-works/pi-coding-agent");
	assert.equal(piApi.getAgentDir(), runtimeAgentDir);
	syncExtension = await import("../extensions/sync-subagent-tools.ts");
} catch (error) {
	await rm(runtimeAgentDir, { recursive: true, force: true });
	throw error;
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}

const { parseFrontmatter } = piApi;
const {
	default: syncSubagentTools,
	AGENT_NAMES,
	isSyncAllowedMode,
	prepareSync,
	writeAgentFileAtomically,
} = syncExtension;

after(async () => {
	await rm(runtimeAgentDir, { recursive: true, force: true });
});

function agentFixtures(initialTools = ["read", "edit"]) {
	return Object.fromEntries(
		AGENT_NAMES.map((name, index) => [
			name,
			[
				"---",
				`description: "Fixture for ${name}; sync-subagent-tools:begin is text"`,
				"# sync-subagent-tools:begin",
				`tools: ${index === 0 ? initialTools.join(", ") : "read"}`,
				"# sync-subagent-tools:end",
				"model: test/model",
				"---",
				`Body for ${name}, mentioning sync-subagent-tools:begin and sync-subagent-tools:end as prose.`,
				"",
			].join("\n"),
		]),
	);
}

function toolsLine(content) {
	return content.split("\n").find((line) => line.startsWith("tools: "));
}

test("unions managed and live tools across all six agents, sorts, and remains idempotent", () => {
	const first = prepareSync(agentFixtures(["read", "edit", "retained.managed"]), ["read", "bash", "edit", "write", "new_tool", "tool.name+v2"]);
	assert.deepEqual(first.toolNames, [...first.toolNames].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
	assert.match(toolsLine(first.contents.Explore), /bash/);
	assert.match(toolsLine(first.contents.Explore), /edit/);
	assert.match(toolsLine(first.contents.Explore), /write/);
	assert.match(toolsLine(first.contents.Explore), /new_tool/);
	assert.match(toolsLine(first.contents.Explore), /retained\.managed/);
	assert.match(toolsLine(first.contents.Explore), /tool\.name\+v2/);
	assert.deepEqual(new Set(AGENT_NAMES.map((name) => toolsLine(first.contents[name]))).size, 1);
	assert.match(first.contents.Review, /# sync-subagent-tools:begin\ntools: /);
	assert.match(first.contents.Review, /# sync-subagent-tools:end\nmodel:/);
	assert.match(first.contents.Review, /Body for Review, mentioning sync-subagent-tools:begin and sync-subagent-tools:end as prose\./);

	const second = prepareSync(first.contents, ["read", "bash", "edit", "write", "new_tool", "tool.name+v2"]);
	assert.deepEqual(second.contents, first.contents);
	assert.deepEqual(second.toolNames, first.toolNames);
});

test("retains managed names while adding new tools absent from a later catalog", () => {
	const first = prepareSync(agentFixtures(["read"]), ["read", "temporary_tool"]);
	const second = prepareSync(first.contents, ["read", "new_tool"]);
	for (const name of AGENT_NAMES) {
		assert.match(toolsLine(second.contents[name]), /temporary_tool/);
		assert.match(toolsLine(second.contents[name]), /new_tool/);
	}
});

test("excludes only pi-subagents' forced recursive tools", () => {
	const result = prepareSync(agentFixtures(["read"]), ["read", "subagent", "get_subagent_result", "steer_subagent"]);
	assert.doesNotMatch(toolsLine(result.contents.Explore), /\b(?:subagent|get_subagent_result|steer_subagent)\b/);
});

test("rejects malformed frontmatter, duplicate keys, and malformed markers before writes", () => {
	for (const malformed of [
		(agent) => agent.replace(/^---\n/, ""),
		(agent) => agent.replace(/^description:.*$/m, "description: first\ndescription: duplicate"),
		(agent) => agent.replace("model: test/model", "# sync-subagent-tools:begin\nmodel: test/model"),
		(agent) => agent.replace("# sync-subagent-tools:end", "# sync-subagent-tools:end-extra"),
		(agent) => agent
			.replace("# sync-subagent-tools:begin\n", "# sync-subagent-tools:temporary\n")
			.replace("# sync-subagent-tools:end\n", "# sync-subagent-tools:begin\n")
			.replace("# sync-subagent-tools:temporary\n", "# sync-subagent-tools:end\n"),
	]) {
		const originals = agentFixtures();
		originals.Review = malformed(originals.Review);
		const before = structuredClone(originals);
		assert.throws(() => prepareSync(originals, ["read", "write"]));
		assert.deepEqual(originals, before);
	}
});

test("rejects unmarked handwritten overrides instead of adopting them", () => {
	const unmarked = agentFixtures();
	unmarked.Adversarial = unmarked.Adversarial
		.replace("# sync-subagent-tools:begin\n", "")
		.replace("# sync-subagent-tools:end\n", "");
	assert.match(toolsLine(unmarked.Adversarial), /read, edit/);
	assert.throws(() => prepareSync(unmarked, ["read", "write"]), /managed sync markers are required/);
});

test("requires managed markers even without a tools key and rejects markers outside frontmatter", () => {
	const noTools = agentFixtures();
	noTools.Adversarial = noTools.Adversarial.replace(
		"# sync-subagent-tools:begin\ntools: read, edit\n# sync-subagent-tools:end\n",
		"",
	);
	assert.throws(() => prepareSync(noTools, ["read"]), /managed sync markers are required/);

	const misplaced = agentFixtures();
	misplaced.Adversarial = misplaced.Adversarial
		.replace("# sync-subagent-tools:begin\ntools: read, edit\n# sync-subagent-tools:end\n", "")
		.replace("---\nBody for Adversarial", "---\n# sync-subagent-tools:begin\nBody for Adversarial");
	assert.throws(() => prepareSync(misplaced, ["read"]), /sync markers must stay inside frontmatter/);
});

test("rejects duplicate managed names and duplicate markers", () => {
	const valid = prepareSync(agentFixtures(["read"]), ["read"]).contents;
	const duplicateName = { ...valid };
	const line = toolsLine(duplicateName.Review);
	duplicateName.Review = duplicateName.Review.replace(line, line.replace("tools: ", "tools: read, read, "));
	assert.throws(() => prepareSync(duplicateName, ["read"]), /duplicate tool name/);

	const duplicateMarker = { ...valid };
	duplicateMarker.Review = duplicateMarker.Review.replace(
		"# sync-subagent-tools:end",
		"# sync-subagent-tools:end\n# sync-subagent-tools:end",
	);
	assert.throws(() => prepareSync(duplicateMarker, ["read"]), /malformed or duplicate/);
});

test("accepts Pi catalog names and interoperates with Pi's YAML frontmatter parser", () => {
	const liveNames = [
		"#custom-tool",
		"name with spaces",
		"custom: tool",
		"custom.tool+v2",
		'quote"name',
		"internal\ttab",
		"internal\nline",
		"internal\u0085control",
		"internal\u2028line-separator",
	];
	const first = prepareSync(agentFixtures(["read"]), liveNames);
	for (const name of liveNames) assert.ok(first.toolNames.includes(name));
	assert.match(toolsLine(first.contents.Review), /^tools: \"/);
	const quotedTools = toolsLine(first.contents.Review).slice("tools: ".length);
	assert.ok(quotedTools.startsWith('"'));
	assert.deepEqual(JSON.parse(quotedTools).split(",").map((name) => name.trim()), first.toolNames);
	const parsedByPi = parseFrontmatter(first.contents.Review);
	assert.equal(parsedByPi.frontmatter.tools, first.toolNames.join(", "));
	assert.match(parsedByPi.body, /Body for Review, mentioning sync-subagent-tools:begin/);
	const second = prepareSync(first.contents, liveNames);
	assert.deepEqual(second.contents, first.contents);
	assert.throws(
		() => prepareSync(agentFixtures(["read"]), ["tool,with-comma"]),
		/cannot be represented in comma-separated agent frontmatter/,
	);
});

test("preserves CRLF newlines, final-newline state, and body content", () => {
	const crlf = Object.fromEntries(
		Object.entries(agentFixtures()).map(([name, contents]) => [name, contents.replaceAll("\n", "\r\n").slice(0, -2)]),
	);
	const result = prepareSync(crlf, ["read", "new_tool"]);
	const review = result.contents.Review;
	assert.equal(review.endsWith("\r\n"), false);
	assert.equal(review.replaceAll("\r\n", "").includes("\n"), false);
	assert.ok(review.endsWith("Body for Review, mentioning sync-subagent-tools:begin and sync-subagent-tools:end as prose."));
});

test("requires exactly the six intended agent files", () => {
	assert.deepEqual(AGENT_NAMES, ["Adversarial", "Bounded-advisor", "Explore", "Implement", "Review", "Verify"]);
	const incomplete = agentFixtures();
	delete incomplete.Verify;
	assert.throws(() => prepareSync(incomplete, ["read"]), /exactly these six agent files/);
});

test("allows manual sync in TUI only; print parents are deliberately excluded", () => {
	assert.equal(isSyncAllowedMode("tui"), true);
	assert.equal(isSyncAllowedMode("print"), false);
	assert.equal(isSyncAllowedMode("rpc"), false);
	assert.equal(isSyncAllowedMode("json"), false);
});

test("registers the manual command only for TUI sessions; print parents are excluded", async () => {
	let sessionStart;
	let registeredName;
	let options;
	syncSubagentTools({
		on(event, handler) {
			assert.equal(event, "session_start");
			sessionStart = handler;
		},
		registerCommand(name, commandOptions) {
			registeredName = name;
			options = commandOptions;
		},
		getAllTools() {
			return [{ name: "runtime_available_tool" }];
		},
	});

	sessionStart({}, { mode: "print" });
	assert.equal(registeredName, undefined);
	sessionStart({}, { mode: "tui" });
	assert.equal(registeredName, "sync-subagent-tools");
	await options.handler("", { mode: "print" });

	const agentsDirectory = join(runtimeAgentDir, "agents");
	await mkdir(agentsDirectory, { recursive: true });
	for (const [name, contents] of Object.entries(agentFixtures())) {
		await writeFile(join(agentsDirectory, `${name}.md`), contents);
	}
	const notifications = [];
	await options.handler("", {
		mode: "tui",
		ui: { notify: (...notification) => notifications.push(notification) },
	});
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0][1], "info");
	for (const name of AGENT_NAMES) {
		assert.match(await readFile(join(agentsDirectory, `${name}.md`), "utf8"), /runtime_available_tool/);
	}
});

test("atomically replaces files, preserves permission bits, and refuses stale content", async () => {
	const directory = await mkdtemp(join(tmpdir(), "sync-subagent-tools-"));
	const filePath = join(directory, "Review.md");
	try {
		await writeFile(filePath, "before\n");
		await chmod(filePath, 0o640);
		await writeAgentFileAtomically(filePath, "before\n", "after\n");
		assert.equal(await readFile(filePath, "utf8"), "after\n");
		assert.equal((await stat(filePath)).mode & 0o777, 0o640);

		await writeFile(filePath, "intervening edit\n");
		await assert.rejects(
			writeAgentFileAtomically(filePath, "after\n", "clobbered\n"),
			/changed since sync began/,
		);
		assert.equal(await readFile(filePath, "utf8"), "intervening edit\n");
		assert.deepEqual(await readdir(directory), ["Review.md"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cleans up its temporary file after a partial temporary write fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "sync-subagent-tools-"));
	const filePath = join(directory, "Review.md");
	const failingFileOperations = {
		readFile,
		stat,
		rename,
		unlink,
		async open(tempPath, flags, mode) {
			const handle = await open(tempPath, flags, mode);
			return {
				async writeFile() {
					await handle.writeFile("partial temporary content", "utf8");
					throw new Error("simulated temporary write failure");
				},
				chmod: handle.chmod.bind(handle),
				close: handle.close.bind(handle),
			};
		},
	};
	try {
		await writeFile(filePath, "original destination\n");
		await assert.rejects(
			writeAgentFileAtomically(filePath, "original destination\n", "replacement\n", failingFileOperations),
			/simulated temporary write failure/,
		);
		assert.equal(await readFile(filePath, "utf8"), "original destination\n");
		assert.deepEqual(await readdir(directory), ["Review.md"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("leaves the destination intact when temporary-file creation fails", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "sync-subagent-tools-"));
	const filePath = join(directory, "Review.md");
	try {
		await writeFile(filePath, "before\n");
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			t.skip("root can bypass directory permission checks");
			return;
		}

		await chmod(directory, 0o500);
		try {
			await assert.rejects(
				writeAgentFileAtomically(filePath, "before\n", "after\n"),
				(error) => error.code === "EACCES",
			);
		} finally {
			await chmod(directory, 0o700);
		}
		assert.equal(await readFile(filePath, "utf8"), "before\n");
		assert.deepEqual(await readdir(directory), ["Review.md"]);
	} finally {
		await chmod(directory, 0o700);
		await rm(directory, { recursive: true, force: true });
	}
});
