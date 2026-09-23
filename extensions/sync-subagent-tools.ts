import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AGENT_NAMES = [
	"Adversarial",
	"Bounded-advisor",
	"Explore",
	"Implement",
	"Review",
	"Verify",
] as const;

type AgentName = (typeof AGENT_NAMES)[number];
type AgentContents = Record<AgentName, string>;

const BEGIN_MARKER = "# sync-subagent-tools:begin";
const END_MARKER = "# sync-subagent-tools:end";
const FORCED_EXCLUSIONS = new Set(["subagent", "get_subagent_result", "steer_subagent"]);

// Bootstrap from the union of generated/tool-policy.json keep+drop entries and
// pi-tool-surface's configured source catalog. Runtime additions come from getAllTools().
const BOOTSTRAP_TOOL_NAMES = [
	"advisor",
	"ask_user_question",
	"ast_grep_outline",
	"ast_grep_replace",
	"ast_grep_search",
	"bash",
	"document_parse",
	"document_screenshot",
	"document_search",
	"edit",
	"effective_config",
	"fetch_content",
	"find",
	"get_search_content",
	"grep",
	"lens_diagnostic_mark",
	"lens_diagnostics",
	"ls",
	"lsp_navigation",
	"mcp",
	"mcpScript",
	"mcp__codebase_memory_mcp",
	"module_report",
	"pi_lens_activate_tools",
	"powershell",
	"preview_export",
	"project_report",
	"read",
	"read_enclosing",
	"read_symbol",
	"source_check",
	"symbol_search",
	"todo",
	"web_search",
	"write",
] as const;

interface SplitFile {
	lines: string[];
	newline: string;
	finalNewline: boolean;
}

interface ParsedAgent extends SplitFile {
	managedNames: string[];
}

function splitFile(content: string): SplitFile {
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const finalNewline = content.endsWith(newline);
	const lines = content.split(/\r?\n/);
	if (finalNewline) lines.pop();
	return { lines, newline, finalNewline };
}

function validateScalar(value: string, label: string, lineNumber: number): string {
	if (value === "") return value;
	if (value.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (typeof parsed !== "string") throw new Error("not a string");
			return parsed;
		} catch {
			throw new Error(`${label}:${lineNumber}: malformed quoted frontmatter scalar`);
		}
	}
	if (value.startsWith("'")) {
		if (!value.endsWith("'") || value.slice(1, -1).replace(/''/g, "").includes("'")) {
			throw new Error(`${label}:${lineNumber}: malformed quoted frontmatter scalar`);
		}
		return value.slice(1, -1).replace(/''/g, "'");
	}
	if (
		/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
		/:\s|\s#|[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
	) {
		throw new Error(`${label}:${lineNumber}: unsupported or malformed plain frontmatter scalar`);
	}
	return value;
}

function validateToolName(name: unknown, label: string): asserts name is string {
	if (typeof name !== "string" || !name || name.trim() !== name || name.includes(",")) {
		throw new Error(`${label}: tool name cannot be represented in comma-separated agent frontmatter: ${JSON.stringify(name)}`);
	}
}

function parseToolNames(value: string, label: string): string[] {
	if (!value.trim()) throw new Error(`${label}: managed tools list is empty`);
	const names = value.split(",").map((name) => name.trim());
	const seen = new Set<string>();
	for (const name of names) {
		validateToolName(name, label);
		if (seen.has(name)) throw new Error(`${label}: duplicate tool name ${JSON.stringify(name)}`);
		if (FORCED_EXCLUSIONS.has(name)) throw new Error(`${label}: ${name} is forcibly excluded by pi-subagents`);
		seen.add(name);
	}
	return names;
}

