/** Stateless newline-delimited JSON-RPC bridge. Engine calls use this Bun and
 * the selected project's TypeScript entry, never shell/launcher/native fallback.
 * Stdout is protocol-only, diagnostics go to stderr, calls are serialized.
 * The engine owns durable workflow state. Bun is required with native installs. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { classifyEngineBinding, crewHome, crewIdentityText, crewPidKey, crewSubagentProject, isRecordedKey, projectPath, sessionHash } from "../setup/aidlc-kiro-crew-setup.ts";
import { boundCrewBackend, crewBackendFromRecords, validateCrewStamp, type CrewBackend } from "../hooks/aidlc-kiro-crew-hook-entry.ts";

// Also embedded in the generated conductor prompt; one transport contract.
export const CREW_ENGINE_TRANSPORT = `**Engine transport on Crew.** After the first \`aidlc_status\`, EVERY AIDLC engine operation the conductor performs, including shared \`aidlc …\` notation, direct helper scripts (\`aidlc-*.ts\` under \`.kiro-crew/tools/\`, invoked with Bun), and commands returned inside directives, goes through \`@aidlc:engine/aidlc_engine\` with raw argv (\`{"args":[…]}\`), never through the shell tool. Translate by this canonical contract, not prefix stripping alone:
(a) After removing the runtime prefix, preserve already-prefixed \`engine …\` argv as-is; never double-prefix it. Bare \`intent\` / \`orchestrate\` and the \`utility\` alias are refused.
(b) Map \`aidlc-utility.ts project-description …\` to \`["engine","workspace","project-description",…]\`; \`aidlc-log.ts decision …\` / \`answer …\` to \`["engine","log","decision",…]\` / \`["engine","log","answer",…]\`; \`aidlc-orchestrate.ts\` or \`orchestrate\` with \`next\`, \`continue\`, \`report\`, or \`park\` to \`["engine","orchestrate","next",<request>]\`, \`["engine","orchestrate","continue",<token>]\`, \`["engine","orchestrate","report",…]\`, or \`["engine","orchestrate","park",…]\` respectively (omit the request on a subsequent bare \`next\`). Plan Approval questions and own-words replies are engine-owned: follow the current directive; never substitute manual log entries for an approval receipt.
(c) Cold \`next\` has two paths: naming a valid scope as the positional first word (\`["engine","orchestrate","next","express",<request>]\`) or via \`--scope express\` returns an intent-creation \`print\` directive. A freeform request with no scope (\`["engine","orchestrate","next",<request>]\`) returns an \`ask\` directive: render it, END THE TURN and wait for the human's scope/compose reply; a nonhuman envelope never answers it. Only after that human reply proceed with the selected scope or \`["engine","orchestrate","next","compose",<text>]\`. Each \`next\` path creates NO intent by itself. Execute the separate flag-based \`intent create --scope <scope> --arguments <request> --label <label>\` as \`["engine","intent","create","--scope",<scope>,"--arguments",<request>,"--label",<label>,…]\`: substitute a 2–3 word kebab essence into \`--label\`, preserving every other directive flag (\`--depth\`, \`--test-strategy\`, \`--review\`, \`--change-control\`, ceremony flags) as separate argv elements. A positional label is refused in every case (\`intent-create does not accept positional arguments\`). Verify the created \`<YYMMDD>-<label>\` directory and this session's intent binding before continuing as directed. Recovery navigation is \`["engine","intent","switch",<name>]\`, not bare \`intent\`; do not repair bindings by hand.
(d) Current engine asks carry complete typed commands: use the selected command unchanged after runtime-to-argv translation, preserving \`--request <id>\`; these commands take precedence over cold-start examples above. Never append request text, use a preview as a request or report an engine ask's answer. Map \`aidlc-review-brief.ts context …\` to \`["engine","review-brief","context",…]\`. \`--doctor --verbose\` translates to \`["doctor","--verbose"]\`. Public \`config <section> …\` is outside the bridge allowlist: STOP and hand the exact command to the operator for terminal execution, never execute it through shell or MCP. This overrides shared in-session configuration guidance; the admitted \`engine config set …\` interface is not a substitute for public config. Operator-only terminal remedies remain instructions for the operator.
(e) Use one argv element per value, no shell quoting: each request, answer, label, name, or long token is exactly ONE string. Remove shell-syntax quoting/escaping without altering literal content (including quotes, apostrophes, spaces and metacharacters); separate a rendered \`--flag=value\` into flag and literal value. This overrides POSIX-escaping instructions. Unmapped routes stop visibly rather than guessing a namespace. Each bridge subprocess is limited to 120 s / 4 MiB output; timeout or overflow is a visible stop, never a shell fallback or success receipt. Check grammar before operations and every tool result before further mutation; no ceremony bypass or shell-containment claim. The adapter exempts only valid conductor status, bind, question presentation and closed read-only engine invocations; other engine argv runs the same guards as shell, and other tools stay conservative.`;

const ENGINE_COMMANDS = ["engine", "next", "continue", "report", "park", "team-board", "doctor", "--doctor"];
const TOOLS = [
  {
    name: "aidlc_status",
    description: "Read the selected project's AI-DLC workflow status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "aidlc_engine",
    description: CREW_ENGINE_TRANSPORT,
    inputSchema: {
      type: "object",
      properties: { args: { type: "array", description: "Dispatcher argv, not a shell command: one argv element per value, no shell quoting. Use the canonical translations in the tool description; config <section> requires an operator stop. Calls may mutate workflow state. Timeout (120 s) or output overflow (4 MiB) is a visible stop, never a shell fallback.", items: { type: "string" }, minItems: 1, examples: [["engine", "orchestrate", "next", "build a URL shortener"], ["engine", "orchestrate", "continue", "<token>"], ["engine", "orchestrate", "report", "--stage", "<stage>", "--result", "completed"], ["engine", "orchestrate", "park"], ["engine", "log", "decision", "--stage", "<stage>", "--decision", "<question>", "--options", "<choices>"], ["engine", "log", "answer", "--stage", "<stage>", "--details", "<exact human choice>"], ["engine", "workspace", "project-description"], ["engine", "intent", "create", "--scope", "express", "--arguments", "build a URL shortener", "--label", "url-shortener"], ["engine", "intent", "switch", "<name>"], ["doctor", "--verbose"]] } },
      required: ["args"],
      additionalProperties: false,
    },
  },
  {
    name: "aidlc_bind_session",
    description: "Bind this Crew conversation to the selected project. Identity is auto-resolved from Crew's records. If unavailable, stop and report; an operator may bind from a terminal using the exact key shown in <home>/session_pid_<pid>.txt. An optional session_key must be Crew-recorded and must not conflict with resolved identity. Subagent sessions only: optional project_dir selects the parent's absolute, stamped project from the delegation brief, inside Crew's effective subagent_cwd_allowed_roots. Conductors select by launch/session-map cwd, never project_dir.",
    inputSchema: { type: "object", properties: { session_key: { type: "string", minLength: 1 }, project_dir: { type: "string", minLength: 1 } }, additionalProperties: false },
  },
];
type RecordValue = Record<string, unknown>;
type RpcId = string | number | null;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}
function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
const mappedKey = crewPidKey;

/** Re-read every call before binding/init: env key, host PID, scratch owner PID,
 * then immediate parent mapping. Any scratch directory with .owner is accepted;
 * Claude may publish a Node runtime PID without HOST_PID. Warm runtimes can rekey; no
 * process walk or stable-key assumption. Missing identity retries next call,
 * never guesses or bypasses. Local routing is not authentication; a shared
 * runtime PID cannot distinguish simultaneous conversations. */
