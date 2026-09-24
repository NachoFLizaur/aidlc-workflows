/** App-side setup reuses the ordinary engine config transaction. Crew owns app
 * registration and trust; setup owns five hook IDs, an appended cwd root and
 * local project bindings. No core imports or secondary installer. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCrewStamp } from "../hooks/aidlc-kiro-crew-hook-entry.ts";

type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNED_IDS = ["aidlc-agent-spawn", "aidlc-user-prompt-submit", "aidlc-pre-tool-use", "aidlc-post-tool-use", "aidlc-stop"];
const ROOTS = "subagent_cwd_allowed_roots";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// Installed App Kits cannot import packaging modules; keep these markers shared.
export const BUN = "__AIDLC_KIRO_CREW_BUN__";
export const APP_ROOT = "__AIDLC_KIRO_CREW_APP_ROOT__";
export const CREW_HOME = "__AIDLC_KIRO_CREW_HOME__";
export const crewHome = () => resolve(process.env.KIROCREW_HOME || join(process.env.HOME || homedir(), ".kiro", "crew"));
export const sessionHash = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");
export function projectPath(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Project directory must be absolute: ${path}`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`Project is not a directory: ${path}`);
  return canonical;
}

/** Read the exact engine binding before core work or binding writes. Only lstat
 * ENOENT permits startup. Corrupt/stale records refuse, with no repair, cursor
 * fallback or bypass. BoundAt is nonempty, not parsed. No-follow/nonblocking
 * regular-file reads avoid special files; this is a snapshot, not a lock.
 * The project adapter independently mirrors this contract. */
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

function textFile(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Before mutation, refuse symlinks and changed read snapshots. Exclusive sibling
 * temp plus rename avoids partial JSON, not concurrent writers. No bypass;
 * existing mode is retained. Operators must stop competing config writers. */
function atomicText(path: string, before: string | undefined, after: string): boolean {
  if (before === after) return false;
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, after, { flag: "wx", mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600 });
    if (textFile(path) !== before) throw new Error(`Changed during setup; retry with other writers stopped: ${path}`);
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
  return true;
}

/** Read identity once with a no-follow/nonblocking regular-file and byte bound
 * before strict UTF-8 decoding. Missing/malformed input supplies no identity;
 * callers refuse or warn, without bypass. Crew home ancestors remain trusted. */
export function crewIdentityText(path: string, limit = 4096): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(`Invalid Crew identity record: ${path}`);
    const buffer = Buffer.alloc(limit + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > limit) throw new Error(`Oversize Crew identity record: ${path}`);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } finally { closeSync(fd); }
}
const validCrewKey = (key: string) => !!key.trim() && !/[\0\r\n]/.test(key);

/** Read raw key on line one, optional process-start token on line two, each call
 * before routing. Remove only the final LF. Linux start-token mismatch refuses;
 * unreadable/unknown tokens do not. Malformed records yield no key; no bypass
 * or signature/authentication claim. */
export function crewPidKey(home: string, pid: number | string): string | undefined {
  if (!/^\d+$/.test(String(pid)) || String(pid).includes("\n") || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return undefined;
  try {
    const lines = crewIdentityText(join(home, `session_pid_${pid}.txt`)).replace(/\n$/, "").split("\n");
    if (lines.length > 2 || !validCrewKey(lines[0]) || (lines.length === 2 && !validCrewKey(lines[1]))) return undefined;
    if (lines.length === 2 && process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
        const live = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
        if (live && live !== lines[1]) return undefined;
      } catch { /* Unknown start tokens do not establish a mismatch. */ }
    }
    return lines[0];
  } catch { return undefined; }
}

/** Re-read own session-map keys and valid PID-file keys before explicit binding
 * or retained-key use. Unknown keys refuse before writes. Malformed maps warn
 * and contribute no keys, but valid PID records still count. No cache, inferred
 * newest key or bypass. This corroborates routing, not authentication. */
export function crewRecordedKeys(home: string): Set<string> {
  const keys = new Set<string>();
  const path = join(home, "session_map.json");
  try {
    const map: unknown = JSON.parse(crewIdentityText(path, 4 * 1024 * 1024));
    if (!object(map)) throw new Error("expected an object");
    for (const key of Object.keys(map)) if (validCrewKey(key)) keys.add(key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`Cannot bind Crew session: cannot read Crew session records at ${path}; session-map keys ignored.\n`);
  }
  try {
    for (const file of readdirSync(home)) {
      const match = /^session_pid_(\d+)\.txt$/.exec(file);
      if (!match) continue;
      const key = crewPidKey(home, match[1]);
      if (key !== undefined) keys.add(key);
    }
  } catch { /* Missing/unreadable home contributes no PID keys. */ }
  return keys;
}
export const isRecordedKey = (home: string, key: string): boolean => crewRecordedKeys(home).has(key);

/** Corroborate the key before every bind, including idempotent ones. An identical
 * binding preserves bytes/time; explicit valid project selection may replace a
 * corrupt or different binding. No bypass or cwd fallback; not a trust grant. */
export function bindCrewSession(home: string, project: string, key: string, source?: "project-dir") {
  if (!isRecordedKey(home, key)) throw new Error(`Cannot bind Crew session: session_key is not a Crew-recorded key for this home ${home}; use the exact key shown in ${join(home, "session_pid_<pid>.txt")}.`);
  const projectDir = projectPath(project);
  const keyHash = sessionHash(key);
  const path = join(home, "apps/aidlc/data/bindings", `${keyHash}.json`);
  const before = textFile(path);
  if (before !== undefined) {
    try {
      const old: unknown = JSON.parse(before);
      if (object(old) && old.projectDir === projectDir && typeof old.boundAt === "string" && Number.isFinite(Date.parse(old.boundAt))) {
        if (source && old.source !== source) {
          const changed = atomicText(path, before, `${JSON.stringify({ ...old, source }, null, 2)}\n`);
          return { keyHash, projectDir, path, changed };
        }
        return { keyHash, projectDir, path, changed: false };
      }
    } catch { /* Explicit binding repairs routing only, not configuration. */ }
  }
  const changed = atomicText(path, before, `${JSON.stringify({ projectDir, boundAt: new Date().toISOString(), ...(source ? { source } : {}) }, null, 2)}\n`);
  return { keyHash, projectDir, path, changed };
}

type Span = { start: number; end: number; fields?: Map<string, Span>; items?: Span[] };
/** JSON.parse validates grammar; the second pass locates value spans, preserving
 * foreign bytes. Duplicate keys refuse before writes because selection is
 * ambiguous. No stringify round-trip or bypass applies. */
function jsonSpans(source: string): Span {
  JSON.parse(source);
  let i = 0;
  const whitespace = () => { while (/\s/.test(source[i] ?? "") && i < source.length) i++; };
  const stringEnd = () => {
    i++;
    while (i < source.length) {
      if (source[i] === "\\") { i += 2; continue; }
      if (source[i++] === '"') return;
    }
  };
  const value = (): Span => {
    whitespace();
    const start = i;
    if (source[i] === "{") {
      i++; whitespace();
      const fields = new Map<string, Span>();
      while (source[i] !== "}") {
        whitespace(); const keyStart = i; stringEnd();
        const key = JSON.parse(source.slice(keyStart, i)) as string;
        if (fields.has(key)) throw new Error(`Duplicate JSON key ${key}; repair before setup`);
        whitespace(); i++; fields.set(key, value()); whitespace();
        if (source[i] !== ",") break;
        i++;
      }
      return { start, end: ++i, fields };
    }
    if (source[i] === "[") {
      i++; whitespace(); const items: Span[] = [];
      while (source[i] !== "]") {
        items.push(value()); whitespace();
        if (source[i] !== ",") break;
        i++;
      }
      return { start, end: ++i, items };
    }
    if (source[i] === '"') stringEnd();
    else while (i < source.length && !/[\s,}\]]/.test(source[i])) i++;
    return { start, end: i };
  };
  return value();
}
function document(path: string) {
  const before = textFile(path);
  const source = before ?? "{}\n";
  const span = jsonSpans(source);
  if (!span.fields) throw new Error(`${path} must contain a JSON object; nothing overwritten`);
  return { before, source, span, value: JSON.parse(source) as ObjectValue };
}
const splice = (s: string, start: number, end: number, replacement: string) => s.slice(0, start) + replacement + s.slice(end);
function setField(source: string, node: Span, keys: string[], replacement: string): string {
  if (!node.fields) throw new Error(`${keys.join(".")} parent must be an object`);
  const [key, ...rest] = keys;
  const child = node.fields.get(key);
  if (child) return rest.length ? setField(source, child, rest, replacement) : splice(source, child.start, child.end, replacement);
  for (const part of rest.toReversed()) replacement = `{${JSON.stringify(part)}: ${replacement}}`;
  const fields = [...node.fields.values()];
  const at = fields.at(-1)?.end ?? node.start + 1;
  return splice(source, at, at, `${fields.length ? "," : ""}${JSON.stringify(key)}: ${replacement}`);
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) throw new Error(`${label} must be a list of strings; nothing overwritten`);
  return value;
}
function agent(doc: ObjectValue): ObjectValue {
  if (doc.agent === undefined) return {};
  if (!object(doc.agent)) throw new Error("config agent must be an object; nothing overwritten");
  return doc.agent;
}
function effectiveAgent(home: string) {
  const base = agent(document(join(home, "config.json")).value); const local = agent(document(join(home, "config.local.json")).value);
  return { local, effective: { ...base, ...local } };
}

