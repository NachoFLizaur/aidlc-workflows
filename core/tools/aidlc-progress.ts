/**
 * Observe-only progress reader — schemaVersion 1 contract for CLI/shim/page.
 * API: readProgress({projectDir, space?, intent?}): Promise<ProgressResult>.
 * Reader has no environment/cursor selection, writer imports, recovery or subprocesses.
 * runProgressCli(argv) is the JSON-only in-process dispatcher entry (see below).
 *
 * DTO: generatedAt is ISO UTC; project.dir is absolute; project.stamp is the
 * validated four-field project installation stamp or null when absent. intents always enumerates
 * ALL spaces, with canonical uuid (dirName for an orphan record), display slug and
 * eligibility/reason. Only in-flight/active/in-progress records are eligible.
 * Explicit intent requires space and matches id first, then a unique slug in
 * that space; space alone limits auto-selection, never the returned census.
 * No eligible records => empty; several => selection-required; selected exists
 * ONLY for ok. Failure => unavailable (I/O, missing source, limits, unsafe kind,
 * changing snapshot) or error (invalid input/schema), with error.code/message.
 * Consumers MUST branch on state, never render failure as zero progress.
 *
 * selected: identity, optional description (Project), scope/status, phases
 * [{name, stages[{slug,state,gate?{kind,ageMs?}}], status}], totals
 * {completed,total,skipped}, activeStage? (slug), blockers/unattributedBlockers
 * [{kind,ref}], backend {asRecorded,conflict,source?,codexAssociated?{source}},
 * ledger {outstanding,settled} (PROJECT-wide numeric counts). Gates carry age
 * only when causally derivable; [?] uses organic gate opens, [R] gate rejection.
 * Backend is historical/manual, NOT live identity/admission: absent => null;
 * disagreement => unknown+conflict; stored codex/blocked => codex plus provenance
 * (codex wins the display label even on conflict). source is project-binding.
 *
 * Bounds (per invocation, no overrides): file <= 1 MiB; total bytes <= 16 MiB;
 * entries <= 2,000/directory and <= 10,000 overall; intents <= 500 overall;
 * graph/state/grid stages <= 200 each; ledger entries <= 1,000 overall (all
 * three arrays); bindings <= 1,000; audit blocks <= 10,000; scopes <= 500.
 * Only selected-intent state/audit and project registries/sessions are read.
 * Compiled plan inputs are project-local .kiro-crew/tools/data/{stage-graph,
 * scope-grid}.json; absent/malformed inputs fail, never rebuild or infer a plan.
 * Enabled graph stages + scope EXECUTE slice + state suffix overrides determine
 * totals, including absent checkboxes as pending; no Bolt/unit trees are read.
 * Pending decisions mirror hasPendingDecision's default (no afterEvent/unit/
 * workflowAttempt) chronological DECISION_RECORDED/QUESTION_ANSWERED fold over
 * the selected record's sorted audit/*.md shards, not space or worktree audits.
 * No partial audit fallback: an unreadable/over-budget present shard fails.
 *
 * Guard oracle: lexical project containment + lstat path-chain/kind, checked
 * before each read; all encountered symlinks (including internal links) and
 * special kinds are refused. Open only lstat-regular files with NOFOLLOW and
 * NONBLOCK, compare descriptor/path identity and size/mtime/ctime after reading;
 * directory enumeration is incremental and bounded. Missing optional roots
 * mean no records; present malformed sources never mean empty. Limits/guards
 * cannot be disabled; failures prevent an ok snapshot. This is a same-user
 * read-only application guarantee, NOT a sandbox or a transactional snapshot
 * against hostile concurrent ancestor replacement. Nothing is ever mutated.
 *
 * Attribution oracle: validated same-session binding, exact space+record id or
 * dirName (never display slug), and dispatchedAt strictly AFTER boundAt, read
 * together in this invocation. Entries at/before a rebind, missing bindings,
 * and bindings to other intents remain project-level/unattributed. No stage-
 * name or ledger.intentId inference; no disabling flag or admission semantics.
 */
import { constants, lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AIDLC_VERSION } from "./aidlc-version.ts";

