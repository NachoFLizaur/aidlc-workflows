#!/usr/bin/env bun
/**
 * Project-side Crew hook adapter; invoke through engine adapter kiro-crew.
 * Identity and binding checks precede all core calls. Only absent app bindings
 * opt out; corrupt routing fails guarded PreToolUse with exit 2 and advisory
 * events with a diagnostic at exit 0. No gateway-cwd or inherited-session fallback.
 *
 * PreToolUse ordering: envelope, binding and required guards; exact MCP schemas;
 * structured file/task-list input; structured shell command; title-only advisory;
 * conservative unknown tools. Reviewer inspectability vetoes every classification
 * before dispatch. Display titles never supply executable commands or targets.
 * Guards run state-transition, plan-approval, review-freeze, then reviewer-scope.
 * Core refusals pass through unchanged. Core policy switches still apply; there
 * is no adapter bypass. Inspectable permission requests can block; notifications
 * and diff-only writes are advisory, not containment. Child delivery is not
 * guaranteed, and arbitrary MCP execution is not equivalent to native writes.
 *
 * Human authority excludes child, continuation and automation envelopes before
 * dispatcher activation. Resume intent is not an answer. Plain user replay may
 * record; quoted automation prefixes conservatively do not.
 *
 * PostToolUse detects only conductor create/replace outputs within the selected
 * record/codekb boundary. Freshness uses authorization recorded_at before core
 * audit dispatch, without a shared lock. Same-second ordering, duplicate rows,
 * already-fresh phantom rows and authorization replacement races remain possible.
 * Detection is not permission enforcement. Sensors, graph rebuild, state sync,
 * session-end, compact, subagent-stop, statusline, usage and rule delivery are not
 * registered here. AgentSpawn context is advisory, not rule delivery.
 *
 * The entry pins a corroborated parent-key backend per call, never from titles
 * or configuration. Unknown/conflicting pins refuse guarded Pre and drop Post
 * rows. Child hooks observe the parent backend, not independent child identity.
 * Claude uses its own title grammar and correlated Bash ARTIFACT receipts below;
 * file-tool writes have no success Post. Native Task/Agent refusal cannot block
 * notification paths, and pre-approved reads bypass permission requests.
 */
import { createHash, randomUUID } from "node:crypto";
import { accessSync, appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeSummaryAuthorizationForRecordPath, assertNoSymlinkInChainOrThrow, auditFilePath, codekbDir, hookChildEnv, loadStageGraphAll, recordDir, runWithOwnerStampedLock, sanitizeHarnessPlainText, writeFileAtomic } from "../tools/aidlc-lib.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const EVENTS = new Set(["AgentSpawn", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
const NONHUMAN_PREFIXES = [
  "[Subagent completion event]", "[Subagent batch completion event]",
  "[Cron notification", "[auto-nudge cycle", "[Hook continuation — automatic]",
  "[SYSTEM] Sub-agent synthesis:",
  "[Tool refusal — automatic recovery]", "[Stalled turn — automatic recovery]",
  "[Tool stall — automatic recovery]", "[Connection lost — automatic recovery]",
  "[Session busy — automatic recovery]", "[Interrupted turn — automatic recovery]",
  "[Empty response — automatic recovery]", "[Unfinished action — automatic recovery]",
  "[Context compacted — automatic recovery]",
  "[Continue — requested by the user]",
  "[Stop-hook nudge cap reached]", "[Monitor wake]", "[Tool blocked — reason sent to the agent]",
];
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const timestamp = (value: unknown): boolean => text(value) && Number.isFinite(Date.parse(value));
const note = (message: string): void => { process.stderr.write(`AI-DLC Kiro Crew: ${message}\n`); };

// Read per call; direct launches without a valid entry pin stay unknown.
export function resolveBackend(): "kiro" | "claude" | "unknown" {
  const resolvedBackend = process.env.AIDLC_CREW_BACKEND;
  return resolvedBackend === "kiro" || resolvedBackend === "claude" ? resolvedBackend : "unknown";
}

export function crewSessionId(parentSessionKey: string): string {
  if (!text(parentSessionKey) || parentSessionKey.includes("\0")) throw new Error("missing or malformed parent_session_key; bind the dashboard session with aidlc_bind_session");
  return `crew-${createHash("sha256").update(parentSessionKey, "utf8").digest("hex")}`;
}

/** Independent twin of app-side setup: read the exact engine binding before
 * core invocation. Only lstat ENOENT bootstraps; corrupt/stale records stop,
 * without repair or bypass. No-follow/nonblocking reads reject special files.
 * Valid null-intent bindings preserve their space and cold isolation. */