export function resolveCrewSessionKey(home: string): string | undefined {
  const envKey = process.env.KIROCREW_SESSION_KEY;
  if (envKey?.trim() && !/[\0\r\n]/.test(envKey)) return envKey;
  const host = process.env.KIROCREW_HOST_PID;
  if (host && /^\d+$/.test(host) && Number(host) > 1) {
    const key = mappedKey(home, Number(host));
    if (key) return key;
  }
  const scratch = process.env.KIROCREW_SCRATCH;
  if (scratch) {
    try {
      const owner = crewIdentityText(join(scratch, ".owner"));
      if (/^\d+$/.test(owner) && !owner.includes("\n")) {
        const key = mappedKey(home, Number(owner));
        if (key) return key;
      }
    } catch { /* Missing scratch publication never implies identity. */ }
  }
  return mappedKey(home, process.ppid);
}
let explicitSessionKey: string | undefined;
const BIND_HELP = `Cannot bind Crew session: identity is unavailable from Crew's records.
Paths: <home>/session_pid_<pid>.txt; <app>/setup/aidlc-kiro-crew-setup.ts; <absolute-project>.
Records: aidlc_bind_session accepts only Crew-published identity, never a backend-native UUID. Conductor keys match the hook's parent_session_key; child MCP keys are distinct from that parent key.
Next steps:
1. Stop and report; never construct a key.
2. An operator may bind from a terminal using the exact key shown in <home>/session_pid_<pid>.txt: bun <app>/setup/aidlc-kiro-crew-setup.ts bind --session-key <raw-key> --project-dir <absolute-project> --crew-home <home>.`;