export const PROGRESS_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024,
  directoryEntries: 2000, totalEntries: 10000, intents: 500, stages: 200,
  ledgerEntries: 1000, bindings: 1000, auditBlocks: 10000, scopes: 500,
});
export type ProgressStageState = "pending" | "in-progress" | "awaiting-approval" | "revising" | "completed" | "skipped";
export type ProgressIntent = {
  space: string; id: string; displayName: string; eligible: boolean;
  reason?: "archived" | "completed" | "registry-only" | "orphan" | "unsupported-status";
};
export type ProgressStamp = {
  schemaVersion: 1; distribution: "kiro-crew"; harnessDir: ".kiro-crew"; frameworkVersion: string;
};
export type ProgressBlocker = {
  kind: "awaiting-approval" | "revising" | "pending-decision" | "dispatch-outstanding"; ref: string;
};
export type ProgressStage = {
  slug: string; state: ProgressStageState; gate?: { kind: "[?]" | "[R]"; ageMs?: number };
};
export type ProgressBackend = {
  asRecorded: "kiro" | "claude" | "unknown" | "codex" | null; conflict: boolean;
  source?: "project-binding";
  codexAssociated?: { source: "project-binding (recorded, not live)" };
};
export type ProgressSelected = {
  space: string; id: string; displayName: string; description?: string; scope?: string; status?: string;
  phases: { name: string; stages: ProgressStage[]; status: "completed" | "active" | "pending" }[];
  totals: { completed: number; total: number; skipped: number }; activeStage?: string;
  blockers: ProgressBlocker[]; unattributedBlockers: ProgressBlocker[];
  backend: ProgressBackend; ledger: { outstanding: number; settled: number };
};
export type ProgressResult = {
  schemaVersion: 1; generatedAt: string; project: { dir: string; stamp: ProgressStamp | null };
  intents: ProgressIntent[]; selected?: ProgressSelected;
  state: "ok" | "empty" | "selection-required" | "unavailable" | "error";
  error?: { code: string; message: string };
};

class ProgressFailure extends Error {
  constructor(readonly code: string, message: string, readonly state: "unavailable" | "error" = "error") {
    super(message);
  }
}
function requireValue(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new ProgressFailure(code, message);
}
function limit(value: number, maximum: number, name: string): void {
  if (value > maximum) throw new ProgressFailure("LIMIT_EXCEEDED", `${name} exceeds ${maximum}`, "unavailable");
}
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && !v.includes("\0");
const name = (v: unknown): v is string => text(v) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);
const identifier = (v: unknown): v is string => text(v) && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(v);
const timestamp = (v: unknown): v is string => text(v) && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
type Stat = Awaited<ReturnType<typeof lstat>>;
const same = (a: Stat, b: Stat) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

class Reader {
  bytes = 0;
  entries = 0;
  constructor(readonly root: string) {}

  async stat(path: string, optional = false): Promise<Stat | null> {
    const rel = relative(this.root, path);
    requireValue(rel !== ".." && !rel.startsWith(`..${sep}`) && resolve(this.root, rel) === path,
      "UNSAFE_PATH", "Path must stay within projectDir");
    const parts = rel ? rel.split(sep) : [];
    let current = this.root;
    for (let i = 0; i <= parts.length; i++) {
      if (i) current = join(current, parts[i - 1]);
      let st: Stat;
      try { st = await lstat(current); }
      catch (error) {
        if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new ProgressFailure("SOURCE_UNREADABLE", `Required source unreadable: ${relative(this.root, current) || "."}`, "unavailable");
      }
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) {
        throw new ProgressFailure("UNSAFE_FILE_KIND", `Unsupported file kind: ${relative(this.root, current) || "."}`, "unavailable");
      }
      if (i < parts.length || !rel) {
        if (!st.isDirectory()) throw new ProgressFailure("UNSAFE_FILE_KIND", "Expected directory in source path", "unavailable");
      }
      if (i === parts.length) return st;
    }
    return null;
  }

  async dir(path: string): Promise<{ name: string; directory: boolean }[]> {
    const before = await this.stat(path, true);
    if (!before) return [];
    if (!before.isDirectory()) throw new ProgressFailure("UNSAFE_FILE_KIND", "Expected source directory", "unavailable");
    const entries: { name: string; directory: boolean }[] = [];
    const dir = await opendir(path);
    for await (const item of dir) {
      limit(entries.length + 1, PROGRESS_LIMITS.directoryEntries, "Directory entries");
      limit(++this.entries, PROGRESS_LIMITS.totalEntries, "Total directory entries");
      const st = await this.stat(join(path, item.name));
      entries.push({ name: item.name, directory: st!.isDirectory() });
    }
    if (!same(before, (await this.stat(path))!)) throw new ProgressFailure("SOURCE_CHANGED", "Directory changed during read", "unavailable");
    return entries.sort((a, b) => cmp(a.name, b.name));
  }

  async read(path: string, optional = false): Promise<string | null> {
    const before = await this.stat(path, optional);
    if (!before) return null;
    if (!before.isFile()) throw new ProgressFailure("UNSAFE_FILE_KIND", "Expected regular source file", "unavailable");
    const size = Number(before.size);
    limit(size, PROGRESS_LIMITS.fileBytes, "File bytes");
    limit(this.bytes + size, PROGRESS_LIMITS.totalBytes, "Total source bytes");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!same(before, await file.stat())) throw new ProgressFailure("SOURCE_CHANGED", "File changed before read", "unavailable");
      const buffer = Buffer.alloc(size + 1);
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      this.bytes += count;
      limit(count, PROGRESS_LIMITS.fileBytes, "File bytes");
      limit(this.bytes, PROGRESS_LIMITS.totalBytes, "Total source bytes");
      if (count !== size || !same(before, await file.stat()) || !same(before, (await this.stat(path))!)) {
        throw new ProgressFailure("SOURCE_CHANGED", "File changed during read", "unavailable");
      }
      try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count)); }
      catch { throw new ProgressFailure("MALFORMED_SOURCE", "Source is not UTF-8"); }
    } finally { await file.close(); }
  }

  async json(path: string, optional = false): Promise<unknown> {
    const raw = await this.read(path, optional);
    if (raw === null) return undefined;
    try { return JSON.parse(raw); }
    catch { throw new ProgressFailure("MALFORMED_JSON", `Invalid JSON: ${relative(this.root, path)}`); }
  }
}