export function classifyEngineBinding(project: string, sessionId: string):
  { state: "missing" } | { state: "corrupt"; reason: string } |
  { state: "valid"; binding: { space: string; intent: string | null; boundAt: string } } {
  const path = join(project, "aidlc/.aidlc-sessions", `${sessionId}.binding.json`);
  const corrupt = (detail: string) => ({ state: "corrupt" as const, reason: `corrupt/stale engine session binding ${path}: ${detail}; no automatic repair` });
  try {
    if (!lstatSync(path).isFile()) return corrupt("not a regular file");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : corrupt("unreadable record");
  }
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let candidate: unknown;
    try {
      if (!fstatSync(fd).isFile()) return corrupt("not a regular file");
      candidate = JSON.parse(readFileSync(fd, "utf8"));
    } finally { closeSync(fd); }
    if (!object(candidate) || typeof candidate.space !== "string" || !/^[a-z][a-z0-9-]*$/.test(candidate.space) ||
      (candidate.intent !== null && (typeof candidate.intent !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.intent))) ||
      typeof candidate.boundAt !== "string" || candidate.boundAt.length === 0) return corrupt("invalid schema or name");
    if (candidate.intent !== null && !existsSync(join(project, "aidlc/spaces", candidate.space, "intents", candidate.intent, "aidlc-state.md"))) {
      return corrupt("selected intent has no aidlc-state.md");
    }
    return { state: "valid", binding: { space: candidate.space, intent: candidate.intent, boundAt: candidate.boundAt } };
  } catch { return corrupt("unreadable or malformed JSON"); }
}

function projectFor(session: string): string | undefined {
  let project: unknown = process.env.AIDLC_PROJECT_DIR;
  if (project === undefined) {
    const home = process.env.KIROCREW_HOME || join(process.env.HOME || homedir(), ".kiro", "crew");
    if (!isAbsolute(home)) throw new Error("Crew home must be absolute; gateway cwd is not a fallback");
    const path = join(home, "apps", "aidlc", "data", "bindings", `${session.slice(5)}.json`);
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      note(`not participating; absent project binding ${path}; gateway cwd is not a fallback`);
      return undefined;
    }
    let binding: unknown;
    try { binding = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error(`unreadable or malformed project binding ${path}; select the set-up project in the dashboard and bind it with aidlc_bind_session; gateway cwd is not a project`); }
    if (!object(binding) || !timestamp(binding.boundAt)) throw new Error(`invalid project binding ${path}`);
    project = binding.projectDir;
  }
  if (!text(project) || !isAbsolute(project)) throw new Error("project binding must name an absolute project directory; gateway cwd is not a fallback");
  if (!statSync(project).isDirectory()) throw new Error("bound project is not a directory");
  return resolve(project);
}

function reviewerRole(role: unknown): string | undefined {
  if (typeof role !== "string") return undefined;
  const match = /^aidlc-(?:crew-)?(architecture-reviewer|product-lead)-agent$/.exec(role);
  return match ? `aidlc-${match[1]}-agent` : undefined;
}
const READ_ALIASES = new Set(["fs_read", "read", "read_file", "read_files", "Read"]);
const EARLY_READ_NAMES = new Set([...READ_ALIASES, "Glob", "Grep", "file_search", "grep_search", "thinking", "WebFetch", "WebSearch"]);
const WRITE_COMMANDS = new Set(["create", "strReplace", "str_replace", "insert", "append"]);
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "fs_write", "write", "str_replace", "fs_append", ...READ_ALIASES]);
const FILE_KEYS = ["file_path", "path", "notebook_path", "paths", "operations"];
const READ_KEYS = new Set([...FILE_KEYS, "mode", "start_line", "end_line", "startLine", "endLine", "pattern", "depth", "offset", "limit", "exclude_patterns"]);
const READ_MODES = new Set(["Line", "Directory", "Search"]);
const GUARDS = ["aidlc-state-transition-guard.ts", "aidlc-plan-approval-guard.ts", "aidlc-review-freeze.ts"];
type ToolCall = { tool: string; input: JsonObject };
type Classification = { kind: "core"; calls: ToolCall[]; receiptCommand?: string } | { kind: "advisory" } | { kind: "read" } | { kind: "refuse"; reason: string };
function malformed(): never { throw new Error("malformed guarded tool input"); }
class CoreRefusal extends Error {}

/** Validate all present structured fields and targets before core dispatch.
 * Unknown operations, missing targets and escaping paths deny, without bypass.
 * Each batch retains its operation type so a read cannot mask a write. */
function fileCalls(name: string, input: JsonObject, project: string): ToolCall[] {
  const command = input.command;
  const directWriter = ["Write", "Edit", "MultiEdit", "NotebookEdit", "str_replace", "fs_append"].includes(name);
  const writerTitle = /^(Creating|Editing|Writing)\s/.test(name) || ["fs_write", "write"].includes(name);
  const writer = WRITE_COMMANDS.has(String(command)) || directWriter;
  if ("command" in input && (typeof command !== "string" || !WRITE_COMMANDS.has(command))) malformed();
  if (!writer && (writerTitle || Object.keys(input).some((key) => !READ_KEYS.has(key)) ||
    ("mode" in input && !READ_MODES.has(String(input.mode))) ||
    ("offset" in input && (!Number.isInteger(input.offset) || Number(input.offset) < 0)) ||
    ("limit" in input && (!Number.isInteger(input.limit) || Number(input.limit) < 1)) ||
    ("exclude_patterns" in input && (!Array.isArray(input.exclude_patterns) || !input.exclude_patterns.every((pattern) => typeof pattern === "string"))))) malformed();
  const tool = writer ? (command === "create" || name === "Write" ? "Write" : "Edit") : "Read";
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (!text(value) || value.includes("\0")) malformed();
    try {
      paths.push(assertNoSymlinkInChainOrThrow(realpathSync(project), relative(project, resolve(project, value))));
    } catch { malformed(); }
  };
  for (const key of ["file_path", "path", "notebook_path"]) if (key in input) add(input[key]);
  if ("paths" in input) {
    if (!Array.isArray(input.paths) || input.paths.length === 0) malformed();
    for (const path of input.paths) add(path);
  }
  const calls: ToolCall[] = [...new Set(paths)].map((file_path) => ({ tool, input: { ...input, file_path } }));
  if ("operations" in input) {
    if (!Array.isArray(input.operations) || input.operations.length === 0 || writer) malformed();
    for (const op of input.operations) {
      if (!object(op) || "operations" in op ||
        !(WRITE_COMMANDS.has(String(op.command)) || (!("command" in op) && READ_MODES.has(String(op.mode))))) malformed();
      calls.push(...fileCalls("", op, project));
    }
  }
  if (calls.length === 0) malformed();
  return calls;
}