/** Select a parent project before binding/init writes and on selection reuse.
 * The published env key must equal the resolved subagent key; first-run children
 * need no map entry. Require a canonical stamped project inside effective cwd
 * roots, with local lists replacing base lists. Bad config or identity refuses;
 * no config writes or bypass. This is routing consistency, not authentication.
 * Terminal operator binding without Crew env keeps its recorded-key recovery. */
export function crewSubagentProject(home: string, project: string, key: string): string {
  const caller = process.env.KIROCREW_SESSION_KEY;
  if (!caller?.trim() || /[\0\r\n]/.test(caller) || caller !== key) throw new Error("project_dir requires the caller's recorded Crew session key; no constructed identity or parent-key substitution.");
  if (!caller.startsWith("subagent:") || caller.length === "subagent:".length) throw new Error("conductor sessions select by launch/session-map cwd; project_dir is for subagent sessions");
  const canonical = projectPath(project);
  const stamp = validateCrewStamp(join(canonical, ".kiro-crew/tools/data/aidlc-stamp.json"));
  if (!stamp.ok) throw new Error(`${stamp.reason}; project_dir requires a set-up project.`);
  let roots: string[];
  try {
    const { effective } = effectiveAgent(home);
    roots = strings(effective[ROOTS] === undefined ? [] : effective[ROOTS], `agent.${ROOTS}`);
  } catch (error) { throw new Error(`Cannot read effective agent.${ROOTS} for project_dir: ${error instanceof Error ? error.message : String(error)}`); }
  const allowed = roots.some((root) => {
    const expanded = root === "~" ? process.env.HOME || homedir() : root.startsWith("~/") ? join(process.env.HOME || homedir(), root.slice(2)) : root;
    if (!isAbsolute(expanded)) return false;
    try { const r = relative(realpathSync(expanded), canonical); return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)); } catch { return false; }
  });
  if (!allowed) throw new Error(`project_dir ${canonical} is outside effective agent.${ROOTS}; ask the operator to authorize the project in Crew.`);
  return canonical;
}

/** Read base + replacing local backend selections before CLI writes and collision
 * inspection. Global Codex fails and stops every mutating command; member-DM
 * Codex warns, not a delegated-child selection. Unknown axes fail; Claude/KAS
 * retain their severity. Runtime observations never clear refusal or switch the
 * backend; no bypass. Operators must exclude concurrent config writers: this is
 * a snapshot, not a lock. Core keeps its own reporting twin. */
export function backend(home: string, effective = effectiveAgent(home).effective) {
  const backendSupport = {
    "kiro-cli": "Kiro CLI backend",
    claude: "limited support: conductor and distinct-directory child sessions; file-tool write provenance, native delegation denial and running-child steering are not supported; see guide §Claude backend",
    kas: "not supported by this integration",
    codex: "Codex is not supported as a Kiro Crew backend: Crew does not let AI-DLC intercept Codex tool permissions or identify the calling conversation. Choose Kiro CLI or Claude Code with its documented limits in Crew, then rerun setup and doctor. Version changes do not bypass this refusal. The native Codex CLI harness is unaffected.",
  };
  const axis = (value: unknown, fallback: string) => {
    const selected = value === undefined ? fallback : value;
    const name = selected === "" ? "kiro-cli" : selected;
    // Only the empty string selects Kiro; never normalize unknown values/types.
    const known = selected === "" || selected === "claude" || selected === "kas" || selected === "codex";
    return { name: known ? name as keyof typeof backendSupport : "unrecognized" as const,
      detail: known ? `${name} — ${backendSupport[name as keyof typeof backendSupport]}` : `unrecognized (${JSON.stringify(selected)})` };
  };
  const global = axis(effective.acp_backend, "");
  const member = axis(effective.member_acp_backend, "kas");
  const status: "ok" | "warn" | "fail" = global.name === "codex" || global.name === "unrecognized" || member.name === "unrecognized" ? "fail" : global.name === "kiro-cli" && member.name !== "codex" ? "ok" : "warn";
  const axes = `agent.acp_backend=${global.detail}; agent.member_acp_backend=${member.detail} (member-DM only; not delegated-child selection)`;
  const detail = `${global.name === "codex" ? backendSupport.codex : axes}${global.name === "codex" || member.name === "codex" ? "\n  See docs/guide/harnesses/kiro-crew.md#codex-backend" : ""}`;
  return { global: global.name, member: member.name, status, detail, observations: backendRuntime(home, global.name === "claude" || member.name === "claude") };
}

/** Read the whole provider map before reporting, bounded to 4 MiB/10,000 entries.
 * Reuse resolved config axes; this is observation, not backend admission. KAS
 * shares a provider family, not support. Unknown labels collapse without printing
 * keys; current identity is override/env only, never parent/project inference.
 * Missing current records, malformed data or mixed families warn and keep the
 * conductor's preflight hold. Codex selection or records take blocked precedence
 * over mixed/consistent classification; this row warns, while Backend owns the
 * global-selection failure. No writes, live-process proof or bypass. */