async function stamp(reader: Reader): Promise<ProgressStamp | null> {
  const raw = await reader.read(join(reader.root, ".kiro-crew/tools/data/aidlc-stamp.json"), true);
  if (raw === null) return null;
  // Match the launcher's flat literal grammar; JSON.parse alone admits duplicates.
  let compact = "";
  let quoted = false;
  for (const line of raw.split("\n")) {
    for (const ch of line) {
      requireValue(ch !== "\\", "INVALID_STAMP", "Stamp escapes are forbidden");
      if (ch === '"') quoted = !quoted;
      else if (!quoted && /[ \t\r\v\f]/.test(ch)) continue;
      compact += ch;
    }
    requireValue(!quoted, "INVALID_STAMP", "Stamp string crosses a line");
  }
  const fields = compact.slice(1, -1).split(",");
  const keys = fields.map(f => /^"([^"]+)":(1|"[^"]*")$/.exec(f)?.[1]);
  requireValue(compact.startsWith("{") && compact.endsWith("}") && fields.length === 4 &&
    keys.every(Boolean) && new Set(keys).size === 4, "INVALID_STAMP", "Invalid flat stamp");
  let value: unknown;
  try { value = JSON.parse(compact); } catch { throw new ProgressFailure("INVALID_STAMP", "Invalid stamp JSON"); }
  requireValue(object(value) && value.schemaVersion === 1 && value.distribution === "kiro-crew" &&
    value.harnessDir === ".kiro-crew" && text(value.frameworkVersion) && /^[0-9a-z.-]+$/.test(value.frameworkVersion),
  "INVALID_STAMP", "Mismatched project installation stamp");
  return value as ProgressStamp;
}