// Canonical shell text is input to core guards, never shell execution.
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const mcpName = (name: string): string | undefined => {
  const normalized = name.replace(/^Running: /, "");
  const match = /^@([^/\s]+)\/([^/\s]+)$/.exec(normalized);
  return match ? `mcp__${match[1]}__${match[2]}` : /^mcp__\S+__\S+$/.test(normalized) ? normalized : undefined;
};

/** Exact owned MCP names, schemas and closed argv branches decide exemptions
 * before core dispatch. Reviewer veto precedes every exemption. Missing fidelity
 * stays conservative; no bypass. Doctor flags exclude exports and update writes. */
function readOnlyEngineArgs(args: string[], project: string): boolean {
  if (args[0] === "doctor" || args[0] === "--doctor") {
    const seen = new Set<string>();
    for (let i = 1; i < args.length; i++) {
      const flag = args[i];
      if (seen.has(flag)) return false;
      seen.add(flag);
      if (flag === "--project-dir") { if (args[++i] !== project) return false; }
      else if (flag !== "--verbose" && flag !== "--json") return false;
    }
    return true;
  }
  if (args[0] !== "engine") return false;
  return (args[1] === "status" && args.length === 2) ||
    (args[1] === "crew-dispatch" && ["list", "wave-status", "reconcile"].includes(args[2])) ||
    (args[1] === "workspace" && args[2] === "project-description") ||
    (args[1] === "testing-posture" && ["resolve", "render", "fingerprint", "verify"].includes(args[2]));
}
function classifyMcp(tool: string, input: JsonObject | undefined, project: string): Classification {
  if (input) {
    const keys = Object.keys(input);
    if (tool === "mcp__aidlc:engine__aidlc_status" && keys.length === 0) return { kind: "read" };
    if (tool === "mcp__aidlc:engine__aidlc_bind_session" && keys.every((key) => key === "session_key" || key === "project_dir") &&
      keys.every((key) => text(input[key]) && !(input[key] as string).includes("\0"))) return { kind: "read" };
    if (tool === "mcp__kirocrew-core__ask_question" && (
      (keys.length === 1 && Array.isArray(input.questions) && input.questions.length > 0 &&
        input.questions.every((question) => object(question) && text(question.question))) ||
      (keys.every((key) => ["question", "options"].includes(key)) && text(input.question) &&
        (!("options" in input) || Array.isArray(input.options))))) return { kind: "read" };
    if (tool === "mcp__aidlc:engine__aidlc_engine" && keys.length === 1 && Array.isArray(input.args) &&
      input.args.length > 0 && input.args.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) {
      if (readOnlyEngineArgs(input.args, project)) return { kind: "read" };
      return { kind: "core", calls: [{ tool: "Bash", input: { command: ["bun", join(project, ".kiro-crew/tools/aidlc.ts"), ...input.args].map(quote).join(" ") } }] };
    }
  }
  return { kind: "core", calls: [{ tool, input: input ?? {} }] };
}

/** Closed host task-list schemas admit bookkeeping, not project mutation.
 * Unknown keys/shapes stay guarded; reviewer veto remains mandatory. */
function taskListInput(input: JsonObject): boolean {
  const keys = Object.keys(input);
  if (input.command === "create") return keys.every((key) => ["command", "task_list_description", "tasks"].includes(key)) &&
    text(input.task_list_description) && (!("tasks" in input) || (Array.isArray(input.tasks) && input.tasks.every((task) =>
      object(task) && Object.keys(task).every((key) => ["task_description", "details"].includes(key)) && text(task.task_description) &&
      (!("details" in task) || typeof task.details === "string"))));
  return input.command === "complete" && keys.every((key) => ["command", "completed_task_ids"].includes(key)) &&
    Array.isArray(input.completed_task_ids) && input.completed_task_ids.length > 0 && input.completed_task_ids.every(text);
}

