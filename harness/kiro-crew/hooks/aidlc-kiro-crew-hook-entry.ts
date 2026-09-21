/**
 * Resolve the raw parent session key and project binding, validate its stamp,
 * then import the project adapter with the original stdin bytes. Explicit
 * absolute project pins bypass only binding lookup, not identity/stamp checks.
 * Gateway cwd, payload cwd and inherited sessions are never routing oracles.
 * Only an absent binding opts out. Corrupt identity, routing, stamp or import
 * fails guarded PreToolUse with exit 2; advisory events report at exit 0.
 * No adapter override or disable flag exists. Bindings are trusted setup state,
 * not authenticated grants. Shell-only unbound use has no hook protection.
 * Bun remains required with a native engine. Permission-path denial can block;
 * backend-start notifications are advisory and child delivery is not guaranteed.
 */
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Read the selected project's regular stamp before env/cwd changes or import.
 * Admit exactly four flat literal fields, with no escapes, duplicate fields or
 * multiline quotes. Invalid identity stops guarded calls, without a bypass.
 * This is identity validation, not authentication against a stamp/engine writer.
 * Readable regular-file symlink targets match the shell launcher's policy. */
export function validateCrewStamp(path: string): { ok: true; version: string } | { ok: false; reason: string } {
  const invalid = (detail: string): { ok: false; reason: string } => ({
    ok: false, reason: `Invalid or mismatched stamp at ${path}: ${detail}`,
  });
  let source: string;
  try {
    if (!statSync(path).isFile()) return invalid("expected a readable regular file");
    accessSync(path, constants.R_OK);
    source = readFileSync(path, "utf8");
  } catch { return invalid("missing or unreadable regular file"); }
  let compact = "";
  let quoted = false;
  for (const line of source.split("\n")) {
    for (const char of line) {
      if (char === "\\") return invalid("backslash escapes are forbidden");
      if (char === '"') quoted = !quoted;
      else if (!quoted && /[ \t\r\v\f]/.test(char)) continue;
      compact += char;
    }
    if (quoted) return invalid("quoted string crosses a physical line or is unterminated");
  }
  if (!compact.startsWith("{") || !compact.endsWith("}")) return invalid("expected one flat object");
  const seen = new Set<string>();
  let version = "";
  for (const field of compact.slice(1, -1).split(",")) {
    const token = /^"([^"]+)":(1|"[^"]*")$/.exec(field);
    if (!token) return invalid("malformed flat field or nonliteral value");
    const [, key, value] = token;
    if (seen.has(key)) return invalid(`duplicate field ${key}`);
    seen.add(key);
    switch (key) {
      case "schemaVersion":
        if (value !== "1") return invalid("schemaVersion must be the numeric literal 1");
        break;
      case "distribution":
        if (value !== '"kiro-crew"') return invalid("distribution must be kiro-crew");
        break;
      case "harnessDir":
        if (value !== '".kiro-crew"') return invalid("harnessDir must be .kiro-crew");
        break;
      case "frameworkVersion":
        if (!/^"[0-9a-z.-]+"$/.test(value)) return invalid("frameworkVersion must contain only [0-9a-z.-] and be nonempty");
        version = value.slice(1, -1);
        break;
      default: return invalid(`unknown field ${key}`);
    }
  }
  if (seen.size !== 4) return invalid("missing required field");
  return { ok: true, version };
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const EVENTS = new Set(["AgentSpawn", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);

// Capture only named host variables, never the credential-bearing environment.
export const CAPTURE_ENV_KEYS = [
  "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "HOME", "HOMEDRIVE", "HOMEPATH",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "KIROCREW_HOME",
  "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_DIR", "SSL_CERT_FILE",
  "NO_PROXY", "no_proxy", "KIROCREW_HOOK_EVENT", "KIROCREW_HOOK_CONTEXT",
] as const;

/** Sanitize decoded JSON tokens before diagnostic persistence, preserving input
 * shape and whitespace. Hash known session keys before credential redaction.
 * User names come from userInfo and home basenames; missing/short/unknown names
 * disable only that literal replacement. This is hygiene, not a secret detector
 * or authorization boundary; the forwarded input remains untouched. */
export function sanitizeCapture(raw: string, home: string, env: NodeJS.ProcessEnv, sessionKeys: string[], username: string): string {
  const usernames = [...new Set([username, basename(env.HOME ?? ""), basename(env.USERPROFILE ?? "")]
    .filter((name) => name.length >= 3 && name !== "unknown"))].sort((a, b) => b.length - a.length);
  const clean = (source: string) => {
    let value = source;
    for (const key of sessionKeys.filter(Boolean)) value = value.split(key).join(`sha256:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`);
    for (const [path, label] of [[home, "<home>"], [env.HOME, "<HOME>"], [env.USERPROFILE, "<HOME>"]] as const) {
      if (path) value = value.split(path).join(label);
    }
    for (const name of usernames) value = value.split(name).join("<user>");
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>")
      .replace(/(token|secret|password|api[_-]?key|authorization|bearer|cookie)[^\s"']{0,3}[:=]\s*\S+/gi, "<redacted>")
      .replace(/AKIA[0-9A-Z]{16}/g, "<redacted>")
      .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<redacted>")
      .replace(/sk-[A-Za-z0-9]{20,}/g, "<redacted>");
  };
  const fields = raw.replace(/("(?:[^"\\]|\\.)*"\s*:\s*)("(?:[^"\\]|\\.)*")/g, (match, prefix: string, token: string) => {
    try {
      const key = JSON.parse(prefix.slice(0, prefix.lastIndexOf(":")).trim()) as string;
      if (/(?:token|secret|password|api[_-]?key|authorization|bearer|cookie)/i.test(key)) return `${prefix}"<redacted>"`;
      return `${prefix}${JSON.stringify(clean(JSON.parse(token)))}`;
    } catch { return match; }
  });
  return fields.split(/("(?:[^"\\]|\\.)*")/g).map((part, index) => {
    if (index % 2 === 0) return clean(part);
    try { return JSON.stringify(clean(JSON.parse(part))); } catch { return clean(part); }
  }).join("");
}

/** Before import/forwarding, check explicit absolute Crew home, owned data and
 * a no-follow regular enable flag. Missing/unsafe flags disable capture only.
 * Directories must be owned nonsymlink directories; new files use exclusive
 * 0600 and directories 0700. Ancestors remain trusted installation state.
 * Failure reports a fixed note after the adapter verdict, never changes exit
 * status or exposes raw errors. No environment enable switch or guard bypass. */
function captureHook(input: string, args: string[]): boolean {
  const home = process.env.KIROCREW_HOME;
  if (!home || !isAbsolute(home) || !EVENTS.has(args[3])) return false;
  let flag: number | undefined;
  let output: number | undefined;
  try {
    const data = join(home, "apps/aidlc/data");
    const ownedDirectory = (path: string) => {
      const info = lstatSync(path);
      if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error("unowned capture directory");
    };
    try {
      ownedDirectory(data);
      const path = join(data, "capture-hooks.enabled");
      if (!lstatSync(path).isFile()) return false;
      flag = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(flag);
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const sessionKeys = [...input.matchAll(/("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")/g)]
      .flatMap((match) => /^(?:parent_session_key|session_key)$/.test(JSON.parse(match[1])) ? [JSON.parse(match[2]) as string] : []);
    let payload: unknown;
    try { payload = JSON.parse(input); } catch { /* Ordinary entry still refuses malformed input. */ }
    const presence = !object(payload) || !Object.hasOwn(payload, "tool_input") ? "omitted"
      : payload.tool_input === null ? "null" : object(payload.tool_input) ? "object" : "other";
    const username = userInfo().username;
    const safe = (value: string) => sanitizeCapture(value, home, process.env, sessionKeys, username);
    const date = new Date().toISOString();
    const env = Object.fromEntries(CAPTURE_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      if (value === undefined) return [];
      const sanitized = safe(value);
      return [[key, key === "KIROCREW_HOOK_CONTEXT" ? sanitized.slice(0, 200) : sanitized]];
    }));
    const capture = {
      schemaVersion: 1, event: args[3], argv: args.map(safe), stdinRaw: safe(input),
      stdinPresence: { tool_input: presence }, env,
      provenance: { date, crewVersion: null, home: "<redacted>", counts: null, redactionApplied: true },
    };
    const directory = join(data, "captures");
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    ownedDirectory(directory);
    output = openSync(join(directory, `${args[3]}-${date}-${process.pid}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(output, `${JSON.stringify(capture, null, 2)}\n`);
    return false;
  } catch { return true; }
  finally {
    if (flag !== undefined) try { closeSync(flag); } catch { /* best effort */ }
    if (output !== undefined) try { closeSync(output); } catch { /* best effort */ }
  }
}

// The project adapter cannot be imported until routing is validated. Mirror its
// early read aliases and reviewer identities; unknown/MCP tools stay guarded.
function guardedTool(payload: JsonObject): boolean {
  if (typeof payload.agent_role === "string" &&
    /^aidlc-(?:crew-)?(architecture-reviewer|product-lead)-agent$/.test(payload.agent_role)) return true;
  const name = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const tool = ["fs_read", "read", "read_file", "read_files"].includes(name) ? "Read" : name;
  return !["Read", "Glob", "Grep", "file_search", "grep_search", "thinking", "WebFetch", "WebSearch"].includes(tool);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const home = process.env.KIROCREW_HOME || join(process.env.HOME || homedir(), ".kiro", "crew");
  const bindings = join(home, "apps", "aidlc", "data", "bindings");
  let bindingPath = join(bindings, "<sha256(parent_session_key)>.json");
  let guarded = [args[3], process.env.KIROCREW_HOOK_EVENT].includes("PreToolUse");
  let captureFailed = false;
  try {
    const input = readFileSync(0, "utf8");
    captureFailed = captureHook(input, args);
    const payload: unknown = JSON.parse(input);
    if (!object(payload)) throw new Error("malformed hook JSON: expected an object");
    const key = text(payload.parent_session_key) && !payload.parent_session_key.includes("\0")
      ? createHash("sha256").update(payload.parent_session_key, "utf8").digest("hex") : undefined;
    if (key) bindingPath = join(bindings, `${key}.json`);
    const event = text(payload.hook_event_name) ? payload.hook_event_name : process.env.KIROCREW_HOOK_EVENT || args[3] || "";
    const names = [args[3], payload.hook_event_name, process.env.KIROCREW_HOOK_EVENT];
    guarded = names.includes("PreToolUse");
    if (args[0] !== "engine" || args[1] !== "adapter" || args[2] !== "kiro-crew" ||
      !EVENTS.has(event) || names.some((name) => name !== undefined && name !== event)) {
      throw new Error("unknown or conflicting hook event/adapter route");
    }
    guarded = event === "PreToolUse" && guardedTool(payload);
    if (!key) throw new Error("missing parent_session_key");
    let project: unknown = process.env.AIDLC_PROJECT_DIR;
    if (project === undefined) {
      if (!isAbsolute(home)) throw new Error("Crew home must be absolute; gateway cwd is not a fallback");
      try { lstatSync(bindingPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        process.stderr.write(`AI-DLC Kiro Crew hook entry: not participating; absent project binding ${bindingPath}; gateway cwd is not a fallback.\n`);
        return 0;
      }
      let binding: unknown;
      try { binding = JSON.parse(readFileSync(bindingPath, "utf8")); }
      catch { throw new Error("unreadable or malformed project binding"); }
      if (!object(binding) || !text(binding.boundAt) || !Number.isFinite(Date.parse(binding.boundAt))) {
        throw new Error("invalid project binding timestamp/schema");
      }
      project = binding.projectDir;
    }
    if (!text(project) || !isAbsolute(project)) throw new Error("project binding/pin must name an absolute directory");
    if (!statSync(project).isDirectory()) throw new Error("bound project is not a directory");
    const projectDir = resolve(project);
    const stamp = validateCrewStamp(join(projectDir, ".kiro-crew/tools/data/aidlc-stamp.json"));
    if (!stamp.ok) throw new Error(stamp.reason);
    // One-shot pins precede import; never inherit a foreign native engine.
    process.env.AIDLC_PROJECT_DIR = projectDir;
    process.env.AIDLC_SESSION_OVERRIDE = `crew-${key}`;
    process.env.AIDLC_HARNESS_DIR = ".kiro-crew";
    process.env.AIDLC_HARNESS_NAME = "kiro-crew";
    delete process.env.AIDLC_COMPILED_EXECUTABLE;
    process.chdir(projectDir);
    const adapter = join(projectDir, ".kiro-crew/hooks/aidlc-kiro-crew-adapter.ts");
    try {
      const mod = await import(pathToFileURL(adapter).href);
      if (typeof mod.run !== "function") throw new Error("adapter does not export run(target, input, extraArgs)");
      return await mod.run(event, input, args.slice(4));
    } catch (error) {
      throw new Error(`adapter ${adapter} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    process.stderr.write(`AI-DLC Kiro Crew hook entry: ${error instanceof Error ? error.message : "hook failed"}; binding ${bindingPath}; run project setup for a missing or invalid engine. For a corrupt binding, preserve and inspect it, then run setup bind with the raw parent_session_key and selected project; retry aidlc_bind_session in the MCP process. Gateway cwd is never a fallback.\n`);
    return guarded ? 2 : 0;
  } finally {
    if (captureFailed) process.stderr.write("AI-DLC Kiro Crew hook capture unavailable; hook outcome unchanged.\n");
  }
}

if (import.meta.main) {
  const code = await main();
  // Finalize both streams before forced exit so buffered adapter output survives.
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise<void>((done, reject) => { stream.end((error?: Error | null) => error ? reject(error) : done()); })
  ));
  process.exit(code);
}