type IntentRecord = { info: ProgressIntent; dir?: string };
async function census(reader: Reader): Promise<IntentRecord[]> {
  const out: IntentRecord[] = [];
  for (const space of await reader.dir(join(reader.root, "aidlc/spaces"))) {
    if (!space.directory) continue;
    requireValue(name(space.name), "MALFORMED_REGISTRY", "Unsafe space name");
    const base = join(reader.root, "aidlc/spaces", space.name, "intents");
    const entries = await reader.dir(base);
    const dirs = entries.filter(e => e.directory).map(e => e.name);
    const source = await reader.json(join(base, "intents.json"), true);
    const registry = source === undefined ? [] : source;
    requireValue(Array.isArray(registry), "MALFORMED_REGISTRY", "Registry must be an array");
    limit(out.length + registry.length, PROGRESS_LIMITS.intents, "Intents");
    const claimed = new Set<string>();
    const ids = new Set<string>();
    for (const row of registry) {
      requireValue(object(row) && name(row.uuid) && name(row.slug) && text(row.status) &&
        (row.dirName === undefined || name(row.dirName)), "MALFORMED_REGISTRY", "Invalid intent registry row");
      requireValue(!ids.has(row.uuid), "MALFORMED_REGISTRY", "Duplicate intent identity");
      ids.add(row.uuid);
      const { uuid, slug, dirName } = row;
      const matches = dirs.filter(d => dirName ? dirName === d : d.startsWith(`${slug}-`) &&
        /^[0-9a-f]+$/.test(d.slice(slug.length + 1)) &&
        uuid.replace(/-/g, "").endsWith(d.slice(slug.length + 1)));
      requireValue(matches.length <= 1 && (!matches[0] || !claimed.has(matches[0])), "MALFORMED_REGISTRY", "Ambiguous record identity");
      const dir = matches[0];
      if (dir) claimed.add(dir);
      const status = row.status.trim().toLowerCase();
      const reason: ProgressIntent["reason"] = status === "archived" ? "archived" :
        ["complete", "completed"].includes(status) ? "completed" : !dir ? "registry-only" :
        ["in-flight", "active", "in-progress"].includes(status) ? undefined : "unsupported-status";
      out.push({ info: { space: space.name, id: row.uuid, displayName: row.slug, eligible: !reason, ...(reason ? { reason } : {}) }, dir });
    }
    for (const dir of dirs.filter(d => !claimed.has(d))) {
      // Engine record-presence rule: infrastructure directories (audit, locks,
      // scratch) are not orphan intents merely because they are directories.
      if (!await reader.stat(join(base, dir, "aidlc-state.md"), true)) continue;
      limit(out.length + 1, PROGRESS_LIMITS.intents, "Intents");
      requireValue(name(dir), "MALFORMED_REGISTRY", "Unsafe orphan directory name");
      out.push({ info: { space: space.name, id: dir, displayName: /^\d{6}-(.+)$/.exec(dir)?.[1] ??
        dir.replace(/-[0-9a-f]+$/, ""), eligible: false, reason: "orphan" }, dir });
    }
  }
  return out;
}