function classifyTool(payload: JsonObject, project: string): Classification {
  if (!text(payload.tool_name)) malformed();
  const title = payload.tool_name;
  const name = title.replace(/^Running: /, "");
  const input = object(payload.tool_input) ? Object.fromEntries(Object.entries(payload.tool_input).filter(([key]) => key !== "__tool_use_purpose")) : undefined;
  const mcp = mcpName(title);
  if (mcp) return classifyMcp(mcp, input, project);
  const hasFilePath = input && (["file_path", "path", "notebook_path", "paths"].some((key) => key in input) ||
    (Array.isArray(input.operations) && input.operations.some((op) => object(op) && "path" in op)));
  if (input && !hasFilePath && !FILE_TOOLS.has(name) && taskListInput(input)) {
    if (!reviewerRole(payload.agent_role)) note("task-list tool: no mutation surface");
    return { kind: "read" };
  }
  if (input && ((hasFilePath && WRITE_COMMANDS.has(String(input.command))) || FILE_KEYS.some((key) => key in input) ||
    FILE_TOOLS.has(name) || /^(Creating|Editing|Writing)\s/.test(name))) {
    return { kind: "core", calls: fileCalls(name, input, project) };
  }
  const shellTitle = (title.startsWith("Running: ") && !name.startsWith("@")) ||
    ["Bash", "execute_bash", "execute_pwsh", "shell"].includes(name) ||
    /^(?:(?:\.?\.?\/|[A-Za-z]:[\\/])\S+|bun|node|python3?|bash|sh|pwsh|cat|ls|mkdir|cp|mv|rm|git|printf|echo|sed|awk|rg|grep|touch|curl|npm|npx)(?:\s|$)/.test(name);
  if (shellTitle || (input && text(input.command))) {
    if (!input || !text(input.command)) malformed();
    return { kind: "core", calls: [{ tool: "Bash", input }] };
  }
  if (!input) return { kind: "advisory" };
  return { kind: "core", calls: [{ tool: name, input }] };
}

/** Check reviewer inspectability before any core mutation, even without a
 * dispatch record. Unknown names and MCP calls fail closed, with no adapter
 * bypass. Core evidence and policy switches decide inspectable calls. */
function reviewerCanInspect(classification: Classification, rawInput: unknown): boolean {
  if (!object(rawInput) || classification.kind !== "core") return false;
  return classification.calls.every(({ tool, input }) => {
    if (tool === "Bash") return text(input.command);
    if (["Read", "NotebookRead", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) return text(input.file_path);
    if (tool === "Glob") return text(input.pattern);
    return tool === "Grep" || (tool === "LS" && text(input.path));
  });
}

/** Claude title/shape classification precedes core calls. MCP precedes shell;
 * titles never supply targets. Unknown object inputs stay conservative and the
 * reviewer veto still applies. No bypass or host-path authentication claim. */
function classifyClaudeTool(payload: JsonObject, project: string): Classification {
  if (!text(payload.tool_name)) malformed();
  const title = payload.tool_name;
  const input = object(payload.tool_input) ? Object.fromEntries(Object.entries(payload.tool_input).filter(([key]) => key !== "__tool_use_purpose")) : undefined;
  const mcp = mcpName(title);
  if (mcp) return classifyMcp(mcp.replace(/^mcp__aidlc_engine__/, "mcp__aidlc:engine__"), input, project);
  if (title === "Task" || title === "Agent") return { kind: "refuse", reason: "native Task/Agent delegation is unsupported; use Crew dispatch (notification-path denial is advisory)" };
  if (/^Read(?:\s|$)/.test(title)) {
    if (!input || !FILE_KEYS.some((key) => key in input)) return { kind: "advisory" };
    return { kind: "core", calls: fileCalls("Read", input, project) };
  }
  const writer = /^(Write|Edit)(?:\s|$)/.exec(title)?.[1];
  if (writer || title === "Preparing file…") {
    if (!input) return { kind: "advisory" };
    return { kind: "core", calls: fileCalls(writer ?? "Write", input, project) };
  }
  // Share structural validation without using Kiro display-title recognition.
  if (input && FILE_KEYS.some((key) => key in input)) return { kind: "core", calls: fileCalls("", input, project) };
  if (input && text(input.command)) return { kind: "core", calls: [{ tool: "Bash", input }], receiptCommand: input.command };
  if (title === "Terminal" || title === "Bash") malformed();
  if (!input) return { kind: "advisory" };
  return { kind: "core", calls: [{ tool: title, input }] };
}

/** Read outstanding children before Stop. Corruption allows turn end with a
 * diagnostic rather than a potentially duplicate dispatch nudge. No expiry or
 * auto-removal applies; the conductor must reconcile terminal outcomes. */
function awaitingChildren(project: string, session: string): boolean {
  const path = join(project, "aidlc", ".aidlc-sessions", `${session}.crew-dispatch.json`);
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`cannot read dispatch ledger ${path}`);
  }
  const ledger: unknown = JSON.parse(raw);
  if (!object(ledger) || !Array.isArray(ledger.outstanding) || !ledger.outstanding.every((entry) =>
    object(entry) && text(entry.childId) && text(entry.task) && text(entry.stage) && timestamp(entry.dispatchedAt)
  )) throw new Error(`invalid dispatch ledger ${path}; reconcile it before continuing`);
  return ledger.outstanding.length > 0;
}

/** Read only this Post payload, selected record/codekb and authorization before
 * audit dispatch. Failure drops the row at advisory exit 0; no adapter bypass.
 * Null authorization disables freshness only, not file/boundary checks. The
 * caller pins resolver env synchronously; core stamping uses a separate lock. */