export function parseAgent(content: string, label = "<agent>"): ParsedAgent {
	const split = splitFile(content);
	const { lines } = split;
	if (lines[0] !== "---") throw new Error(`${label}: frontmatter must start with ---`);
	const closeIndex = lines.indexOf("---", 1);
	if (closeIndex < 0) throw new Error(`${label}: frontmatter closing --- is missing`);

	const keys = new Map<string, number>();
	let toolsLineIndex: number | null = null;
	for (let index = 1; index < closeIndex; index++) {
		const line = lines[index];
		if (line.includes("\t")) throw new Error(`${label}:${index + 1}: tabs are not allowed in frontmatter`);
		if (!line.trim() || /^\s*#/.test(line)) continue;
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:[ ]+(.*))?$/);
		if (!match) throw new Error(`${label}:${index + 1}: malformed or unsupported frontmatter line`);
		const [, key, value = ""] = match;
		if (keys.has(key)) throw new Error(`${label}:${index + 1}: duplicate frontmatter key ${key}`);
		keys.set(key, index);
		validateScalar(value, label, index + 1);
		if (key === "tools") toolsLineIndex = index;
	}

	const frontmatter = lines.slice(1, closeIndex);
	const markerLinePattern = /^\s*#\s*sync-subagent-tools\s*:/;
	const misplacedMarkers = lines.slice(closeIndex + 1).filter((line) => markerLinePattern.test(line));
	if (misplacedMarkers.length > 0) throw new Error(`${label}: sync markers must stay inside frontmatter`);
	const markerLines = frontmatter
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => markerLinePattern.test(line));
	if (markerLines.length === 0) throw new Error(`${label}: managed sync markers are required`);
	if (
		markerLines.length !== 2 ||
		markerLines[0].line !== BEGIN_MARKER ||
		markerLines[1].line !== END_MARKER ||
		markerLines[0].index >= markerLines[1].index
	) {
		throw new Error(`${label}: malformed or duplicate sync-subagent-tools markers`);
	}
	const [begin, end] = markerLines.map(({ index }) => index);
	const managedBlock = frontmatter.slice(begin + 1, end);
	if (managedBlock.length !== 1 || !/^tools:[ ]+.+$/.test(managedBlock[0])) {
		throw new Error(`${label}: marker region must contain exactly one tools: line`);
	}
	if (toolsLineIndex !== begin + 2) throw new Error(`${label}: tools: line must be inside the marker region`);
	const value = validateScalar(managedBlock[0].slice("tools:".length).trim(), label, begin + 3);
	return { ...split, managedNames: parseToolNames(value, label) };
}

function normalizedNames(names: readonly string[], label: string): string[] {
	const unique = new Set<string>();
	for (const name of names) {
		validateToolName(name, label);
		if (unique.has(name)) throw new Error(`${label}: duplicate tool name ${JSON.stringify(name)}`);
		unique.add(name);
	}
	return [...unique].filter((name) => !FORCED_EXCLUSIONS.has(name));
}