function field(content: string, key: string): string | undefined {
  const prefix = `**${key}**:`;
  for (const raw of content.split("\n")) {
    const line = raw.startsWith("- ") ? raw.slice(2) : raw;
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim() || undefined;
  }
  return undefined;
}
const MARKERS: Record<string, ProgressStageState> = {
  " ": "pending", "-": "in-progress", "?": "awaiting-approval", R: "revising", x: "completed", S: "skipped",
};
type Planned = { slug: string; phase: string; number: string; enabled?: boolean };
async function plan(reader: Reader, state: string, scope: string): Promise<{ node: Planned; state: ProgressStageState }[]> {
  const data = join(reader.root, ".kiro-crew/tools/data");
  const graph = await reader.json(join(data, "stage-graph.json"));
  const grid = await reader.json(join(data, "scope-grid.json"));
  requireValue(Array.isArray(graph) && object(grid), "MALFORMED_PLAN", "Expected graph array and scope grid object");
  limit(graph.length, PROGRESS_LIMITS.stages, "Graph stages");
  limit(Object.keys(grid).length, PROGRESS_LIMITS.scopes, "Scopes");
  const seen = new Set<string>();
  for (const s of graph) {
    requireValue(object(s) && name(s.slug) && name(s.phase) && text(s.number) && /^\d+\.\d+$/.test(s.number) &&
      (s.enabled === undefined || typeof s.enabled === "boolean") && !seen.has(s.slug), "MALFORMED_PLAN", "Invalid or duplicate graph stage");
    seen.add(s.slug);
  }
  for (const entry of Object.values(grid)) {
    requireValue(object(entry) && object(entry.stages), "MALFORMED_PLAN", "Invalid scope grid entry");
    limit(Object.keys(entry.stages).length, PROGRESS_LIMITS.stages, "Grid stages");
    requireValue(Object.entries(entry.stages).every(([slug, action]) => seen.has(slug) && (action === "EXECUTE" || action === "SKIP")),
      "MALFORMED_PLAN", "Invalid scope action or unknown stage");
  }
  const scoped = Object.hasOwn(grid, scope) ? grid[scope] : undefined;
  requireValue(object(scoped) && object(scoped.stages), "MALFORMED_PLAN", "State scope missing from compiled grid");
  const actions = scoped.stages;
  const checks = new Map<string, { state: ProgressStageState; action?: string }>();
  // Stage Progress only: unit/Bolt checklists elsewhere cannot overwrite it.
  const section = /(?:^|\n)## Stage Progress[^\S\n]*\n([\s\S]*?)(?=\n## |$)/.exec(state)?.[1];
  requireValue(section !== undefined, "MALFORMED_STATE", "Missing Stage Progress section");
  for (const line of section.split("\n")) {
    if (!/^- \[/.test(line)) continue;
    const match = /^- \[([ xSR?-])\] (\S+)\s*—\s*(.*)$/.exec(line);
    requireValue(match && seen.has(match[2]) && !checks.has(match[2]), "MALFORMED_STATE", "Unknown, duplicate or malformed stage checkbox");
    checks.set(match[2], { state: MARKERS[match[1]], action: /^(EXECUTE|SKIP)\b/.exec(match[3])?.[1] });
    limit(checks.size, PROGRESS_LIMITS.stages, "State stages");
  }
  return (graph as Planned[]).filter(s => s.enabled !== false && (checks.get(s.slug)?.action ?? actions[s.slug]) === "EXECUTE")
    .sort((a, b) => {
      const [ap, as] = a.number.split(".").map(Number);
      const [bp, bs] = b.number.split(".").map(Number);
      return ap - bp || as - bs || cmp(a.slug, b.slug);
    }).map(node => ({ node, state: checks.get(node.slug)?.state ?? "pending" }));
}

type Audit = {
  event: string; timestamp: string; stage?: string; workflow?: string;
  recovered: boolean; revalidated: boolean; shard: string; pos: number;
};
async function auditRows(reader: Reader, record: string): Promise<Audit[]> {
  const rows: Audit[] = [];
  let blocks = 0;
  for (const entry of await reader.dir(join(record, "audit"))) {
    if (!entry.name.endsWith(".md")) continue;
    const content = await reader.read(join(record, "audit", entry.name));
    for (const [pos, block] of content!.replace(/\r\n/g, "\n").split(/\n---\n/).entries()) {
      limit(++blocks, PROGRESS_LIMITS.auditBlocks, "Audit blocks");
      const event = field(block, "Event");
      if (!event) continue; // prose header/empty trailing separator, as in engine parser
      const time = field(block, "Timestamp");
      requireValue(timestamp(time), "MALFORMED_AUDIT", "Audit event has invalid timestamp");
      rows.push({ event, timestamp: time, stage: field(block, "Stage"), workflow: field(block, "Workflow"),
        recovered: field(block, "Recovered") === "true", revalidated: field(block, "Revalidated") === "true", shard: entry.name, pos });
    }
  }
  return rows.sort((a, b) => cmp(a.timestamp, b.timestamp) || cmp(a.shard, b.shard) || a.pos - b.pos);
}

function gateAge(rows: Audit[], slug: string, revising: boolean, now: number): number | undefined {
  let since: string | undefined;
  const relevant = new Set(["WORKFLOW_STARTED", "STAGE_JUMPED", "STAGE_STARTED", "STAGE_AWAITING_APPROVAL", "GATE_APPROVED", "GATE_REJECTED"]);
  const events = rows.filter(row => relevant.has(row.event));
  for (let start = 0; start < events.length;) {
    let end = start + 1;
    while (end < events.length && events[end].timestamp === events[start].timestamp) end++;
    const effects = new Map<string, "open" | "clear">();
    for (const row of events.slice(start, end)) {
      const stage = row.stage;
      const boundary = ["WORKFLOW_STARTED", "STAGE_JUMPED"].includes(row.event) ||
        (row.event === "STAGE_STARTED" && stage === slug && !row.workflow?.startsWith("single-stage:"));
      if (boundary) { effects.set(row.shard, "clear"); continue; }
      if (stage !== slug) continue;
      if (row.event === "STAGE_AWAITING_APPROVAL" && (row.recovered || row.revalidated)) continue;
      effects.set(row.shard, row.event === (revising ? "GATE_REJECTED" : "STAGE_AWAITING_APPROVAL") ? "open" : "clear");
    }
    if ([...effects.values()].includes("clear")) since = undefined;
    else if (effects.size) since = events[start].timestamp;
    start = end;
  }
  return since ? Math.max(0, now - Date.parse(since)) : undefined;
}

type Binding = { space: string; intent: string | null; boundAt: string; backend?: string; backendConflict?: boolean };
type Dispatch = { task: string; dispatchedAt: string };
const onlyKeys = (v: Obj, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const BASE_KEYS = ["intentId", "wave", "stage", "task", "role", "intendedAt"];
const DISPATCH_KEYS = [...BASE_KEYS, "childId", "conversationId", "runId", "dispatchedAt", "previousChildId"];
async function sessions(reader: Reader, selected: IntentRecord): Promise<Pick<ProgressSelected, "backend" | "ledger" | "unattributedBlockers"> & { dispatchBlockers: ProgressBlocker[] }> {
  const base = join(reader.root, "aidlc/.aidlc-sessions");
  const files = await reader.dir(base);
  const bindings = new Map<string, Binding>();
  const labels = new Set<string>();
  let conflict = false;
  for (const file of files.filter(f => /^crew-.+\.binding\.json$/.test(f.name))) {
    limit(bindings.size + 1, PROGRESS_LIMITS.bindings, "Bindings");
    const value = await reader.json(join(base, file.name));
    requireValue(object(value) && name(value.space) && (value.intent === null || name(value.intent)) && timestamp(value.boundAt) &&
      (value.backend === undefined || typeof value.backend === "string" && ["kiro", "claude", "unknown", "codex", "blocked"].includes(value.backend)) &&
      (value.backendConflict === undefined || typeof value.backendConflict === "boolean"), "MALFORMED_BINDING", "Invalid session binding");
    bindings.set(file.name.slice(0, -".binding.json".length), value as Binding);
    if (value.backend !== undefined) labels.add(value.backend === "blocked" ? "codex" : String(value.backend));
    conflict ||= value.backendConflict === true;
  }
  conflict ||= labels.size > 1;
  const codex = labels.has("codex");
  const backend: ProgressBackend = {
    asRecorded: codex ? "codex" : conflict ? "unknown" : labels.size ? [...labels][0] as "kiro" | "claude" | "unknown" : null,
    conflict, ...(bindings.size ? { source: "project-binding" as const } : {}),
    ...(codex ? { codexAssociated: { source: "project-binding (recorded, not live)" as const } } : {}),
  };
  const ledger = { outstanding: 0, settled: 0 };
  const dispatchBlockers: ProgressBlocker[] = [];
  const unattributedBlockers: ProgressBlocker[] = [];
  let count = 0;
  for (const file of files.filter(f => f.name.endsWith(".crew-dispatch.json"))) {
    const session = file.name.slice(0, -".crew-dispatch.json".length);
    const value = await reader.json(join(base, file.name));
    requireValue(object(value) && onlyKeys(value, ["schemaVersion", "session", "intents", "outstanding", "settled"]) &&
      value.schemaVersion === 1 && value.session === session && identifier(session) &&
      Array.isArray(value.intents) && Array.isArray(value.outstanding) && Array.isArray(value.settled), "MALFORMED_LEDGER", "Invalid dispatch ledger");
    count += value.intents.length + value.outstanding.length + value.settled.length;
    limit(count, PROGRESS_LIMITS.ledgerEntries, "Ledger entries");
    const ids = new Set<string>();
    const children = new Set<string>();
    const conversations = new Set<string>();
    for (const [kind, entries] of [["intents", value.intents], ["outstanding", value.outstanding], ["settled", value.settled]] as const) {
      for (const e of entries) {
        requireValue(object(e) && identifier(e.intentId) && identifier(e.wave) && identifier(e.stage) && text(e.task) &&
          text(e.role) && /^aidlc-crew-[a-z]+(?:-[a-z]+)*-agent$/.test(e.role) && timestamp(e.intendedAt), "MALFORMED_LEDGER", "Invalid dispatch entry");
        if (kind === "intents") {
          requireValue(onlyKeys(e, [...BASE_KEYS, "status"]) && (e.status === "intended" || e.status === "pending-unknown") && !ids.has(e.intentId), "MALFORMED_LEDGER", "Invalid dispatch intent");
          ids.add(e.intentId);
        } else {
          requireValue(identifier(e.childId) && identifier(e.conversationId) && e.runId === e.childId && timestamp(e.dispatchedAt) &&
            (e.previousChildId === undefined || identifier(e.previousChildId)) && !children.has(e.childId) && !ids.has(e.intentId),
          "MALFORMED_LEDGER", "Invalid or duplicate dispatch run");
          children.add(e.childId);
          if (kind === "settled") requireValue(onlyKeys(e, [...DISPATCH_KEYS, "outcome", "settledAt"]) && typeof e.outcome === "string" &&
            ["completed", "failed", "stopped", "lost"].includes(e.outcome) && timestamp(e.settledAt),
            "MALFORMED_LEDGER", "Invalid settled dispatch");
          else {
            requireValue(onlyKeys(e, DISPATCH_KEYS) && !conversations.has(e.conversationId), "MALFORMED_LEDGER", "Invalid outstanding dispatch");
            conversations.add(e.conversationId);
          }
        }
      }
    }
    ledger.outstanding += value.outstanding.length;
    ledger.settled += value.settled.length;
    for (const entry of value.outstanding as Dispatch[]) {
      const binding = bindings.get(session);
      const attributed = binding && binding.space === selected.info.space &&
        (binding.intent === selected.info.id || binding.intent === selected.dir) &&
        Date.parse(entry.dispatchedAt) > Date.parse(binding.boundAt);
      (attributed ? dispatchBlockers : unattributedBlockers).push({ kind: "dispatch-outstanding", ref: `${session}: ${entry.task}` });
    }
  }
  return { backend, ledger, dispatchBlockers, unattributedBlockers };
}

export async function readProgress(input: { projectDir: string; space?: string; intent?: string }): Promise<ProgressResult> {
  const result: ProgressResult = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), project: { dir: "", stamp: null }, intents: [], state: "error",
  };
  try {
    requireValue(text(input.projectDir), "INVALID_INPUT", "projectDir is required");
    result.project.dir = resolve(input.projectDir);
    requireValue((input.space === undefined || name(input.space)) && (input.intent === undefined || name(input.intent)) &&
      (input.intent === undefined || input.space !== undefined), "INVALID_SELECTION", "Explicit intent requires a safe space and id/slug");
    const reader = new Reader(result.project.dir);
    await reader.stat(reader.root);
    result.project.stamp = await stamp(reader);
    const records = await census(reader);
    result.intents = records.map(r => r.info);
    let candidates = records.filter(r => r.info.eligible && (input.space === undefined || r.info.space === input.space));
    if (input.intent !== undefined) {
      const within = records.filter(r => r.info.space === input.space);
      const exact = within.filter(r => r.info.id === input.intent);
      candidates = exact.length ? exact : within.filter(r => r.info.displayName === input.intent);
      requireValue(candidates.length === 1 && candidates[0].info.eligible, "INVALID_SELECTION", "Intent is missing, ambiguous or ineligible in the selected space");
    }
    if (!candidates.length) { result.state = "empty"; return result; }
    if (candidates.length > 1) { result.state = "selection-required"; return result; }
    const chosen = candidates[0];
    const record = join(reader.root, "aidlc/spaces", chosen.info.space, "intents", chosen.dir!);
    const content = (await reader.read(join(record, "aidlc-state.md")))!.replace(/\r\n/g, "\n");
    const scope = field(content, "Scope");
    const status = field(content, "Status");
    requireValue(scope && status, "MALFORMED_STATE", "State must contain Scope and Status");
    const effective = await plan(reader, content, scope);
    const rows = await auditRows(reader, record);
    const transport = await sessions(reader, chosen);
    const phases: ProgressSelected["phases"] = [];
    const blockers: ProgressBlocker[] = [];
    const current = field(content, "Current Stage");
    const activeStage = effective.some(s => s.node.slug === current) ? current : undefined;
    for (const { node, state } of effective) {
      let phase = phases.find(p => p.name === node.phase);
      if (!phase) { phase = { name: node.phase, stages: [], status: "pending" }; phases.push(phase); }
      const stage: ProgressStage = { slug: node.slug, state };
      if (state === "awaiting-approval" || state === "revising") {
        const ageMs = gateAge(rows, node.slug, state === "revising", Date.parse(result.generatedAt));
        stage.gate = { kind: state === "revising" ? "[R]" : "[?]", ...(ageMs !== undefined ? { ageMs } : {}) };
        blockers.push({ kind: state, ref: node.slug });
      }
      let pending = false;
      for (const row of rows) {
        if (row.stage !== node.slug) continue;
        if (row.event === "DECISION_RECORDED") pending = true;
        else if (row.event === "QUESTION_ANSWERED") pending = false;
      }
      if (pending) blockers.push({ kind: "pending-decision", ref: node.slug });
      phase.stages.push(stage);
    }
    for (const phase of phases) {
      phase.status = phase.stages.every(s => ["completed", "skipped"].includes(s.state)) ? "completed" :
        phase.stages.some(s => ["in-progress", "awaiting-approval", "revising"].includes(s.state) || s.slug === activeStage) ? "active" : "pending";
    }
    result.selected = {
      space: chosen.info.space, id: chosen.info.id, displayName: chosen.info.displayName,
      ...(field(content, "Project") ? { description: field(content, "Project") } : {}), scope, status, phases,
      totals: { completed: effective.filter(s => s.state === "completed").length, total: effective.length,
        skipped: effective.filter(s => s.state === "skipped").length },
      ...(activeStage ? { activeStage } : {}), blockers: [...blockers, ...transport.dispatchBlockers],
      unattributedBlockers: transport.unattributedBlockers, backend: transport.backend, ledger: transport.ledger,
    };
    result.state = "ok";
  } catch (error) {
    delete result.selected;
    result.state = error instanceof ProgressFailure ? error.state : "unavailable";
    result.error = error instanceof ProgressFailure ? { code: error.code, message: error.message } :
      { code: "SOURCE_UNREADABLE", message: "Unable to read a progress source; retry when it is stable and readable" };
  }
  return result;
}