export function crewComposition(home: string, selection: Pick<ReturnType<typeof backend>, "global" | "member">): Row {
  const family = (name: string) => name === "kiro-cli" || name === "kas" ? "kiro-family" : name;
  const providerFamily = (label: string) => label === "acp" || label === "kiro" || label === "kas" ? "kiro-family" : label === "claude_code" ? "claude" : label === "codex" ? "codex" : "unrecognized";
  const current = process.env.AIDLC_SESSION_OVERRIDE || (process.env.KIROCREW_SESSION_KEY ? `crew-${sessionHash(process.env.KIROCREW_SESSION_KEY)}` : undefined);
  const counts = new Map<string, number>(); const families = new Set<string>();
  let entries = 0; let mapIssue = ""; let currentLabel: string | undefined;
  try {
    const map: unknown = JSON.parse(crewIdentityText(join(home, "session_map.json"), 4 * 1024 * 1024));
    if (!object(map)) throw new Error("invalid map");
    const records = Object.entries(map);
    if (records.length > 10_000) throw new Error("entry limit");
    entries = records.length;
    for (const [key, record] of records) {
      const raw = object(record) && typeof record.provider === "string" ? record.provider : "";
      const kind = providerFamily(raw); const label = kind === "unrecognized" ? "unrecognized" : raw;
      counts.set(label, (counts.get(label) ?? 0) + 1); families.add(kind);
      if (current === `crew-${sessionHash(key)}`) currentLabel = label;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") mapIssue = "session_map.json unreadable, malformed or over limits (4 MiB / 10000 entries); composition unverified";
  }
  const providers = counts.size ? `{${[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([label, count]) => `${label} (${count})`).join(", ")}}` : "{}";
  const observed = `observed providers: ${providers}`;
  const recordNote = mapIssue || (entries ? `${entries} session records observed (labels only; not live process verification)` : "no session records observed; classification from config only");
  const currentNote = !current ? "current session not selected" : currentLabel ? `current session provider: ${currentLabel}` : "current session provider unverified (no matching map entry; no parent-backend inference)";
  const notes = `${observed}; ${recordNote}; ${currentNote}; unrecorded children are not verified`;
  if (selection.global === "codex" || selection.member === "codex" || families.has("codex")) return { what: "Crew composition", status: "warn", detail: `blocked: codex selected or recorded; see the Backend row for compatibility; ${notes}` };
  const reasons: string[] = [];
  const known = selection.global !== "unrecognized" && selection.member !== "unrecognized";
  if (known && family(selection.global) !== family(selection.member)) reasons.push(`member-DM selection is a separate axis (member_acp_backend=${selection.member}, agent.acp_backend=${selection.global}); member-DM sessions can dispatch children on ${selection.global}`);
  if (selection.global !== "unrecognized" && [...families].some((kind) => kind !== "unrecognized" && kind !== family(selection.global))) reasons.push(`records-vs-config disagreement: agent.acp_backend=${selection.global}, recorded backends=${[...families].sort().join(", ")}`);
  if (reasons.length) return { what: "Crew composition", status: "warn", detail: `mixed backend configuration: ${reasons.join("; ")}; children follow agent.acp_backend, member DMs follow member_acp_backend; ${notes}` };
  if (!known || mapIssue || families.has("unrecognized") || (current && !currentLabel)) return { what: "Crew composition", status: "warn", detail: `backend composition could not be verified: agent.acp_backend=${selection.global}, member_acp_backend=${selection.member}; compatibility is described in the Backend row; ${notes}` };
  return { what: "Crew composition", status: selection.global === "kiro-cli" ? "ok" : "warn", detail: `${selection.global === "kiro-cli" ? "consistent Kiro CLI configuration" : `consistent backend configuration with limitations: ${selection.global}`}; compatibility is described in the Backend row; ${notes}` };
}

/** Bounded PATH-resolved --version calls and no-follow package metadata reads.
 * No shell, Python import, adapter launch or install. Missing/failed observations
 * stay unknown and never decide admission. This process's PATH is not the live
 * gateway's augmented PATH; no observation bypasses a compatibility limitation. */
function backendRuntime(home: string, claude: boolean): string[] {
  const version = (bin: string | null) => {
    if (!bin) return "unknown";
    try {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
        env: { ...process.env, KIROCREW_HOME: home, KIRO_HOME: join(home, "kiro") } });
      return !r.error && r.status === 0 ? r.stdout.trim() || "unknown" : "unknown";
    } catch { return "unknown"; }
  };
  const crewOutput = version(Bun.which("kirocrew"));
  let crewVersion = /^kirocrew\s+([\w.+-]+)\s*$/m.exec(crewOutput)?.[1] ?? "unknown";
  let distribution = "unknown";
  const packagePath = /(?:^|\s)(\/[^\r\n]*?\/kiro_crew)(?:\/(?:__init__|cli)\.py)?["'):]?(?:\r?$|\s)/m.exec(crewOutput)?.[1];
  if (packagePath) {
    try { crewVersion = /^__version__\s*=\s*["']([^"'\r\n]+)["']/m.exec(crewIdentityText(join(packagePath, "__init__.py"), 64 * 1024))?.[1] ?? crewVersion; } catch { /* Unknown source version. */ }
    try { distribution = /^DISTRIBUTION\s*=\s*["']([^"'\r\n]+)["']/m.exec(crewIdentityText(join(packagePath, "_build_info.py"), 64 * 1024))?.[1] ?? "unknown"; } catch { /* Never infer distribution from version. */ }
  }
  const observations = [`Crew: ${crewVersion}; distribution: ${distribution} (version observation only; does not establish backend compatibility)`];
  if (claude) {
    const override = process.env.CLAUDE_AGENT_ACP_BIN;
    const adapter = Bun.which(override || "claude-agent-acp");
    let adapterVersion = "unknown";
    if (adapter) try {
      const dir = dirname(realpathSync(adapter));
      for (const root of [dir, dirname(dir)]) {
        try {
          const pkg = JSON.parse(crewIdentityText(join(root, "package.json"), 64 * 1024));
          if (pkg.name === "@agentclientprotocol/claude-agent-acp" && typeof pkg.version === "string") { adapterVersion = pkg.version; break; }
        } catch { /* No install or launch to discover package metadata. */ }
      }
    } catch { /* Resolution raced; version remains unknown. */ }
    const cli = Bun.which("claude"); const node = Bun.which("node");
    const oneLine = (s: string) => s.replace(/[\r\n\t]/g, " ").slice(0, 512);
    observations.push(`Claude adapter: ${adapter || "not found (Crew resolver step 6 would fail)"}; source: ${override ? "CLAUDE_AGENT_ACP_BIN" : "PATH"}; package version: ${oneLine(adapterVersion)}`,
      `Claude CLI: ${oneLine(version(cli))}${cli ? ` (${cli})` : " (not found on PATH)"}`,
      `Node: ${oneLine(version(node))}${node ? ` (${node})` : " (not found on PATH)"}; first node on PATH (shebang resolver); Crew's augmented PATH may differ`);
  }
  return observations;
}

/** Inspect project paths before installer, cwd-root or CLI binding writes.
 * Only ENOENT is absent; unsafe/unreadable inspection fails closed. No-follow
 * bounded reads inspect seed/engine markers, never traverse non-directory .claude.
 * availableModels-only JSON is a warning heuristic, not ownership proof. Global
 * ~/.claude is existence-only. Fail stops project/bind; status reports; warnings
 * do not refuse setup. Disabled when neither effective axis is Claude; the CLI
 * also skips inspection when global Codex is blocked, before calling this helper.
 * No bypass or repair; this snapshot does not guard direct MCP/live hook writes.
 * Stop competing writers and recheck. Core maintains an independent twin. */