function sortedUnion(...groups: readonly string[][]): string[] {
	return [...new Set(groups.flat())].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function formatToolNames(names: readonly string[]): string {
	const value = names.join(", ");
	try {
		validateScalar(value, "tools", 1);
		return value;
	} catch {
		return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, (character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
	}
}

function replaceManagedTools(parsed: ParsedAgent, names: readonly string[]): string {
	const lines = [...parsed.lines];
	const beginIndex = lines.indexOf(BEGIN_MARKER, 1);
	const endIndex = lines.indexOf(END_MARKER, beginIndex + 1);
	const block = [BEGIN_MARKER, `tools: ${formatToolNames(names)}`, END_MARKER];
	lines.splice(beginIndex, endIndex - beginIndex + 1, ...block);
	return lines.join(parsed.newline) + (parsed.finalNewline ? parsed.newline : "");
}

export function prepareSync(
	contents: Readonly<Record<string, string>>,
	availableToolNames: readonly string[],
): { contents: AgentContents; toolNames: string[] } {
	const providedNames = Object.keys(contents).sort();
	const expectedNames = [...AGENT_NAMES].sort();
	if (providedNames.length !== expectedNames.length || providedNames.some((name, index) => name !== expectedNames[index])) {
		throw new Error(`Expected exactly these six agent files: ${AGENT_NAMES.join(", ")}`);
	}

	// Parse every file and validate the live catalog before constructing any writes.
	const parsed = Object.fromEntries(
		AGENT_NAMES.map((name) => [name, parseAgent(contents[name], `${name}.md`)]),
	) as Record<AgentName, ParsedAgent>;
	const available = normalizedNames(availableToolNames, "Pi tool catalog");
	const existingManaged = AGENT_NAMES.flatMap((name) => parsed[name].managedNames);
	const toolNames = sortedUnion([...BOOTSTRAP_TOOL_NAMES], existingManaged, available)
		.filter((name) => !FORCED_EXCLUSIONS.has(name));
	const updated = Object.fromEntries(
		AGENT_NAMES.map((name) => [name, replaceManagedTools(parsed[name], toolNames)]),
	) as AgentContents;
	for (const name of AGENT_NAMES) {
		const roundTrippedNames = parseAgent(updated[name], `${name}.md`).managedNames;
		if (roundTrippedNames.length !== toolNames.length || roundTrippedNames.some((toolName, index) => toolName !== toolNames[index])) {
			throw new Error(`${name}.md: generated managed tools list failed round-trip validation`);
		}
	}
	return { contents: updated, toolNames };
}

export function isSyncAllowedMode(mode: string): boolean {
	return mode === "tui";
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface AtomicFileOperations {
	open: typeof open;
	readFile: typeof readFile;
	rename: typeof rename;
	stat: typeof stat;
	unlink: typeof unlink;
}

const ATOMIC_FILE_OPERATIONS: AtomicFileOperations = { open, readFile, rename, stat, unlink };

export async function writeAgentFileAtomically(
	filePath: string,
	expectedContents: string,
	newContents: string,
	fileOperations: AtomicFileOperations = ATOMIC_FILE_OPERATIONS,
): Promise<void> {
	const initialContents = await fileOperations.readFile(filePath, "utf8");
	if (initialContents !== expectedContents) {
		throw new Error(`${filePath}: changed since sync began; refusing to overwrite`);
	}
	const originalMode = (await fileOperations.stat(filePath)).mode & 0o7777;
	const tempPath = join(dirname(filePath), `.sync-subagent-tools-${randomUUID()}.tmp`);
	let tempCreated = false;
	let handle: Awaited<ReturnType<typeof open>> | undefined;

	try {
		handle = await fileOperations.open(tempPath, "wx", originalMode);
		tempCreated = true;
		await handle.writeFile(newContents, "utf8");
		await handle.chmod(originalMode);
		await handle.close();
		handle = undefined;

		const latestContents = await fileOperations.readFile(filePath, "utf8");
		if (latestContents !== expectedContents) {
			throw new Error(`${filePath}: changed while sync was preparing replacement; refusing to overwrite`);
		}
		await fileOperations.rename(tempPath, filePath);
		tempCreated = false;
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		if (handle) {
			try {
				await handle.close();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
		}
		if (tempCreated) {
			try {
				await fileOperations.unlink(tempPath);
			} catch (cleanupError) {
				if (!isMissingFile(cleanupError)) cleanupErrors.push(cleanupError);
			}
		}
		if (cleanupErrors.length > 0) {
			const details = cleanupErrors.map(errorMessage).join("; ");
			throw new AggregateError(
				[error, ...cleanupErrors],
				`Atomic replacement failed (${errorMessage(error)}) and temporary-file cleanup failed (${details})`,
			);
		}
		throw error;
	}
}

const AGENT_DIRECTORY = join(getAgentDir(), "agents");

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, sessionCtx) => {
		// pi-subagents children and print-mode parents are deliberately excluded.
		if (!isSyncAllowedMode(sessionCtx.mode)) return;

		pi.registerCommand("sync-subagent-tools", {
			description: "Sync all six custom subagent tool allowlists (TUI parent only; print parents are deliberately excluded)",
			handler: async (_args, ctx) => {
				if (!isSyncAllowedMode(ctx.mode)) return;

				const updatedAgents: AgentName[] = [];
				try {
					const pairs = await Promise.all(
						AGENT_NAMES.map(async (name) => [
							name,
							await readFile(join(AGENT_DIRECTORY, `${name}.md`), "utf8"),
						] as const),
					);
					const originals = Object.fromEntries(pairs) as AgentContents;
					const catalog = pi.getAllTools().map((tool) => tool.name);
					const result = prepareSync(originals, catalog);

					for (const name of AGENT_NAMES) {
						if (result.contents[name] !== originals[name]) {
							const agentPath = join(AGENT_DIRECTORY, `${name}.md`);
							await writeAgentFileAtomically(agentPath, originals[name], result.contents[name]);
							updatedAgents.push(name);
						}
					}
					ctx.ui.notify(`Synced ${result.toolNames.length} tools to ${AGENT_NAMES.length} agents.`, "info");
				} catch (error) {
					const message = errorMessage(error);
					const progress = updatedAgents.length > 0
						? ` Updated before failure: ${updatedAgents.join(", ")}. Later files may remain unsynced; no cross-file rollback was attempted.`
						: " No files were updated by this sync before the failure.";
					ctx.ui.notify(`Subagent tool sync failed: ${message}.${progress}`, "error");
				}
			},
		});
	});
}