function postWrite(payload: JsonObject, project: string): ToolCall {
  if (payload.subagent_id || (payload.agent_role !== undefined && !["aidlc", "aidlc-crew"].includes(String(payload.agent_role)))) {
    throw new Error("conductor-session payload required; child write provenance is not supported");
  }
  if (typeof payload.tool_name !== "string" || !/^(Creating|Editing) [^/\\\0\r\n]+$(?![\s\S])/.test(payload.tool_name)) {
    throw new Error("missing or unrecognized file-tool title");
  }
  const output = object(payload.tool_response) ? payload.tool_response.output : undefined;
  if (typeof output !== "string") throw new Error("success output must be a string");
  const create = /^Successfully created ([^\0\r\n]+) \([0-9]+ lines\)\.$/.exec(output);
  const replace = /^Successfully replaced [0-9]+ occurrence\(s\) in ([^\0\r\n]+)\.$/.exec(output);
  const match = create ?? replace;
  const raw = match?.[0] === output ? match[1] : undefined;
  if (!raw) throw new Error("unsupported success output (only create/replace; insert/append unsupported)");
  const file = checkedWritePath(raw, project);
  return { tool: create ? "Write" : "Edit", input: { file_path: file } };
}

/** Shared boundary/authorization oracle, read before emission without widening
 * either grammar. Unsafe files and invalid/stale timestamps drop the row. Null
 * authorization skips only its time floor; no disabling flag or shared lock. */
function checkedWritePath(raw: string, project: string): string {
  if (!isAbsolute(raw) || resolve(raw) !== raw) throw new Error("success path must be absolute and normalized");
  const file = assertNoSymlinkInChainOrThrow(realpathSync(project), relative(project, raw));
  if (realpathSync(file) !== file || !lstatSync(file).isFile()) throw new Error("success path must resolve to an existing regular non-symlink file");
  const record = recordDir(project);
  const underRecord = record !== null && file.startsWith(`${record}/`);
  const codekb = dirname(codekbDir(project, "_"));
  if (!underRecord && !file.startsWith(`${codekb}/`)) throw new Error("success path is outside the active record/codekb boundary");
  if (underRecord) {
    const authorization = activeSummaryAuthorizationForRecordPath(project, relative(record, file).replaceAll("\\", "/"), loadStageGraphAll());
    if (authorization !== null) {
      const floor = Date.parse(authorization.recorded_at);
      const mtime = statSync(file).mtimeMs;
      if (!Number.isFinite(floor) || !Number.isFinite(mtime) || mtime < floor) throw new Error("file freshness failed: invalid timestamp or mtime below summary authorization recorded_at floor");
    }
  }
  return file;
}

type ReceiptRequest = { path: string; atMs: number; commandHash: string };
const RECEIPT_WINDOW_MS = 2000;
const RECEIPT_TTL_MS = 10 * 60 * 1000;
const MAX_RECEIPT_PATHS = 256;

/** Local receipt ledger: <crew-home>/apps/aidlc/data/receipts/<session-hash>.jsonl.
 * Only conductor structured Bash commands passing every core guard append paths;
 * atMs is arrival before guard I/O. Literal ARTIFACT commands and in-boundary,
 * no-symlink paths are required; heredoc bodies never grant receipt authority.
 * No shell expansion/execution or title inference occurs. Unsupported spellings
 * miss rows; pre-approved Bash without a request cannot produce an audit row.
 *
 * The owner-stamped lock serializes read/append/consume. Reads prune entries older
 * than 10 minutes before matching/cap decisions, persisting expiry even on later
 * refusal. Byte-identical commands coalesce within an inclusive fixed 2,000-ms
 * window, retaining earliest arrival. Newest prior matching path wins, consumed
 * before core emission. Failure Posts consume all preceding requests: unrelated
 * failures can miss rows. Future arrivals and child Posts are excluded.
 *
 * Corrupt/unsafe records, contention and more than 256 paths refuse Pre or drop
 * Post rows; no repair or bypass. Appends/rewrites use 0600, new directories 0700.
 * A lost core emission stays consumed, but a replay can match an older pending
 * request. Identical concurrent commands can misattribute a fresh in-boundary
 * write. This is detection only, not a grant or a shared core-authorization lock. */
function receiptLedger<T>(session: string, action: (entries: ReceiptRequest[], path: string) => T): T {
  const home = process.env.KIROCREW_HOME || join(process.env.HOME || homedir(), ".kiro", "crew");
  if (!isAbsolute(home)) throw new Error("receipt ledger requires an absolute Crew home");
  const directory = assertNoSymlinkInChainOrThrow(realpathSync(home), "apps/aidlc/data/receipts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${session.slice(5)}.jsonl`);
  const result = runWithOwnerStampedLock(`${path}.lock`, 20, 10, () => {
    let entries: ReceiptRequest[] = [];
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("invalid receipt ledger file or size");
        const raw = readFileSync(fd, "utf8");
        entries = raw === "" ? [] : raw.trimEnd().split("\n").map((line) => JSON.parse(line));
      } finally { closeSync(fd); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!entries.every((entry) => object(entry) &&
      text(entry.path) && isAbsolute(entry.path) && !/[\0\r\n]/.test(entry.path) && resolve(entry.path) === entry.path &&
      Number.isSafeInteger(entry.atMs) && entry.atMs > 0 && typeof entry.commandHash === "string" && /^[a-f0-9]{64}$/.test(entry.commandHash))) {
      throw new Error("invalid receipt ledger entries; no automatic repair");
    }
    const now = Date.now();
    const pending = entries.filter((entry) => now - entry.atMs <= RECEIPT_TTL_MS);
    if (pending.length !== entries.length) rewriteReceiptLedger(path, pending);
    entries = pending;
    if (entries.length > MAX_RECEIPT_PATHS) throw receiptLedgerFull(path);
    return action(entries, path);
  });
  if (!result.acquired) throw new Error("receipt ledger lock contended; retry the operation");
  return result.value;
}