export function claudeProjectCollision(project: string, selection: Pick<ReturnType<typeof backend>, "global" | "member">, home = process.env.HOME || homedir()): Row {
  const what = "Claude project collision";
  const help = "Missing or invalid project stamps are checked by the bridge: Cannot bind Crew session: Invalid or mismatched stamp. Setup never modifies Claude files.";
  const remediation = "Remediation: move or remove these files (operator action; setup never modifies them), or use a clean project. Not a Kiro CLI concern.";
  if (selection.global !== "claude" && selection.member !== "claude") return { what, status: "ok", detail: selection.global === "kiro-cli" ? "not applicable (backend kiro-cli)" : "not applicable" };
  const classes: string[] = []; const reasons: string[] = []; const paths: string[] = []; const warnings: string[] = [];
  const present = (path: string) => {
    try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const found = (id: string, reason: string, files: string[]) => {
    if (files.length) { classes.push(id); reasons.push(`${reason} (${id})`); paths.push(...files); }
  };
  let inspection = "";
  try {
    const claude = present(join(project, ".claude"));
    if (claude && !claude.isDirectory()) throw new Error(".claude is not a regular directory (symlink or other entry); not followed");
    const local = ".claude/settings.local.json";
    if (present(join(project, local))) {
      let seed = false;
      try { const value: unknown = JSON.parse(crewIdentityText(join(project, local), 64 * 1024)); seed = object(value) && Object.keys(value).every((key) => key === "availableModels"); } catch { /* Unverifiable seeds refuse without repair. */ }
      if (seed) warnings.push("Crew seed present (transient; live session?) — .claude/settings.local.json matches the availableModels-only shape; ownership is not proven. Close the live session and recheck; setup never modifies it.");
      else found("local-settings", "Crew withholds its MCP servers when the project already has Claude settings", [local]);
    }
    found("ambient-instructions", "ambient CLAUDE.md instructions coexist with the conductor prompt; unsupported combination", ["CLAUDE.md", ".claude/CLAUDE.md"].filter((file) => present(join(project, file))));
    found("project-settings", "existing Claude Code configuration", present(join(project, ".claude/settings.json")) ? [".claude/settings.json"] : []);
    found("project-integrations", "existing Claude Code configuration", [".claude/hooks", ".claude/agents", ".claude/skills"].filter((file) => {
      const entry = present(join(project, file));
      return entry && (!entry.isDirectory() || readdirSync(join(project, file)).length > 0);
    }));
    const harness = present(join(project, ".claude/tools/aidlc.ts")) ? [".claude/tools/aidlc.ts"] : [];
    if (present(join(project, ".claude/CLAUDE.md"))) {
      try {
        const text = crewIdentityText(join(project, ".claude/CLAUDE.md"), 64 * 1024);
        if (text.includes("This project uses AI-DLC (AI-Driven Development Life Cycle)") || /^@\.claude\/rules\/aidlc\.md\s*$/m.test(text)) harness.push(".claude/CLAUDE.md");
      } catch { /* Ambient instructions already refuse even without a readable marker. */ }
    }
    found("existing-engine", "existing AIDLC Claude Code harness — two engines", harness);
  } catch { inspection = "Project Claude configuration could not be safely inspected; collision check incomplete."; }
  // Existence only, including dangling symlinks; never read global config.
  try { if (present(join(home, ".claude"))) warnings.push("~/.claude exists — ambient user-level Claude settings/plugins load into every session; not isolated by KIROCREW_HOME (existence only; contents not read)."); }
  catch { warnings.push("~/.claude existence could not be checked; ambient user-level Claude configuration is unverified (contents not read)."); }
  const failed = classes.length > 0 || !!inspection;
  const detail = failed
    ? `Claude project collision: ${classes.join(", ") || "inspection incomplete"} — ${[...reasons, inspection].filter(Boolean).join(" / ")}${paths.length ? `. Files: ${[...new Set(paths)].join(", ")}.` : ""} ${remediation}`
    : warnings.length ? "Claude project collision: none refusing." : "no ambient project Claude configuration detected";
  return { what, status: failed ? "fail" : warnings.length ? "warn" : "ok", detail: [detail, ...warnings].join(" "), fix: help };
}
const hasAppTrust = (effective: ObjectValue): boolean => Array.isArray(effective.apps_trusted) && effective.apps_trusted.includes("aidlc") && Array.isArray(effective.apps_trusted_local) && effective.apps_trusted_local.includes("aidlc");
function appendRoot(doc: ReturnType<typeof document>, roots: string[], project: string): string {
  if (roots.includes(project)) return doc.source;
  const array = doc.span.fields?.get("agent")?.fields?.get(ROOTS);
  if (array?.items) {
    const at = array.items.at(-1)?.end ?? array.start + 1;
    return splice(doc.source, at, at, `${array.items.length ? "," : ""}${JSON.stringify(project)}`);
  }
  return setField(doc.source, doc.span, ["agent", ROOTS], JSON.stringify([...roots, project]));
}

export type MaterializationPaths = { bun: string; appRoot: string; crewHome: string };
type FileProvenance = { portableSha256: string; materializedSha256: string };
export type MaterializationReceipt = MaterializationPaths & {
  schemaVersion: 1; portableInventorySelfHash: string; materializedAt: string;
  files: Record<string, FileProvenance>;
};
const RECEIPT = ".aidlc-materialized.json";
const MATERIALIZED = ["app.json", "mcp.fragment.json"];
// Host-generated metadata and secret are never portable payload or hash inputs.
const HOST_FILES = ["installed.json", ".app_secret"];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const materializationPaths = (home: string, bun = process.execPath): MaterializationPaths => ({ bun: resolve(bun), appRoot: join(resolve(home), "apps/aidlc"), crewHome: resolve(home) });

/** Check typed argv and absolute paths before materialization or registration.
 * Unsafe/unresolved commands throw before Crew calls, with no bypass. This is
 * launch-shape admission, not executable provenance or concurrent-write safety. */
function concrete(value: string) {
  if (/__AIDLC_|\$\{|\/bin\/sh|\0/.test(value)) throw new Error(`Unresolved or unsafe registered command: ${value}`);
  return value;
}
function replacements(paths: MaterializationPaths) {
  for (const path of [paths.bun, paths.appRoot, paths.crewHome]) {
    if (!isAbsolute(path)) throw new Error(`Materialization requires absolute paths: ${path}`);
    concrete(path);
  }
  return [[BUN, paths.bun], [APP_ROOT, paths.appRoot], [CREW_HOME, paths.crewHome]];
}
export function materializeHooks(fragment: unknown, paths: MaterializationPaths): ObjectValue[] {
  if (!Array.isArray(fragment) || fragment.length !== OWNED_IDS.length || !fragment.every((h) => object(h) && OWNED_IDS.includes(String(h.id))) || new Set(fragment.map((h) => h.id)).size !== OWNED_IDS.length) {
    throw new Error("App hook fragment must contain exactly the five owned aidlc IDs");
  }
  const tokens = replacements(paths);
  return fragment.map((hook) => {
    if (typeof hook.command !== "string") throw new Error(`Missing command: ${hook.id}`);
    let command = hook.command;
    // Escape replacements inside existing POSIX quotes, not JSON argv.
    for (const [token, path] of tokens) command = command.replaceAll(token, path.replaceAll("'", "'\\''"));
    concrete(command);
    const events = ["AgentSpawn", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
    const expected = `${quote(paths.bun)} ${quote(join(paths.appRoot, "hooks/aidlc-kiro-crew-hook-entry.ts"))} engine adapter kiro-crew ${events[OWNED_IDS.indexOf(String(hook.id))]}`;
    if (command !== expected) throw new Error(`Unexpected hook command template: ${hook.id}`);
    return { ...hook, command };
  });
}
function materializedMcp(source: string, portable: string, paths: MaterializationPaths): string {
  const tokens = replacements(paths);
  const template = JSON.parse(portable) as ObjectValue;
  if (!object(template.mcpServers) || !Object.keys(template.mcpServers).length) throw new Error("Missing mcpServers");
  for (const [name, value] of Object.entries(template.mcpServers)) {
    if (!object(value) || typeof value.command !== "string") throw new Error(`Invalid MCP server: ${name}`);
    const raw = (input: string) => {
      for (const [token, path] of tokens) input = input.replaceAll(token, path);
      return concrete(input);
    };
    const command = raw(value.command); const args = strings(value.args, `${name}.args`).map(raw);
    if (command !== paths.bun || args[0] !== join(paths.appRoot, "mcp/aidlc-mcp-bridge.ts") || JSON.stringify(args.slice(1)) !== JSON.stringify(["mcp", "--crew-home", paths.crewHome])) throw new Error(`Unexpected MCP command/args: ${name}`);
    for (const [field, replacement] of [["command", command], ["args", args]] as const) {
      source = setField(source, jsonSpans(source), ["mcpServers", name, field], JSON.stringify(replacement));
    }
  }
  concrete(JSON.stringify((JSON.parse(source) as ObjectValue).mcpServers));
  return source;
}
/** Caller admits disposable or identity-verified targets. Prepare both edits
 * before writing; lexical splices preserve non-command bytes. Never register
 * apps or edit hooks here. Hook fragment and inventory stay portable. */
export function materializeApp(targetRoot: string, paths: MaterializationPaths, portableRoot = targetRoot): string[] {
  const edits = MATERIALIZED.map((name) => {
    const path = join(targetRoot, name); const before = readFileSync(path, "utf8");
    return { path, before, after: materializedMcp(before, readFileSync(join(portableRoot, name), "utf8"), paths) };
  });
  return edits.filter(({ path, before, after }) => atomicText(path, before, after)).map(({ path }) => path);
}
type Inventory = { schemaVersion: number; owner: string; files: { path: string; sha256: string }[] };
function inventory(root: string) {
  const raw = readFileSync(join(root, "app-inventory.json"), "utf8"); jsonSpans(raw);
  const value = JSON.parse(raw) as Inventory;
  if (value.schemaVersion !== 1 || value.owner !== "aidlc" || !Array.isArray(value.files)) throw new Error("Invalid portable app inventory");
  const seen = new Set<string>();
  for (const entry of value.files) {
    if (!object(entry) || typeof entry.path !== "string" || !entry.path || isAbsolute(entry.path) || entry.path.split("/").some((p) => !p || p === "." || p === "..") || entry.path.includes("\\") || seen.has(entry.path) || !digest(entry.sha256) || ["data", ...HOST_FILES, RECEIPT].includes(entry.path.split("/")[0])) throw new Error("Invalid or duplicate inventory path/hash");
    seen.add(entry.path);
  }
  const canonical = structuredClone(value); const self = canonical.files.find((f) => f.path === "app-inventory.json");
  if (!self || MATERIALIZED.some((name) => !seen.has(name)) || !seen.has("hooks.fragment.json")) throw new Error("Incomplete app inventory");
  const selfHash = self.sha256; self.sha256 = "";
  if (hash(`${JSON.stringify(canonical, null, 2)}\n`) !== selfHash) throw new Error("Portable inventory self-hash mismatch");
  return { value, raw, selfHash };
}
function payloadHash(root: string, path: string): string {
  let at = root;
  for (const part of path.split("/")) {
    at = join(at, part);
    if (lstatSync(at).isSymbolicLink()) throw new Error(`Symlink payload refused: ${path}`);
  }
  return hash(readFileSync(at));
}
function verifyPortable(root: string, inv: ReturnType<typeof inventory>) {
  for (const file of inv.value.files) if (file.path !== "app-inventory.json" && payloadHash(root, file.path) !== file.sha256) throw new Error(`Portable payload hash mismatch: ${file.path}`);
}
function verifyInstalledEntries(root: string, files: Inventory["files"]) {
  const paths = new Set(files.map((f) => f.path));
  const visit = (dir: string, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!prefix && ["data", ...HOST_FILES, RECEIPT].includes(entry.name)) continue;
      const path = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symlink payload refused: ${path}`);
      if (entry.isDirectory() && files.some((f) => f.path.startsWith(`${path}/`))) visit(join(dir, entry.name), `${path}/`);
      else if (!entry.isFile() || !paths.has(path)) throw new Error(`Unexpected installed payload: ${path}`);
    }
  };
  visit(root);
}
export function readMaterializationReceipt(appRoot: string): MaterializationReceipt | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(appRoot, RECEIPT), "utf8"));
    if (!object(value) || value.schemaVersion !== 1 || !digest(value.portableInventorySelfHash) || typeof value.materializedAt !== "string" || !Number.isFinite(Date.parse(value.materializedAt)) || !object(value.files)) return undefined;
    if (![value.bun, value.appRoot, value.crewHome].every((p) => typeof p === "string" && isAbsolute(p))) return undefined;
    if (Object.keys(value.files).sort().join() !== [...MATERIALIZED].sort().join() || !Object.values(value.files).every((f) => object(f) && digest(f.portableSha256) && digest(f.materializedSha256))) return undefined;
    return value as MaterializationReceipt;
  } catch { return undefined; }
}
export function isInstalledInvocation(sourceRoot: string, appRoot: string): boolean {
  return existsSync(appRoot) && realpathSync(sourceRoot) === realpathSync(appRoot);
}
export type AppClassification = { kind: "absent" | "installed" | "partial"; unexpected: string[] };
/** Read installed.json lifecycle state before mutation. Missing roots or real
 * data-only directories are installable; partial/stray/symlink states refuse
 * without deletion or bypass. This snapshot requires other writers stopped. */
export function classifyApp(appRoot: string): AppClassification {
  let stat: import("node:fs").Stats;
  try { stat = lstatSync(appRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent", unexpected: [] }; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: "partial", unexpected: [appRoot] };
  const entries = readdirSync(appRoot);
  if (entries.includes("installed.json")) return { kind: "installed", unexpected: [] };
  const unexpected = entries.filter((name) => name !== "data" || !lstatSync(join(appRoot, name)).isDirectory() || lstatSync(join(appRoot, name)).isSymbolicLink());
  return { kind: unexpected.length ? "partial" : "absent", unexpected };
}
/** Read portable inventory, receipt and installed bytes before command rewriting
 * or enable. Missing/corrupt/drifted input stops, with no version shortcut or
 * bypass. Installed-source checks establish self-consistency only; apply refuses
 * that source for freshness decisions. */
export function checkAppIdentity(sourceRoot: string, appRoot: string): { matches: boolean; reason: string } {
  try {
    const inv = inventory(sourceRoot); const local = isInstalledInvocation(sourceRoot, appRoot);
    if (!local) verifyPortable(sourceRoot, inv);
    const receipt = readMaterializationReceipt(appRoot);
    if (!receipt || receipt.portableInventorySelfHash !== inv.selfHash) throw new Error("Missing/corrupt receipt or selected portable inventory differs");
    verifyInstalledEntries(appRoot, inv.value.files);
    if (resolve(receipt.appRoot) !== resolve(appRoot) || join(receipt.crewHome, "apps/aidlc") !== resolve(appRoot)) throw new Error("Receipt installation paths differ");
    if (readFileSync(join(appRoot, "app-inventory.json"), "utf8") !== inv.raw) throw new Error("Installed inventory differs");
    for (const file of inv.value.files) {
      if (file.path === "app-inventory.json") continue;
      if (MATERIALIZED.includes(file.path)) {
        const provenance = receipt.files[file.path];
        if (provenance.portableSha256 !== file.sha256 || payloadHash(appRoot, file.path) !== provenance.materializedSha256) throw new Error(`Materialized payload drift: ${file.path}`);
        if (!local) {
          const portable = readFileSync(join(sourceRoot, file.path), "utf8");
          const { bun, appRoot, crewHome } = receipt;
          if (hash(materializedMcp(portable, portable, { bun, appRoot, crewHome })) !== provenance.materializedSha256) throw new Error(`Materialized provenance mismatch: ${file.path}`);
        }
      } else if (payloadHash(appRoot, file.path) !== file.sha256) throw new Error(`Installed payload hash mismatch: ${file.path}`);
    }
    return { matches: true, reason: local ? "Installed self-consistency verified; source freshness not established" : "Payload matches selected portable inventory and receipt" };
  } catch (error) { return { matches: false, reason: error instanceof Error ? error.message : String(error) }; }
}
/** Caller has admitted identity or just installed staging. Preserve bytes/time
 * on identical receipts; atomicText refuses a changed read snapshot. */
export function writeMaterializationReceipt(sourceRoot: string, paths: MaterializationPaths): boolean {
  const inv = inventory(sourceRoot); const files: Record<string, FileProvenance> = {};
  for (const name of MATERIALIZED) files[name] = { portableSha256: inv.value.files.find((f) => f.path === name)!.sha256, materializedSha256: payloadHash(paths.appRoot, name) };
  const old = readMaterializationReceipt(paths.appRoot);
  const receipt: MaterializationReceipt = { schemaVersion: 1, portableInventorySelfHash: inv.selfHash, ...paths, materializedAt: old?.materializedAt ?? new Date().toISOString(), files };
  const path = join(paths.appRoot, RECEIPT); const before = textFile(path);
  if (old && JSON.stringify({ ...old, materializedAt: "" }) === JSON.stringify({ ...receipt, materializedAt: "" })) return atomicText(path, before, before!);
  receipt.materializedAt = new Date().toISOString();
  return atomicText(path, before, `${JSON.stringify(receipt, null, 2)}\n`);
}
export const TRUST_REQUIRED_STOP = `TRUST_REQUIRED_STOP: aidlc requires an operator trust grant before installation or enablement.
Effective agent.apps_trusted AND agent.apps_trusted_local must both include aidlc (config.local.json replaces base lists).
Setup stopped before staging, Crew calls or configuration writes.`;
// Printed for operator review, never executed by setup.
const TRUST_CONFIG_SNIPPET = String.raw`python3 - "$CREW_HOME" <<'PY'
import json, pathlib, sys
home = pathlib.Path(sys.argv[1])
edits = []
for name in ("config.json", "config.local.json"):
    path = home / name
    if path.is_symlink():
        raise SystemExit(f"Stop: inspect symlink {path}")
    if name == "config.local.json" and not path.exists():
        continue
    doc = json.loads(path.read_text()) if path.exists() else {}
    agent = doc.setdefault("agent", {})
    for key in ("apps_trusted", "apps_trusted_local"):
        if name == "config.local.json" and key not in agent:
            continue
        values = agent.setdefault(key, [])
        if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
            raise SystemExit(f"Stop: repair {name} agent.{key}")
        if "aidlc" not in values:
            values.append("aidlc")
    edits.append((path, json.dumps(doc, indent=2) + "\n"))
for path, text in edits:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
PY`;
function trustInstructions(home: string): string {
  return `Operator action: operator-only grant via Settings → Security → Trusted Apps → aidlc (Crew home ${quote(home)}).
For this local App Kit: agent.apps_trusted: ["aidlc"] AND agent.apps_trusted_local: ["aidlc"] (append, preserving other grants).
If the UI/API cannot grant an uninstalled local app, stop Crew and other config writers, review the source package, then run this equivalent config snippet yourself. It appends aidlc in config.json and any overriding local lists; other values are retained, JSON formatting is rewritten.
Never blanket trust; never set apps_allow_third_party. No self-grant: setup does not self-grant or execute this snippet.
CREW_HOME=${quote(home)}
${TRUST_CONFIG_SNIPPET}

Rerun setup trust to check the effective grant before app --apply.`;
}
/** Read replacing config layers on every apply before staging, materialization
 * or any Crew call. Both local-app grants must include aidlc. Missing grants
 * refuse with TRUST_REQUIRED_STOP; malformed config refuses through its parser.
 * No self-grant or bypass. Operators must exclude revocation/concurrent writers;
 * post-registration checks retain a stop if trust changes during installation. */
function requireAppTrust(home: string): void {
  if (!hasAppTrust(effectiveAgent(home).effective)) throw new Error(`${TRUST_REQUIRED_STOP}\n${trustInstructions(home)}`);
}
export const APP_IDENTITY_STOP = `Installed payload outdated or unverified.
Paths: use the same KIROCREW_HOME/KIRO_HOME and THIS setup from the current source package.
Records: preserve data/bindings. Setup will not auto-uninstall or use the HTTP update endpoint.
Next steps:
1. Stop Crew and other config writers.
2. Uninstall aidlc with the same KIROCREW_HOME/KIRO_HOME (NEVER --purge-data; preserve data/bindings).
3. Uninstall revokes trust: re-grant Settings → Security → Trusted Apps → aidlc.
4. Rerun THIS setup app --apply from the current source package; or use a clean dedicated home.`;
export function appRemedyCommand(sourceRoot: string, home: string): string {
  const source = isInstalledInvocation(sourceRoot, join(resolve(home), "apps/aidlc")) ? "<current source package>" : sourceRoot;
  return `${quote(process.execPath)} ${quote(join(source, "setup/aidlc-kiro-crew-setup.ts"))} app --apply --crew-home ${quote(resolve(home))}`;
}
function identityStop(sourceRoot: string, home: string, reason: string): Error {
  return new Error(`${reason}. ${APP_IDENTITY_STOP}\nKIROCREW_HOME=${quote(home)} KIRO_HOME=${quote(join(home, "kiro"))} kirocrew app uninstall aidlc\n${trustInstructions(home)}\nAfter re-granting trust: ${appRemedyCommand(sourceRoot, home)}`);
}
export type RegisteredSpecs = Record<string, ObjectValue>;
/** Inspect host MCP entry and copied conductor immediately after install, before
 * enable, and again after enable. Missing/unsafe/different entries throw without
 * repair or continuation. No disabling flag. */
export function verifyRegisteredSpecs(home: string, paths = materializationPaths(home)): RegisteredSpecs {
  const specs: RegisteredSpecs = {};
  for (const name of ["kirocrew", "aidlc--aidlc-crew"]) {
    const path = join(home, "kiro/agents", `${name}.json`); const doc = document(path).value;
    const server = object(doc.mcpServers) ? doc.mcpServers["aidlc:engine"] : undefined;
    if (!object(server)) throw new Error(`Missing registered aidlc:engine: ${path}; grant trust before installation. Trust may have changed after admission. For a disabled install without a receipt, uninstall → grant → app --apply; do not just retry enable.\n${APP_IDENTITY_STOP}\n${trustInstructions(home)}`);
    concrete(JSON.stringify(server));
    if (server.command !== paths.bun || JSON.stringify(server.args) !== JSON.stringify([join(paths.appRoot, "mcp/aidlc-mcp-bridge.ts"), "mcp", "--crew-home", paths.crewHome])) throw new Error(`Registered MCP command/args differ from final absolute paths: ${path}`);
    specs[name] = server;
  }
  return specs;
}
export type RegistrationStep = { phase: "install" | "enable"; stdout: string; specs: RegisteredSpecs };
/** Classify/admit before registered-command mutation. Staging is disposable and
 * separate from preserved data. No uninstall/update fallback. The caller's
 * runCrew uses the selected home/KIRO_HOME; setup never starts a gateway. */
export function applyApp(sourceRoot: string, home: string, runCrew: (args: string[]) => string, onRegistered?: (step: RegistrationStep) => void): RegistrationStep[] {
  home = resolve(home); const paths = materializationPaths(home); const state = classifyApp(paths.appRoot);
  if (isInstalledInvocation(sourceRoot, paths.appRoot)) throw new Error(`Installed invocation cannot decide source freshness. Run setup app --apply from the current source package: ${appRemedyCommand(sourceRoot, home)}`);
  if (state.kind === "partial") throw new Error(`Partial app state; unexpected entries: ${state.unexpected.join(", ")}. Refusing to delete or register; inspect them or use a clean dedicated home.`);
  if (state.kind === "installed") {
    const identity = checkAppIdentity(sourceRoot, paths.appRoot);
    if (!identity.matches) throw identityStop(sourceRoot, home, identity.reason);
  }
  requireAppTrust(home);
  const inv = inventory(sourceRoot); verifyPortable(sourceRoot, inv);
  materializeHooks(document(join(sourceRoot, "hooks.fragment.json")).value.hooks, paths);
  const steps: RegistrationStep[] = [];
  const register = (phase: RegistrationStep["phase"], args: string[]) => {
    const stdout = runCrew(args); const specs = verifyRegisteredSpecs(home, paths);
    const step = { phase, stdout, specs }; steps.push(step); onRegistered?.(step);
  };
  let staging: string | undefined;
  try {
    if (state.kind === "absent") {
      mkdirSync(dirname(paths.appRoot), { recursive: true });
      staging = mkdtempSync(join(dirname(paths.appRoot), ".aidlc-staging-"));
      for (const file of inv.value.files) {
        const dest = join(staging, file.path); mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(sourceRoot, file.path), dest);
      }
      materializeApp(staging, paths);
      register("install", ["app", "install", staging]);
    } else materializeApp(paths.appRoot, paths, sourceRoot);
    for (const name of MATERIALIZED) concrete(JSON.stringify(document(join(paths.appRoot, name)).value.mcpServers));
    register("enable", ["app", "enable", "aidlc"]);
    if (document(join(paths.appRoot, "installed.json")).value.enabled !== true) throw new Error("Crew did not enable aidlc; inspect registration diagnostics");
    writeMaterializationReceipt(sourceRoot, paths);
    const identity = checkAppIdentity(sourceRoot, paths.appRoot);
    if (!identity.matches) throw identityStop(sourceRoot, home, identity.reason);
    return steps;
  } finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
}

type Row = { status: "ok" | "pending" | "warn" | "fail"; what: string; detail: string; fix?: string };
type Report = { rows: Row[]; changed: string[]; outstandingActions: string[] };
type Options = { command: string; project: string; home: string; runtime?: string; native: boolean; apply: boolean; applyLocal: boolean; stopped: boolean; key?: string; json: boolean };
function parse(argv: string[]): Options {
  const command = argv[0] ?? "status";
  const allowed: Record<string, string[]> = {
    project: ["--project-dir", "--runtime-root", "--native", "--apply-local"],
    hooks: ["--apply", "--gateway-stopped"], app: ["--apply"], trust: [],
    bind: ["--session-key", "--project-dir"], status: ["--project-dir"],
  };
  if (!allowed[command]) throw new Error("Use project | hooks | app | trust | bind | status (each accepts --crew-home and --json)");
  const flags = new Map<string, string>();
  const values = ["--project-dir", "--runtime-root", "--crew-home", "--session-key"];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (![...allowed[command], "--crew-home", "--json"].includes(flag) || flags.has(flag)) throw new Error(`Unknown or repeated flag: ${flag}`);
    if (values.includes(flag)) {
      const val = argv[++i];
      if (!val || val.startsWith("--")) throw new Error(`${flag} requires a value`);
      flags.set(flag, val);
    } else flags.set(flag, "true");
  }
  if (command === "project" && !flags.has("--project-dir")) throw new Error("project requires --project-dir <absolute path>");
  const rawProject = flags.get("--project-dir") || process.env.AIDLC_PROJECT_DIR || process.cwd();
  if (!isAbsolute(rawProject)) throw new Error(`Project directory must be absolute: ${rawProject}`);
  return {
    command, project: rawProject, home: resolve(flags.get("--crew-home") || crewHome()), runtime: flags.get("--runtime-root"),
    native: flags.has("--native"), apply: flags.has("--apply"), applyLocal: flags.has("--apply-local"),
    stopped: flags.has("--gateway-stopped"), key: flags.get("--session-key"), json: flags.has("--json"),
  };
}
function next(o: Options, command: string, project = false) {
  return `bun ${quote(join(APP, "setup/aidlc-kiro-crew-setup.ts"))} ${command} --crew-home ${quote(o.home)}${project ? ` --project-dir ${quote(o.project)}` : ""}`;
}
const add = (report: Report, status: Row["status"], what: string, detail: string, fix?: string) => report.rows.push({ status, what, detail, ...(fix ? { fix } : {}) });
function observeBackend(o: Options, report: Report, effective?: ObjectValue) {
  if (report.rows.some((r) => r.what === "Backend selection")) return;
  const observation = backend(o.home, effective);
  add(report, observation.status, "Backend selection", `${observation.detail}\n  Observations (informational): ${observation.observations.join("\n    ")}`);
  return observation;
}
function installed(project: string): boolean {
  try {
    const stamp = JSON.parse(readFileSync(join(project, ".kiro-crew/tools/data/aidlc-stamp.json"), "utf8"));
    return stamp.schemaVersion === 1 && stamp.distribution === "kiro-crew" && stamp.harnessDir === ".kiro-crew" && existsSync(join(project, "aidlc"));
  } catch { return false; }
}
function exec(command: string, args: string[], o: Options) {
  const result = spawnSync(command, args, { cwd: o.project, env: { ...process.env, KIROCREW_HOME: o.home, KIRO_HOME: join(o.home, "kiro") }, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.map(quote).join(" ")} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}

function configureProject(o: Options, report: Report) {
  o.project = projectPath(o.project);
  const path = join(o.home, "config.json");
  const localPath = join(o.home, "config.local.json");
  // Validate replacing layers before installer/config mutation; base alone
  // never establishes an effective cwd grant. Malformed layers refuse.
  const base = document(path); const local = document(localPath);
  const baseRoots = agent(base.value)[ROOTS];
  const roots = strings(baseRoots === undefined ? [] : baseRoots, `agent.${ROOTS}`);
  const shadow = agent(local.value)[ROOTS];
  const localRoots = shadow === undefined ? undefined : strings(shadow, `config.local.json agent.${ROOTS}`);
  if (!o.native && !o.runtime) throw new Error("project requires --runtime-root <absolute extracted runtime/kiro-crew directory> (or --native)");
  if (o.runtime) {
    o.runtime = projectPath(o.runtime);
    if (!existsSync(join(o.runtime, ".kiro-crew")) || !existsSync(join(o.runtime, "aidlc"))) throw new Error("runtime root must contain .kiro-crew/ and aidlc/");
  }
  const already = installed(o.project);
  const args = ["config", "--project-dir", o.project, ...(o.runtime ? ["--from", o.runtime] : []), "--harness", "kiro-crew", "--mcp", "none", "--yes", "--json"];
  const output = o.native ? exec("aidlc", args, o) : exec(process.execPath, [join(o.runtime!, ".kiro-crew/tools/aidlc.ts"), ...args], o);
  const result: unknown = JSON.parse(output);
  if (!object(result) || result.ok === false || !installed(o.project)) throw new Error(`Ordinary config did not install the Crew project: ${output}`);
  add(report, "ok", "Project configured", `${o.project} (ordinary config transaction completed)`);
  report.changed.push(already ? "Project engine checked/refreshed by ordinary config (existing workflow state retained)." : `Installed project engine .kiro-crew/ and aidlc/ state in ${o.project}.`);
  if (atomicText(path, base.before, appendRoot(base, roots, o.project))) report.changed.push(`Added cwd root ${o.project} to ${path}.`);
  if (localRoots !== undefined && !localRoots.includes(o.project)) {
    const effective = [...localRoots, o.project];
    if (o.applyLocal) {
      if (atomicText(localPath, local.before, appendRoot(local, localRoots, o.project))) report.changed.push(`Added cwd root to ${localPath} (--apply-local).`);
    } else {
      add(report, "warn", "Project authorized as cwd root", `config.local.json REPLACES the base list; required effective agent.${ROOTS}: ${JSON.stringify(effective)}`,
        `KIROCREW_HOME=${quote(o.home)} kirocrew config set --local agent.${ROOTS} ${quote(JSON.stringify(effective))}`);
      return;
    }
  }
  add(report, "ok", "Project authorized as cwd root", "Canonical root present in the effective list; spawn admission re-reads config (watcher polls every 2s).");
}
function ownedHooks(home: string): ObjectValue[] {
  return materializeHooks(document(join(APP, "hooks.fragment.json")).value.hooks, materializationPaths(home));
}
/** Read gateway.lock and run/gateway-<port>.pid immediately before mutation.
 * Any live/unknown marker refuses even with acknowledgement. Missing/dead PIDs
 * cannot prove a free lock; --gateway-stopped remains mandatory. This is an
 * operator promise to exclude all writers, not an automatic gateway lock. */
function gatewayGuard(o: Options) {
  const paths = [join(o.home, "gateway.lock")];
  const run = join(o.home, "run");
  if (existsSync(run)) paths.push(...readdirSync(run).filter((f) => /^gateway-\d+\.pid$/.test(f)).map((f) => join(run, f)));
  for (const path of paths) {
    const raw = textFile(path);
    if (raw === undefined) continue;
    if (!/^\d+\s*$/.test(raw) || Number(raw) <= 1 || process.platform === "win32") throw new Error(`Gateway state unknown at ${path}; refusing hooks edit`);
    try { process.kill(Number(raw), 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; throw new Error(`Cannot exclude a running gateway at ${path}; refusing hooks edit`); }
    throw new Error(`Gateway may be running (PID ${raw.trim()} in ${path}); refusing hooks edit`);
  }
  if (!o.stopped) throw new Error("Cannot prove the gateway is stopped; hooks --apply requires --gateway-stopped acknowledgement");
}
function mergeHooks(o: Options, report: Report) {
  const fix = next(o, "hooks --apply --gateway-stopped");
  const alternative = "Portable hooks.fragment.json is a template, not a runnable registration payload. Use setup hooks --apply --gateway-stopped; do not register the fragment verbatim in the Hooks UI/API.";
  if (!o.apply) { add(report, existsSync(join(o.home, "hooks.json")) ? "warn" : "pending", "Hooks registered", `Preview only. ${alternative}`, fix); return; }
  try {
    const appRoot = materializationPaths(o.home).appRoot; const state = classifyApp(appRoot);
    if (state.kind === "installed") {
      const identity = checkAppIdentity(APP, appRoot);
      if (!identity.matches) throw identityStop(APP, o.home, identity.reason);
    } else if (state.kind === "partial") throw new Error(`Partial app state; unexpected entries: ${state.unexpected.join(", ")}; refusing hooks edit`);
    const hooks = ownedHooks(o.home);
    const path = join(o.home, "hooks.json"); const doc = document(path);
    const items = doc.span.fields?.get("hooks")?.items;
    if (doc.value.hooks !== undefined && !items) throw new Error("hooks.json hooks must be an array");
    let source = doc.source;
    if (!items) source = setField(source, doc.span, ["hooks"], JSON.stringify(hooks));
    else {
      const seen = new Set<string>();
      const edits: { start: number; end: number; text: string }[] = [];
      for (const item of items) {
        const value: unknown = JSON.parse(source.slice(item.start, item.end));
        if (!object(value) || !OWNED_IDS.includes(String(value.id))) continue;
        const id = String(value.id);
        if (seen.has(id)) throw new Error(`Duplicate owned hook id ${id}; repair in the Hooks UI before setup`);
        seen.add(id);
        edits.push({ start: item.start, end: item.end, text: JSON.stringify(hooks.find((h) => h.id === id)) });
      }
      const missing = hooks.filter((h) => !seen.has(String(h.id)));
      if (missing.length) {
        const at = items.at(-1)?.end ?? doc.span.fields!.get("hooks")!.start + 1;
        edits.push({ start: at, end: at, text: `${items.length ? "," : ""}${missing.map((h) => JSON.stringify(h)).join(",")}` });
      }
      for (const edit of edits.sort((a, b) => b.start - a.start)) source = splice(source, edit.start, edit.end, edit.text);
    }
    gatewayGuard(o);
    if (atomicText(path, doc.before, source)) report.changed.push(`Merged five aidlc-owned hook IDs into ${path}; foreign entries and keys untouched.`);
    add(report, "ok", "Hooks registered", "Five owned entries match the materialized app expectation on disk; start Crew to load them.");
  } catch (error) {
    add(report, "fail", "Hooks registered", `${error instanceof Error ? error.message : error}. ${alternative}`, fix);
  }
}
function appReady(o: Options): boolean {
  const meta = document(join(o.home, "apps/aidlc/installed.json")).value;
  return meta.enabled === true && existsSync(join(o.home, "apps/aidlc/app.json")) && existsSync(join(o.home, "kiro/agents/aidlc--aidlc-crew.json"));
}
function registerApp(o: Options, report: Report) {
  const remedy = appRemedyCommand(APP, o.home);
  if (o.apply && isInstalledInvocation(APP, materializationPaths(o.home).appRoot)) throw new Error(`Installed invocation cannot decide source freshness. Run setup app --apply from the current source package: ${remedy}`);
  if (!o.apply || !Bun.which("kirocrew")) {
    if (o.apply) requireAppTrust(o.home);
    add(report, !o.apply && classifyApp(materializationPaths(o.home).appRoot).kind === "absent" ? "pending" : "warn", "App installed+enabled", o.apply ? "kirocrew is not on PATH; run setup after installing Crew." : "Instructions only; setup materializes before install/enable. Project setup and trust are separate.", remedy);
    return;
  }
  if (!existsSync(join(APP, "app.json"))) throw new Error(`No app.json in ${APP}; run the emitted App Kit setup`);
  applyApp(APP, o.home, (args) => {
    const stdout = exec("kirocrew", args, o);
    // Record completed host writes even if subsequent verification refuses.
    report.changed.push(`app ${args[1]} ran. ${stdout.trim()}`);
    return stdout;
  }, (step) => {
    report.changed.push(`${step.phase}: verified concrete registered MCP in kirocrew.json and aidlc--aidlc-crew.json.`);
  });
  add(report, "ok", "App installed+enabled", "Payload identity, receipt, enabled metadata and both registered MCP specs verified (does not verify a live workflow).");
}
function trust(o: Options, report: Report) {
  const { effective } = effectiveAgent(o.home); const trusted = hasAppTrust(effective);
  add(report, trusted ? "ok" : "pending", "Trust granted",
    `setup trust prints instructions only; does not grant. Effective trust: ${trusted ? "ok" : "pending"}; agent.apps_trusted: ${JSON.stringify(effective.apps_trusted ?? [])}; agent.apps_trusted_local: ${JSON.stringify(effective.apps_trusted_local ?? [])}.\n${trustInstructions(o.home)}`,
    trusted ? undefined : "Grant aidlc yourself using the instructions above, then rerun setup trust to check the effective state.");
}
function status(o: Options, report: Report) {
  const project = existsSync(o.project) ? projectPath(o.project) : o.project;
  // Read-only readiness: absent setup is pending; invalid/stale state warns.
  // Observations never grant startup admission or waive doctor failures.
  const row = (ok: boolean, what: string, detail: string, fix: string, pending = false) => {
    if (!report.rows.some((r) => r.what === what)) add(report, ok ? "ok" : pending ? "pending" : "warn", what, detail, ok ? undefined : fix);
  };
  row(installed(project), "Project configured", project, `${next(o, "project", true)} --runtime-root '<absolute runtime/kiro-crew>'`, !existsSync(join(project, ".kiro-crew")));
  const { local, effective } = effectiveAgent(o.home);
  const roots = strings(effective[ROOTS] === undefined ? [] : effective[ROOTS], ROOTS);
  const authorized = roots.some((root) => {
    const expanded = root === "~" ? process.env.HOME || homedir() : root.startsWith("~/") ? join(process.env.HOME || homedir(), root.slice(2)) : root;
    if (!isAbsolute(expanded)) return false;
    try { const r = relative(realpathSync(expanded), project); return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)); } catch { return false; }
  });
  row(authorized, "Project authorized as cwd root", `Effective agent.${ROOTS}: ${JSON.stringify(roots)}`, `${next(o, "project", true)} --runtime-root '<absolute runtime/kiro-crew>'${local[ROOTS] !== undefined ? " --apply-local" : ""}`, effective[ROOTS] === undefined || (!installed(project) && local[ROOTS] === undefined));
  const hooks = document(join(o.home, "hooks.json")).value.hooks;
  const expected = ownedHooks(o.home);
  row(Array.isArray(hooks) && expected.every((h) => hooks.filter((actual) => object(actual) && actual.id === h.id && Object.keys(h).every((key) => actual[key] === h[key])).length === 1),
    "Hooks registered", "Disk configuration only; does not verify live hook delivery.", next(o, "hooks --apply --gateway-stopped"), hooks === undefined || (Array.isArray(hooks) && !hooks.some((h) => object(h) && OWNED_IDS.includes(String(h.id)))));
  const appRoot = materializationPaths(o.home).appRoot;
  const absentApp = classifyApp(appRoot).kind === "absent";
  const identity = checkAppIdentity(APP, appRoot);
  let registered = false;
  try { verifyRegisteredSpecs(o.home); registered = appReady(o); } catch { /* Report, never repair. */ }
  row(registered && identity.matches, "App installed+enabled", absentApp ? "Not installed; setup materializes before install/enable." : `Expected conductor: ${join(o.home, "kiro/agents/aidlc--aidlc-crew.json")}. ${identity.reason}`, appRemedyCommand(APP, o.home), absentApp);
  const trusted = hasAppTrust(effective);
  const noTrust = [effective.apps_trusted, effective.apps_trusted_local].every((v) => v === undefined || (Array.isArray(v) && v.every((item) => typeof item === "string") && !v.includes("aidlc")));
  row(trusted, "Trust granted", "Local-app grant and local-consent marker (never blanket trust).", `Operator action: Settings → Security → Trusted Apps → aidlc (Crew home ${quote(o.home)}).`, noTrust);
  const bindings = join(o.home, "apps/aidlc/data/bindings");
  let corruptBinding = false;
  const bound = existsSync(bindings) && readdirSync(bindings).some((f) => {
    if (!/^[a-f0-9]{64}\.json$/.test(f)) return false;
    try {
      const b = document(join(bindings, f)).value;
      if (typeof b.projectDir !== "string" || !isAbsolute(b.projectDir) || typeof b.boundAt !== "string" || !Number.isFinite(Date.parse(b.boundAt))) { corruptBinding = true; return false; }
      return b.projectDir === project;
    } catch { corruptBinding = true; return false; }
  });
  row(bound, "Conversation bound", bound ? "At least one binding targets this project; current dashboard slot is not verified by status." : corruptBinding ? "Corrupt binding found; preserve and inspect it before explicitly rebinding." : "No binding to this project; select it in the dashboard, then the first aidlc_status can auto-bind using Crew identity and a validated project selection.", corruptBinding ? `${next(o, "bind", true)} --session-key '<exact key from <home>/session_pid_<pid>.txt line 1>'` : "Select this project in a new dashboard conversation and message `aidlc-crew`; the first `aidlc_status` binds automatically", !corruptBinding);
  observeBackend(o, report, effective);
}
const SETUP_STEPS: Record<string, number> = { "Project configured": 1, "Project authorized as cwd root": 1, "Trust granted": 2, "App installed+enabled": 3, "Hooks registered": 4, "Conversation bound": 5 };
const setupStep = (row: Row): number => SETUP_STEPS[row.what] ?? 6;
function print(report: Report, json: boolean) {
  const ordered = report.rows.toSorted((a, b) => setupStep(a) - setupStep(b));
  report.outstandingActions = [...new Set(ordered.filter((r) => r.status !== "ok" && r.fix).map((r) => r.fix!))];
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const row of ordered) console.log(`${row.status === "pending" ? `Pending — step ${setupStep(row)}:` : row.status.padEnd(5)} ${row.what}  ${row.detail}`);
    console.log(`\nWhat changed\n${report.changed.length ? report.changed.map((s) => `- ${s}`).join("\n") : "- Nothing."}`);
    console.log(`\nOrdered next steps\n${report.outstandingActions.length ? report.outstandingActions.map((s, i) => `${i + 1}. ${s}`).join("\n") : "- None for this step."}`);
  }
}
function main() {
  const report: Report = { rows: [], changed: [], outstandingActions: [] };
  let json = process.argv.includes("--json");
  try {
    const o = parse(process.argv.slice(2)); json = o.json;
    // Read effective config before any setup write or collision inspection,
    // including app/hooks --apply. Global Codex exits 1 without switching config;
    // only status continues read-only diagnostics. No bypass.
    const effective = effectiveAgent(o.home).effective;
    if (effective.acp_backend === "codex" && o.command !== "status") {
      observeBackend(o, report, effective);
      print(report, json); process.exitCode = 1; return;
    }
    if (["project", "status", "bind"].includes(o.command)) {
      // Observe before installer, cwd-root or binding writes; status stays read-only.
      const selection = observeBackend(o, report, effective)!;
      const collision: Row = selection.global === "codex"
        ? { what: "Claude project collision", status: "ok", detail: "not evaluated (global codex blocked; see Backend row)" }
        : claudeProjectCollision(o.project, selection);
      report.rows.push(collision);
      if (o.command === "status") report.rows.push(crewComposition(o.home, selection));
      if (collision.status === "fail" && o.command !== "status") {
        print(report, json); process.exitCode = 1; return;
      }
    }
    switch (o.command) {
      case "project": configureProject(o, report); status(o, report); break;
      case "hooks": mergeHooks(o, report); break;
      case "app": registerApp(o, report); break;
      case "trust": trust(o, report); break;
      case "bind": {
        if (o.key === undefined) throw new Error(`Cannot bind Crew session: bind requires --session-key with the exact key shown in ${join(o.home, "session_pid_<pid>.txt")}.`);
        // Crew sessions use the subagent selector; terminal recovery stays separate.
        if (process.env.KIROCREW_SESSION_KEY !== undefined) {
          try { o.project = crewSubagentProject(o.home, o.project, o.key); }
          catch (error) { throw new Error(`Cannot bind Crew session: ${error instanceof Error ? error.message : String(error)}`); }
        }
        const binding = bindCrewSession(o.home, o.project, o.key, process.env.KIROCREW_SESSION_KEY === undefined ? undefined : "project-dir");
        if (binding.changed) report.changed.push(`Wrote ${binding.path}.`);
        add(report, "ok", "Conversation bound", `${binding.keyHash} → ${binding.projectDir}`);
        break;
      }
      case "status": status(o, report); break;
    }
    observeBackend(o, report);
  } catch (error) { add(report, "fail", "Setup stopped", `${error instanceof Error ? error.message : String(error)}; correct the named condition, then retry`, `bun ${quote(fileURLToPath(import.meta.url))} ${process.argv.slice(2).map(quote).join(" ")}`); }
  print(report, json);
  if (report.rows.some((r) => r.status === "fail")) process.exitCode = 1;
}
if (import.meta.main) main();