/** Corroborate explicit and retained keys against current home records and auto
 * identity before selection or writes on every call. Unknown/conflicting keys
 * refuse with no bypass. New valid explicit input permits operator recovery. */
function sessionKey(home: string, supplied?: string): string | undefined {
  const resolved = resolveCrewSessionKey(home);
  const explicit = supplied ?? explicitSessionKey;
  if (explicit !== undefined) {
    if (!isRecordedKey(home, explicit)) throw new Error(`session_key is not a Crew-recorded key for this home.
Paths: ${home}
Records: ${join(home, "session_pid_<pid>.txt")}
Next steps:
1. Use the exact key shown in ${join(home, "session_pid_<pid>.txt")}.`);
    if (resolved !== undefined && resolved !== explicit) throw new Error(`session_key conflicts with resolved Crew identity for this home.
Paths: ${home}
Records: supplied session_key differs from resolved Crew identity.
Next steps:
1. Stop and report.
2. Rebind from the real key.`);
  }
  return resolved ?? explicit;
}
type Context = { home: string; directProject?: string };
type Source = "binding" | "session-map" | "launch-cwd" | "direct-launch" | "project-dir";
type Selection = { project: string; source: Source; path: string; before?: string; data?: RecordValue };
const PROJECT_HELP = "Select the project in the dashboard, run project setup, or use aidlc_bind_session after selecting a set-up project.";
const REBIND_HELP = "Next steps:\n1. Rebind explicitly with bun <app>/setup/aidlc-kiro-crew-setup.ts bind --session-key <raw-key> --project-dir <absolute-project> --crew-home <crew-home>.\n2. Then retry aidlc_bind_session.";

/** Validate registered argv before protocol activity or mutation. Registered
 * launches require an absolute existing home and ignore ambient project pins.
 * Only the no-args direct-launcher route uses env/default home. No bypass. */
function launchContext(args: string[]): Context {
  if (!args.length) return { home: crewHome(), directProject: process.env.AIDLC_PROJECT_DIR };
  if (args.length !== 3 || args[0] !== "mcp" || args[1] !== "--crew-home") {
    throw new Error("Registered MCP launch requires mcp --crew-home <absolute-existing-directory>; env/default home fallback is only for the direct launcher mcp route.");
  }
  const home = args[2];
  try {
    if (!isAbsolute(home)) throw new Error("not absolute");
    return { home: projectPath(home) };
  } catch { throw new Error(`Invalid --crew-home ${JSON.stringify(home)}: expected an absolute existing directory; no env/default fallback.`); }
}