/** Restore 0600 under the ledger lock after atomic replacement, before returning
 * to admission. Replacement temporarily uses umask-derived permissions; existing
 * directory permissions remain operator-owned. Failure refuses Pre/drops Post;
 * no bypass. The shared atomic writer has no mode argument. */
function rewriteReceiptLedger(path: string, entries: ReceiptRequest[]): void {
  writeFileAtomic(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  chmodSync(path, 0o600);
}

function receiptLedgerFull(path: string): Error {
  return new Error(`receipt ledger full (256 pending); entries expire after 10 min; remove \`${path}\` to reset (operator action)`);
}

// Mask queued literal heredoc bodies as the state-transition guard does.
// Unsupported delimiters discard the command instead of guessing body boundaries.
function receiptCommandText(command: string): string {
  const pending: { delimiter: string; stripTabs: boolean }[] = [];
  const lines: string[] = [];
  for (const line of command.split("\n")) {
    if (pending.length) {
      if ((pending[0].stripTabs ? line.replace(/^\t+/, "") : line) === pending[0].delimiter) pending.shift();
      continue;
    }
    const heredoc = /(?<!<)<<(-)?[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))(?=[ \t;&|<>)]|$)/g;
    const withoutDelimiters = line.replace(heredoc, (_match, tabs, single, double, bare) => {
      pending.push({ delimiter: single ?? double ?? bare, stripTabs: tabs === "-" });
      return "";
    });
    if (withoutDelimiters.includes("<<")) return "";
    lines.push(withoutDelimiters);
  }
  return pending.length ? "" : lines.join("\n");
}

function rememberReceiptRequest(project: string, session: string, command: string, atMs: number, env: Record<string, string | undefined>): void {
  if (command.includes("\0")) malformed();
  const commandText = receiptCommandText(command);
  if (!commandText.includes("ARTIFACT ")) return;
  const pins = ["AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "AIDLC_HARNESS_DIR", "AIDLC_HARNESS_NAME", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE"];
  const prior = pins.map((key) => process.env[key]);
  let record: string | null;
  let codekb: string;
  try {
    for (const key of pins) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
    record = recordDir(project);
    codekb = dirname(codekbDir(project, "_"));
  } finally {
    for (const [index, key] of pins.entries()) { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; }
  }
  const paths = new Set<string>();
  for (const match of commandText.matchAll(/(?:^|[\s=<>|;&(])(?:"(\/[^"\0\r\n]+)"|'(\/[^'\0\r\n]+)'|(\/[^\s"'`$<>|;&()\\]+))/g)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (resolve(path) !== path || !((record !== null && path.startsWith(`${record}/`)) || path.startsWith(`${codekb}/`))) continue;
    try { paths.add(assertNoSymlinkInChainOrThrow(realpathSync(project), relative(project, path))); }
    catch { /* Unsafe paths supply no receipt authority. */ }
  }
  if (!paths.size) return;
  const commandHash = createHash("sha256").update(command, "utf8").digest("hex");
  receiptLedger(session, (entries, path) => {
    const duplicate = entries.find((entry) => entry.commandHash === commandHash && Math.abs(atMs - entry.atMs) <= RECEIPT_WINDOW_MS);
    if (duplicate) {
      if (atMs < duplicate.atMs) rewriteReceiptLedger(path, entries.map((entry) =>
        entry.commandHash === commandHash && entry.atMs === duplicate.atMs ? { ...entry, atMs } : entry));
      return; // Guard completion can reorder arrivals; retain the earliest floor.
    }
    if (entries.length + paths.size > MAX_RECEIPT_PATHS) throw receiptLedgerFull(path);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("receipt ledger is not a regular file");
      appendFileSync(fd, [...paths].map((path) => JSON.stringify({ path, atMs, commandHash })).join("\n") + "\n");
    } finally { closeSync(fd); }
  });
}

/** Admit only unnamed conductor Post with one console fence and exactly one
 * final-line ARTIFACT. Require the newest same-session prior request and file
 * mtime >= request arrival; consume before core emission, never from Pre alone.
 * Before title/receipt admission, a single bare/console fence beginning with
 * Exit code or User refused permission consumes preceding requests as failed.
 * Output shape is not authenticated failure identity; unrelated failures can
 * miss rows. Every other failure drops the row; no bypass or self-attestation. */