/**
 * CLI contract: full argv `engine progress --json [--project-dir <abs>]
 * [--space <name>] [--intent <id-or-slug>]`; two-token values, no duplicates,
 * positional arguments, help/human mode or other flags. Project defaults to cwd,
 * never AIDLC/CLAUDE/KIRO_PROJECT_DIR. Explicit project must be absolute and an
 * existing directory, checked by Reader before sources are read. A stamp is not
 * required (reader returns null if absent); a present invalid stamp still fails.
 * The gateway MUST invoke <selected-project>/.kiro-crew/tools/aidlc.ts directly
 * using its trusted absolute Bun with BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 (Bun's
 * cache writes precede main), and validate the project installation stamp itself. This helper
 * does not authenticate the executable or discover/redispatch another engine;
 * the machine launcher is not the progress invocation contract.
 *
 * Pin oracle: bounded, no-follow optional .aidlc-version read before progress.
 * Any content differing from this engine (including an invalid version) is a
 * stderr-only PIN_MISMATCH warning, never a reservation or redispatch. Unsafe or
 * unreadable pins fail as JSON; absent pins proceed. No disabling conditions.
 * stdout is one JSON document: successful reader DTO unchanged, or the minimal
 * error envelope for BOTH reader error/unavailable and CLI failures; exit 0/1.
 * No status, orchestrate report, runtime compile, binding or writer fallback.
 */