/** Only lstat ENOENT is absent. Present unsafe, unreadable or oversized routing
 * files fail before selection/writes, never fall through to another cwd.
 * No-follow/nonblocking bounded reads prevent special-file hangs; no bypass. */
function routingText(path: string): string | undefined {
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`Invalid routing file: ${path}`);
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size === buffer.length) throw new Error(`Oversize routing file: ${path}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally { closeSync(fd); }
}
function stampedProject(value: unknown): string {
  if (typeof value !== "string") throw new Error("Project directory must be an absolute existing directory.");
  const project = projectPath(value);
  const stamp = validateCrewStamp(join(project, ".kiro-crew/tools/data/aidlc-stamp.json"));
  if (!stamp.ok) throw new Error(`${stamp.reason}; run project setup.`);
  return project;
}

/** Select after current identity, before writes: own binding, own session-map
 * cwd, then stamped launch cwd. Legacy string/empty cwd is absent; corrupt maps
 * or invalid present cwd refuse. Binding/map disagreement requires explicit
 * operator setup bind. A subagent-only project_dir validates stamp/effective roots
 * before writes and on reuse; it ignores the child's distinct cwd but never
 * switches an existing binding. No search or bypass. Local routing does not
 * grant Crew trust/cwd permissions. */
function selectProject(context: Context, key: string, projectDir?: string): Selection {
  const requested = projectDir === undefined ? undefined : crewSubagentProject(context.home, projectDir, key);
  const hash = sessionHash(key);
  const path = join(context.home, "apps/aidlc/data/bindings", `${hash}.json`);
  let before: string | undefined;
  let data: RecordValue | undefined;
  let bound: string | undefined;
  try {
    before = routingText(path);
    if (before !== undefined) {
      const value: unknown = JSON.parse(before);
      if (!record(value) || typeof value.boundAt !== "string" || !Number.isFinite(Date.parse(value.boundAt))) throw new Error("invalid timestamp/schema");
      bound = stampedProject(value.projectDir);
      data = value;
    }
  } catch (error) { throw new Error(`Invalid or unreadable Crew project binding: ${error instanceof Error ? error.message : String(error)}
Paths: ${path}
Records: present binding is invalid or unreadable.
${REBIND_HELP}`); }
  if (requested !== undefined || data?.source === "project-dir") {
    const project = requested ?? crewSubagentProject(context.home, bound!, key);
    if (bound && bound !== project) throw new Error(`project_dir conflicts with the existing Crew project binding; no automatic project switch.\nPaths: ${path}\n${REBIND_HELP}`);
    return { project, source: "project-dir", path, before, data: data ? { ...data, source: "project-dir" } : undefined };
  }
  let cwd: unknown;
  try {
    const text = routingText(join(context.home, "session_map.json"));
    if (text !== undefined) {
      const map: unknown = JSON.parse(text);
      if (!record(map)) throw new Error("expected an object");
      const entry = Object.hasOwn(map, key) ? map[key] : undefined;
      if (record(entry)) cwd = entry.cwd;
    }
  } catch { throw new Error(`Cannot read Crew session-map cwd for key sha256:${hash}. No project fallback.
Paths: ${join(context.home, "session_map.json")}
Records: session-map cwd is unreadable.
Next steps:
1. Repair the session map in the dashboard.`); }
  let mapped: string | undefined;
  if (cwd !== undefined && cwd !== "") {
    try {
      if (typeof cwd !== "string") throw new Error("cwd must be an absolute existing directory");
      mapped = projectPath(cwd);
    } catch { throw new Error(`Invalid Crew session-map cwd for key sha256:${hash}; expected an absolute existing directory.
Paths: ${join(context.home, "session_map.json")}
Records: invalid cwd for this key.
Next steps:
1. ${PROJECT_HELP}`); }
  }
  if (bound) {
    if (mapped && mapped !== bound) throw new Error(`Crew project selection conflict for key sha256:${hash}. No automatic project switch.
Paths: binding ${bound} differs from session-map cwd ${mapped}.
Records: ${path}; ${join(context.home, "session_map.json")}
${REBIND_HELP}`);
    return { project: bound, source: "binding", path, before, data };
  }
  if (mapped) return { project: stampedProject(mapped), source: "session-map", path };
  const launch = context.directProject ?? process.cwd();
  try { return { project: stampedProject(launch), source: context.directProject === undefined ? "launch-cwd" : "direct-launch", path }; }
  catch (error) {
    throw new Error(`Cannot select Crew project for key sha256:${hash}: launch cwd ${launch} is not a set-up project (${error instanceof Error ? error.message : String(error)}).
Paths: ${path}; ${join(context.home, "session_map.json")}
Records: no binding; no session-map cwd for this key.
Next steps:
1. ${PROJECT_HELP}`);
  }
}

/** Recheck stamp and unchanged binding bytes before rename. Preserve timestamp,
 * extra fields and source; add provenance to old setup bindings. Failure refuses
 * the tool, no bypass. Final check/rename can race another writer: not a lock. */
function writeBinding(selection: Selection, key: string) {
  const { project, path, before, source, data } = selection;
  stampedProject(project);
  const keyHash = sessionHash(key);
  const changed = before === undefined;
  const after = data && typeof data.source === "string" && (source !== "project-dir" || JSON.parse(before!).source === "project-dir") ? before! : `${JSON.stringify(data ? { ...data, source } : { projectDir: project, boundAt: new Date().toISOString(), source }, null, 2)}\n`;
  if (after !== before) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, after, { flag: "wx", mode: before === undefined ? 0o600 : statSync(path).mode & 0o777 });
      if (routingText(path) !== before) throw new Error(`Crew project binding changed during selection: ${path}; retry with other writers stopped.`);
      renameSync(tmp, path);
    } finally { rmSync(tmp, { force: true }); }
  }
  if (changed) process.stderr.write(`AI-DLC Kiro Crew MCP: selected project ${project}; source: ${source}; key sha256:${keyHash}.\n`);
  return { keyHash, projectDir: project, path, changed, source: data?.source ?? source };
}

/** Check stamp and TypeScript entry before every exec and first binding write.
 * Missing engine refuses even native-only projects; no launcher fallback or
 * bypass. Child-only pins clear inherited engine and identity-source overrides. */
function engineContext(context: Context, project: string, key: string) {
  stampedProject(project);
  const entry = join(project, ".kiro-crew/tools/aidlc.ts");
  try { if (!statSync(entry).isFile()) throw new Error("not a file"); }
  catch { throw new Error(`MCP bridge requires bun + project engine: missing ${entry}; native aidlc alone is not supported. Run project setup.`); }
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: project, AIDLC_SESSION_OVERRIDE: `crew-${sessionHash(key)}`, AIDLC_CREW_BACKEND: boundCrewBackend(context.home, project, key), AIDLC_HARNESS_DIR: ".kiro-crew", AIDLC_HARNESS_NAME: "kiro-crew", KIROCREW_HOME: context.home };
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  delete env.AIDLC_COMPILED_EXECUTABLE;
  return { entry, env };
}

/** Re-read engine binding before routing writes/core work. Only absence starts
 * a session; valid null-intent records skip startup and corrupt/stale records
 * refuse without repair/bypass. AgentSpawn is runtime allocation, not reset.
 * Verify durable initialization after advisory spawn, never trust exit 0 alone.
 * Calls serialize locally; concurrent initializers remain possible. */
async function bindAndInitialize(context: Context, key: string, projectDir?: string) {
  const selection = selectProject(context, key, projectDir);
  const project = selection.project;
  engineContext(context, project, key);
  const session = `crew-${sessionHash(key)}`;
  const path = join(project, "aidlc/.aidlc-sessions", `${session}.binding.json`);
  const initialized = () => {
    const state = classifyEngineBinding(project, session);
    if (state.state === "corrupt") throw new Error(state.reason);
    return state.state === "valid";
  };
  const ready = initialized();
  const binding = writeBinding(selection, key);
  if (!ready) {
    const { entry, env } = engineContext(context, project, key);
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, [entry, "engine", "adapter", "kiro-crew", "AgentSpawn"], {
        cwd: project,
        env,
        encoding: "utf-8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      }, (error, _stdout, stderr) => {
        if (stderr) process.stderr.write(stderr);
        if (error) reject(error); else resolve();
      });
      child.stdin?.on("error", reject);
      child.stdin?.end(JSON.stringify({ hook_event_name: "AgentSpawn", parent_session_key: key, cwd: project }));
    });
    if (!initialized()) throw new Error(`Core session-start did not create ${path}; repair the project engine and retry.`);
  }
  return { ...binding, ...publishBackend(context, project, key) };
}

/** Read the own-key provider after validated initialization and again after
 * engine work, which can replace binding fields. Preserve space/intent/time and
 * extras. Missing records publish unknown; disagreeing known observations set
 * sticky backendConflict, retained across core rewrites within this call. Only
 * operator repair clears it. No config/title/process fallback or bypass. Corrupt
 * bindings refuse, never repair. Snapshot recheck before rename is not a lock. */
function publishBackend(context: Context, project: string, key: string, prior?: { backend: CrewBackend; backendConflict?: true }): { backend: CrewBackend; backendConflict?: true } {
  const session = `crew-${sessionHash(key)}`;
  const path = join(project, "aidlc/.aidlc-sessions", `${session}.binding.json`);
  const before = routingText(path);
  const state = classifyEngineBinding(project, session);
  if (state.state !== "valid" || before === undefined) throw new Error(state.state === "corrupt" ? state.reason : `Missing engine session binding ${path}; no backend publication.`);
  const data = JSON.parse(before) as RecordValue;
  const observed = crewBackendFromRecords(context.home, key);
  const previous = Object.hasOwn(data, "backend") ? data.backend : prior?.backend;
  const conflict = data.backendConflict !== undefined || prior?.backendConflict === true ||
    (previous !== undefined && previous !== "unknown" && (previous !== "kiro" && previous !== "claude" || observed !== "unknown" && previous !== observed));
  const observation = { backend: conflict ? "unknown" as const : observed, ...(conflict ? { backendConflict: true as const } : {}) };
  if (data.backend === observation.backend && data.backendConflict === observation.backendConflict) return observation;
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ ...data, ...observation }, null, 2)}\n`, { flag: "wx", mode: statSync(path).mode & 0o777 });
    if (routingText(path) !== before) throw new Error(`Engine session binding changed during backend publication: ${path}; retry with other writers stopped.`);
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
  return observation;
}