function claudePostWrite(payload: JsonObject, project: string, session: string, postAtMs: number): ToolCall {
  if (payload.subagent_id || (payload.agent_role !== undefined && !["aidlc", "aidlc-crew"].includes(String(payload.agent_role)))) {
    throw new Error("conductor-session payload required; child write provenance is not supported");
  }
  const output = object(payload.tool_response) ? payload.tool_response.output : undefined;
  const fenced = typeof output === "string" ? /^```(?:console)?\n([\s\S]*)\n```$/.exec(output) : null;
  const firstLine = fenced?.[1].split("\n")[0] ?? "";
  if (fenced && !fenced[1].split("\n").some((line) => line.startsWith("```")) &&
    (/^Exit code \d+/.test(firstLine) || /^User refused permission to run tool(?:$|[ \t.:])/.test(firstLine))) {
    receiptLedger(session, (entries, path) => {
      const remaining = entries.filter((entry) => entry.atMs > postAtMs);
      if (remaining.length !== entries.length) rewriteReceiptLedger(path, remaining);
    });
    throw new Error("Claude failure/rejection Post: prior requests consumed-failed; no write receipt");
  }
  if (Object.hasOwn(payload, "tool_name")) throw new Error("Claude titled Post is not a receipt (file-tool write provenance is not supported)");
  if (typeof output !== "string" || !output.startsWith("```console\n") || !output.endsWith("\n```")) throw new Error("unsupported Claude receipt output");
  const body = output.slice("```console\n".length, -"\n```".length);
  const lines = body.split("\n");
  const raw = /^ARTIFACT (\/[^\n]+)$/.exec(lines.at(-1) ?? "")?.[1];
  if (!raw || /[\0\r]/.test(raw) || lines.some((line) => line.startsWith("```")) || lines.filter((line) => line.startsWith("ARTIFACT ")).length !== 1) {
    throw new Error("unsupported Claude receipt: exactly one ARTIFACT on the last fenced body line required");
  }
  return receiptLedger(session, (entries, path) => {
    const entry = entries.filter((entry) => entry.path === raw && entry.atMs <= postAtMs)
      .reduce<ReceiptRequest | undefined>((newest, candidate) => !newest || candidate.atMs >= newest.atMs ? candidate : newest, undefined);
    if (!entry) throw new Error("receipt requires a prior unconsumed permission request");
    const file = checkedWritePath(raw, project);
    const mtime = statSync(file).mtimeMs;
    if (!Number.isFinite(mtime) || mtime < entry.atMs) throw new Error("receipt freshness failed: mtime below permission request atMs");
    rewriteReceiptLedger(path, entries.filter((other) => other !== entry));
    return { tool: "Write", input: { file_path: file } };
  });
}