export async function runProgressCli(argv: readonly string[]): Promise<number> {
  let output: ProgressResult | { schemaVersion: 1; state: "error"; error: { code: string; message: string } };
  let code = 0;
  try {
    requireValue(argv[0] === "engine" && argv[1] === "progress", "INVALID_ARGUMENT", "Use engine progress followed by flags");
    const options = new Map<string, string>();
    for (let index = 2; index < argv.length; index++) {
      const flag = argv[index];
      requireValue(["--json", "--project-dir", "--space", "--intent"].includes(flag), "INVALID_ARGUMENT", "Unknown progress option or positional argument");
      requireValue(!options.has(flag), "INVALID_ARGUMENT", `${flag} may be specified only once`);
      if (flag === "--json") { options.set(flag, ""); continue; }
      const value = argv[++index];
      requireValue(text(value) && !value.startsWith("--"), "INVALID_ARGUMENT", `${flag} requires a value`);
      options.set(flag, value);
    }
    requireValue(options.has("--json"), "JSON_REQUIRED", "engine progress requires --json; human output is not supported");
    const projectDir = options.get("--project-dir") ?? process.cwd();
    requireValue(isAbsolute(projectDir), "INVALID_PROJECT_DIR", "--project-dir must be absolute");
    const reader = new Reader(resolve(projectDir));
    const pin = await reader.read(join(reader.root, ".aidlc-version"), true);
    if (pin !== null && pin.trim() !== AIDLC_VERSION) {
      console.error("PIN_MISMATCH: project pin differs or is invalid; progress uses the selected project-local engine in-process");
    }
    const result = await readProgress({ projectDir: reader.root, space: options.get("--space"), intent: options.get("--intent") });
    if (result.state === "error" || result.state === "unavailable") {
      code = 1;
      output = { schemaVersion: 1, state: "error", error: result.error ?? { code: "PROGRESS_UNAVAILABLE", message: "Progress is unavailable" } };
    } else output = result;
  } catch (error) {
    code = 1;
    output = { schemaVersion: 1, state: "error", error: error instanceof ProgressFailure ?
      { code: error.code, message: error.message } : { code: "PROGRESS_UNAVAILABLE", message: "Unable to read progress; retry when sources are stable and readable" } };
  }
  console.log(JSON.stringify(output));
  return code;
}