async function runEngine(context: Context, args: string[]) {
  let binding: Awaited<ReturnType<typeof bindAndInitialize>>;
  let execution: ReturnType<typeof engineContext>;
  let key: string;
  try {
    const resolved = sessionKey(context.home);
    if (!resolved) return toolError(BIND_HELP);
    key = resolved;
    binding = await bindAndInitialize(context, key);
    execution = engineContext(context, binding.projectDir, key);
  }
  catch (error) { return toolError(`Cannot bind Crew session: ${error instanceof Error ? error.message : String(error)}`); }
  return new Promise<{ content: { type: string; text: string }[]; isError: boolean }>((resolve) => {
    execFile(process.execPath, [execution.entry, ...args], {
      cwd: binding.projectDir,
      env: execution.env,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (stderr) process.stderr.write(stderr);
      try { publishBackend(context, binding.projectDir, key, binding); }
      catch (publicationError) {
        resolve(toolError(`Cannot bind Crew session: backend publication after engine execution failed: ${publicationError instanceof Error ? publicationError.message : String(publicationError)}`));
        return;
      }
      resolve({
        content: [{ type: "text", text: stdout || (error ? stderr || error.message : "") }],
        isError: error !== null,
      });
    });
  });
}

/** Validate tool schema and entry allowlist before execution. Invalid argv and
 * project overrides return isError without spawning; no bypass. Admitted engine
 * operations are not sandboxed. Timeout/output overflow is a tool error, never
 * a success receipt. Only the separate subagent bind selector admits project_dir. */