export async function run(target: string, input: string, _extraArgs: string[] = []): Promise<number> {
  const arrivedAtMs = Date.now();
  let event = target || process.env.KIROCREW_HOOK_EVENT || "";
  let payload: JsonObject;
  try {
    const parsed: unknown = JSON.parse(input);
    if (!object(parsed)) throw new Error("payload is not an object");
    payload = parsed;
  } catch {
    note("malformed hook JSON; safety checks could not run");
    return event === "PreToolUse" ? 2 : 0;
  }
  event ||= typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  if ((event === "PreToolUse" && !text(payload.hook_event_name)) || !EVENTS.has(event) || [payload.hook_event_name, process.env.KIROCREW_HOOK_EVENT].some((name) =>
    name !== undefined && name !== event
  )) {
    note("unknown or conflicting hook event");
    return [event, payload.hook_event_name, process.env.KIROCREW_HOOK_EVENT].includes("PreToolUse") ? 2 : 0;
  }
  const reviewer = reviewerRole(payload.agent_role);
  let guarded = event === "PreToolUse" && (reviewer !== undefined || !EARLY_READ_NAMES.has(String(payload.tool_name)));
  try {
    const session = crewSessionId(typeof payload.parent_session_key === "string" ? payload.parent_session_key : "");
    const project = projectFor(session);
    if (project === undefined) return 0;
    const binding = classifyEngineBinding(project, session);
    if (binding.state === "corrupt") throw new Error(binding.reason);
    const resolvedBackend = resolveBackend();
    if (event === "UserPromptSubmit") {
      const prompt = typeof payload.prompt === "string" ? payload.prompt : process.env.KIROCREW_HOOK_CONTEXT || "";
      if (!text(prompt) || payload.subagent_id || payload.stop_hook_active === true ||
        (typeof payload.hook_continuation_count === "number" && payload.hook_continuation_count > 0) ||
        NONHUMAN_PREFIXES.some((prefix) => prompt.trimStart().startsWith(prefix))) {
        note("nonhuman or empty prompt; HUMAN_TURN not recorded");
        return 0;
      }
      payload.prompt = prompt;
    }
    const env = hookChildEnv(project, session, {
      AIDLC_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project,
      AIDLC_HARNESS_DIR: ".kiro-crew", AIDLC_HARNESS_NAME: "kiro-crew",
    });
    const base = { cwd: project, session_id: session };
    /** Only admitted human prompts get a fresh dispatcher activation token.
     * Failure stays advisory; core withholds authority when unattended. The
     * process token is plumbing, not authentication of the host envelope. */
    const core = (file: string, data: JsonObject): { code: number; stdout: string } => {
      const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
      const hook = file.replace(/^aidlc-|\.ts$/g, "");
      const authorityToken = hook === "record-human-turn" ? randomUUID() : "";
      const command = executable
        ? authorityToken
          ? [executable, "--internal-aidlc-record-human-turn", join(HOOKS_DIR, file)]
          : [executable, "engine", "hook", hook]
        : authorityToken
          ? [process.execPath, join(HOOKS_DIR, "..", "tools", "aidlc.ts"), "--internal-aidlc-record-human-turn", join(HOOKS_DIR, file)]
          : [process.execPath, join(HOOKS_DIR, file)];
      const result = Bun.spawnSync(command, {
        cwd: project,
        env: authorityToken ? { ...env, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: authorityToken } : env,
        stdin: Buffer.from(JSON.stringify({ ...base, ...data })),
        stdout: "pipe", stderr: "pipe", timeout: 6000,
      });
      if (result.stderr.length) process.stderr.write(result.stderr);
      if (event === "PreToolUse" && result.exitCode === 2 && result.stderr.length) throw new CoreRefusal();
      if (result.exitCode !== 0) throw new Error(`${file} failed (exit ${result.exitCode}); safety checks could not complete`);
      return { code: result.exitCode, stdout: result.stdout.toString() };
    };
    if (event === "PostToolUse") {
      const pins = ["AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "AIDLC_HARNESS_DIR", "AIDLC_HARNESS_NAME", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE"];
      const prior = pins.map((key) => process.env[key]);
      try {
        for (const key of pins) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
        if (resolvedBackend === "unknown") throw new Error("unknown or conflicting backend observation; no grammar selected");
        const call = resolvedBackend === "claude" ? claudePostWrite(payload, project, session, arrivedAtMs) : postWrite(payload, project);
        if (!existsSync(auditFilePath(project))) note("PostToolUse advisory: audit shard missing; core will drop the write row");
        core("aidlc-write-audit-log.ts", { hook_event_name: event, tool_name: call.tool, tool_input: call.input });
      } catch (error) {
        note(`PostToolUse advisory pass-through: ${error instanceof Error ? error.message : "write provenance unavailable"}`);
      } finally {
        for (const [index, key] of pins.entries()) { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; }
      }
      return 0;
    }
    if (event === "AgentSpawn") {
      if (binding.state === "valid") {
        process.stdout.write(`AIDLC Runtime Session: ${session}\n`);
        return 0;
      }
      const result = core("aidlc-session-start.ts", { hook_event_name: "SessionStart", source: "startup" });
      if (result.stdout.trim()) {
        let context = result.stdout;
        try {
          const parsed: unknown = JSON.parse(context);
          context = object(parsed) && typeof parsed.additionalContext === "string" ? parsed.additionalContext : "";
        } catch { /* Plain-text context remains supported. */ }
        process.stdout.write(sanitizeHarnessPlainText(context));
      }
    } else if (event === "UserPromptSubmit") {
      core("aidlc-record-human-turn.ts", { hook_event_name: event, prompt: payload.prompt });
    } else if (event === "PreToolUse") {
      const hooks = [...GUARDS];
      if (reviewer) hooks.push("aidlc-reviewer-scope.ts");
      // Missing required guards deny before any fidelity-based exemption.
      for (const hook of hooks) accessSync(process.env.AIDLC_COMPILED_EXECUTABLE || join(HOOKS_DIR, hook), constants.R_OK);
      guarded = true;
      if (resolvedBackend === "unknown") throw new Error(reviewer ? "reviewer-scope veto: unresolved backend cannot be inspected" : "unknown or conflicting backend observation; guarded tool refused");
      let classified: Classification;
      try { classified = resolvedBackend === "claude" ? classifyClaudeTool(payload, project) : classifyTool(payload, project); }
      catch (error) {
        if (reviewer) throw new Error("reviewer-scope veto: tool input cannot be inspected");
        throw error;
      }
      if (reviewer && (mcpName(String(payload.tool_name)) || !reviewerCanInspect(classified, payload.tool_input))) throw new Error("reviewer-scope veto: tool input cannot be inspected");
      if (classified.kind === "refuse") throw new Error(classified.reason);
      if (classified.kind === "read") return 0;
      if (classified.kind === "advisory") {
        const title = sanitizeHarnessPlainText(String(payload.tool_name)).replace(/\s+/g, " ").slice(0, 360);
        note(`advisory — target unavailable (Crew forwards a diff, not the parameters); ${title}`);
        return 0;
      }
      for (const { tool, input: normalized } of classified.calls) for (const hook of hooks) core(hook, {
        hook_event_name: event, tool_name: tool, tool_input: normalized,
        ...(reviewer ? { agent_type: reviewer } : payload.subagent_id && text(payload.agent_role) ? { agent_type: payload.agent_role } : {}),
      });
      if (classified.receiptCommand && !payload.subagent_id && (payload.agent_role === undefined || ["aidlc", "aidlc-crew"].includes(String(payload.agent_role)))) {
        rememberReceiptRequest(project, session, classified.receiptCommand, arrivedAtMs, env);
      }
    } else if (event === "Stop") {
      if (awaitingChildren(project, session)) {
        note("awaiting dispatched children; legitimate turn end, no Stop block");
        return 0;
      }
      const result = core("aidlc-continue-workflow.ts", {
        hook_event_name: "Stop", assistant_text: payload.assistant_text,
        stop_hook_active: payload.stop_hook_active === true,
        hook_continuation_count: payload.hook_continuation_count,
      });
      if (result.stdout.trim()) {
        const decision: unknown = JSON.parse(result.stdout);
        if (!object(decision) || decision.decision !== "block" || !text(decision.reason)) throw new Error("invalid core Stop decision");
        process.stdout.write(`${JSON.stringify({ decision: "block", reason: decision.reason })}\n`);
      }
    }
    return 0;
  } catch (error) {
    if (error instanceof CoreRefusal) return 2;
    note(error instanceof Error ? error.message : "hook failed");
    return guarded ? 2 : 0;
  }
}

if (import.meta.main) process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text(), process.argv.slice(3)));