async function callTool(context: Context, params: unknown) {
  if (!record(params)) return toolError("tools/call requires a tool name and arguments object.");
  const input = params.arguments ?? {};
  if (!record(input)) return toolError("Tool arguments must be an object.");
  if (params.name === "aidlc_bind_session") {
    if (Object.keys(input).some((key) => key !== "session_key" && key !== "project_dir") || [input.session_key, input.project_dir].some((value) => value !== undefined && (typeof value !== "string" || !value.trim() || value.includes("\0")))) {
      return toolError("Cannot bind Crew session: aidlc_bind_session accepts only optional non-empty session_key and project_dir strings without NUL.\nPaths: selected Crew home.\nRecords: session_key must be Crew-recorded; project_dir is subagent-only.\nNext steps:\n1. Stop and report invalid input; never construct a key.");
    }
    try {
      const key = sessionKey(context.home, input.session_key as string | undefined);
      if (!key) return toolError(BIND_HELP);
      const binding = await bindAndInitialize(context, key, input.project_dir as string | undefined);
      if (input.session_key !== undefined) explicitSessionKey = key;
      return { content: [{ type: "text", text: JSON.stringify(binding) }], isError: false };
    } catch (error) { return toolError(`Cannot bind Crew session: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (params.name === "aidlc_status") {
    if (Object.keys(input).length) return toolError("aidlc_status accepts no arguments.");
    return runEngine(context, ["engine", "status"]);
  }
  if (params.name !== "aidlc_engine") return toolError(`Unknown tool: ${String(params.name)}`);
  const args = input.args;
  if (Object.keys(input).some((key) => key !== "args") || !Array.isArray(args) ||
    !args.length || !args.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0")) ||
    !ENGINE_COMMANDS.includes(args[0])) {
    return toolError(`aidlc_engine args must be a non-empty string array beginning with: ${ENGINE_COMMANDS.join(", ")}.`);
  }
  if (args.some((arg) => arg === "--project-dir" || arg.startsWith("--project-dir="))) {
    return toolError("The project is selected per Crew session; --project-dir is not accepted over MCP.");
  }
  return runEngine(context, args);
}
async function respond(context: Context, version: string, value: unknown) {
  if (!record(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" ||
    (value.id !== undefined && value.id !== null && typeof value.id !== "string" && typeof value.id !== "number")) {
    return rpcError(null, -32600, "Invalid Request");
  }
  // Notifications never receive replies or execute tools.
  if (value.id === undefined) return null;
  const id = value.id as RpcId;
  let result: unknown;
  switch (value.method) {
    case "initialize":
      result = {
        protocolVersion: record(value.params) && typeof value.params.protocolVersion === "string"
          ? value.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "aidlc-kiro-crew", version },
      };
      break;
    case "ping": result = {}; break;
    case "tools/list": result = { tools: TOOLS }; break;
    case "tools/call": result = await callTool(context, value.params); break;
    default: return rpcError(id, -32601, "Method not found");
  }
  return { jsonrpc: "2.0", id, result };
}
async function main(): Promise<void> {
  const context = launchContext(process.argv.slice(2));
  // Negotiation is unbound: App Kit version needs no project or engine lookup.
  const app = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../app.json"), "utf8")) as { version: string };
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(rpcError(null, -32700, "Parse error: expected newline-delimited JSON"))}\n`);
      continue;
    }
    const response = await respond(context, app.version, request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`AI-DLC Kiro Crew MCP: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
