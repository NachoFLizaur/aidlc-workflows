import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROGRESS_LIMITS, readProgress, type ProgressResult } from "../../core/tools/aidlc-progress.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import corpus from "../fixtures/kiro-crew/progress-payloads.json";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTestProject(root); });
const DATA = ".kiro-crew/tools/data";
const BASE = "aidlc/spaces/main/intents";
const REGISTRY = `${BASE}/intents.json`;
const RECORD = `${BASE}/delivery-abcd`;
const SESSION = "aidlc/.aidlc-sessions";
const at = (hour: number) => new Date(Date.UTC(2000, 0, 2, hour)).toISOString();
const row = (i: number) => ({ uuid: `id-${i}`, slug: `work-${i}`, dirName: `work-${i}`, status: "active" });
const binding = { space: "main", intent: "record-abcd", boundAt: at(6), backend: "kiro" };
const dispatch = (i: number) => ({ intentId: `dispatch-${i}`, wave: "wave", stage: "execute", task: `work-${i}`,
  role: "aidlc-crew-developer-agent", intendedAt: at(6), childId: `child-${i}`, runId: `child-${i}`, conversationId: `chat-${i}`, dispatchedAt: at(7) });
const audit = (event: string, hour = 7, extra = "") => `**Event**: ${event}\n**Timestamp**: ${at(hour)}\n**Stage**: execute\n${extra}\n---\n`;
const state = (checks = "- [x] requirements — EXECUTE\n- [?] execute — EXECUTE\n- [ ] validate — EXECUTE") =>
  `**Scope**: standard\n**Status**: Running\n**Project**: Delivery work\n**Current Stage**: execute\n## Stage Progress\n${checks}\n## Units\n- [x] validate — EXECUTE\n`;
function put(root: string, path: string, value: unknown) {
  const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
function fresh(populated = true) {
  const root = createTestProject(); roots.push(root);
  // The shared fixture may supply its own engine skeleton; this reader's inputs
  // are generated independently, not copied from a frozen workflow tree.
  rmSync(join(root, "aidlc"), { recursive: true, force: true });
  put(root, `${DATA}/aidlc-stamp.json`, corpus.stamp);
  if (populated) {
    put(root, REGISTRY, [{ uuid: "record-abcd", slug: "delivery", dirName: "delivery-abcd", status: "active" }]);
    put(root, `${RECORD}/aidlc-state.md`, state());
    put(root, `${DATA}/stage-graph.json`, [
      { slug: "requirements", phase: "inception", number: "1.1" },
      { slug: "execute", phase: "construction", number: "2.1" },
      { slug: "validate", phase: "construction", number: "2.2" },
    ]);
    put(root, `${DATA}/scope-grid.json`, { standard: { stages: { requirements: "EXECUTE", execute: "EXECUTE", validate: "EXECUTE" } } });
  }
  return root;
}
function snapshot(root: string): { digest: string; bytes: number } {
  const hash = createHash("sha256"); let bytes = 0;
  function visit(path: string, rel: string) {
    const st = lstatSync(path); hash.update(JSON.stringify([rel, st.mode, st.mtimeMs, st.ctimeMs]));
    if (st.isSymbolicLink()) hash.update(readlinkSync(path));
    else if (st.isFile()) { const value = readFileSync(path); hash.update(value); bytes += value.length; }
    else if (st.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), `${rel}/${name}`);
  }
  visit(root, "."); return { digest: hash.digest("hex"), bytes };
}
async function observed(root: string, selection: { space?: string; intent?: string } = {}) {
  const before = snapshot(root); const result = await readProgress({ projectDir: root, ...selection });
  expect(snapshot(root)).toEqual(before); return result;
}
function refusal(result: ProgressResult, code = "LIMIT_EXCEEDED", status: ProgressResult["state"] = "unavailable") {
  expect(result.state).toBe(status); expect(result.error?.code).toBe(code); expect(result.selected).toBeUndefined();
}

test("optional absent roots are empty, while present stamps require exactly four literal fields", async () => {
  const root = fresh(false); rmSync(join(root, DATA, "aidlc-stamp.json"));
  expect(await observed(root)).toMatchObject({ state: "empty", project: { stamp: null }, intents: [] });
  put(root, REGISTRY, []); expect((await observed(root)).state).toBe("empty");
  const raw = JSON.stringify(corpus.stamp);
  for (const invalid of ["{}", raw.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    raw.replace('"schemaVersion":1', '"schemaVersion":1e0'), raw.replace('"1.0.0"', '"1\\u002e0.0"'),
    raw.replace('"kiro-crew"', '"claude"'), raw.replace('".kiro-crew"', '".claude"'), raw.replace(/}$/, ',"nested":{}}')]) {
    put(root, `${DATA}/aidlc-stamp.json`, invalid); refusal(await observed(root), "INVALID_STAMP", "error");
  }
  put(root, `${DATA}/aidlc-stamp.json`, corpus.stamp);
  expect((await observed(root)).project.stamp).toEqual({ schemaVersion: 1, distribution: "kiro-crew", harnessDir: ".kiro-crew", frameworkVersion: corpus.stamp.frameworkVersion });
});

test("census lists ineligible archives, completed, registry-only, unsupported and orphan records", async () => {
  const root = fresh(false);
  const rows = ["archived", "completed", "active", "paused"].map((status, i) => ({ ...row(i), status }));
  put(root, REGISTRY, rows);
  for (const i of [0, 1, 3]) put(root, `${BASE}/work-${i}/aidlc-state.md`, state());
  put(root, `${BASE}/orphan/aidlc-state.md`, state()); mkdirSync(join(root, BASE, "audit"));
  const result = await observed(root);
  expect(result.state).toBe("empty"); expect(result.intents.map((item) => item.reason)).toEqual(["archived", "completed", "registry-only", "unsupported-status", "orphan"]);
  for (const item of result.intents) refusal(await observed(root, { space: item.space, intent: item.id }), "INVALID_SELECTION", "error");
  rmSync(join(root, REGISTRY)); expect((await observed(root)).intents.every((item) => item.reason === "orphan")).toBe(true);
});

test("cross-space selection ignores cursors, resolves UUID suffixes and prefers identity over slug", async () => {
  const root = fresh();
  put(root, REGISTRY, [{ uuid: "record-abcd", slug: "delivery", status: "in-flight" }]);
  put(root, "aidlc/spaces/design/intents/intents.json", [{ uuid: "design-id", slug: "delivery", dirName: "design-work", status: "in-progress" }]);
  put(root, "aidlc/spaces/design/intents/design-work/aidlc-state.md", state());
  put(root, "aidlc/active-space", "design"); put(root, `${BASE}/active-intent`, "delivery-abcd");
  expect((await observed(root)).state).toBe("selection-required");
  for (const intent of ["design-id", "delivery"]) {
    const result = await observed(root, { space: "design", intent }); expect(result.selected?.id).toBe("design-id"); expect(result.intents).toHaveLength(2);
  }
  refusal(await observed(root, { intent: "delivery" }), "INVALID_SELECTION", "error");
  refusal(await observed(root, { space: "main", intent: "design-id" }), "INVALID_SELECTION", "error");
  put(root, REGISTRY, [{ uuid: "delivery", slug: "work", dirName: "delivery-abcd", status: "active" }, { uuid: "other", slug: "delivery", dirName: "other", status: "active" }]);
  put(root, `${BASE}/other/aidlc-state.md`, state());
  expect((await observed(root, { space: "main", intent: "delivery" })).selected?.id).toBe("delivery");
  put(root, REGISTRY, [{ ...row(0), slug: "same", dirName: "delivery-abcd" }, { ...row(1), slug: "same", dirName: "other" }]);
  refusal(await observed(root, { space: "main", intent: "same" }), "INVALID_SELECTION", "error");
});

test("effective plan uses enabled graph and state action overrides, not nested unit checklists", async () => {
  const root = fresh();
  put(root, `${DATA}/stage-graph.json`, [
    { slug: "requirements", phase: "inception", number: "1.1" }, { slug: "execute", phase: "construction", number: "2.1" },
    { slug: "validate", phase: "construction", number: "2.2" }, { slug: "disabled", phase: "construction", number: "2.3", enabled: false },
  ]);
  put(root, `${DATA}/scope-grid.json`, { standard: { stages: { requirements: "EXECUTE", execute: "SKIP", validate: "EXECUTE", disabled: "EXECUTE" } } });
  put(root, `${RECORD}/aidlc-state.md`, state("- [S] requirements — EXECUTE\n- [R] execute — EXECUTE"));
  put(root, `${RECORD}/construction/unit/bolt/aidlc-state.md`, "invalid nested work must not be read");
  const result = await observed(root); const selected = result.selected!;
  expect(result.state).toBe("ok"); expect(selected.totals).toEqual({ completed: 0, total: 3, skipped: 1 });
  expect(selected.phases.map((p) => p.status)).toEqual(["completed", "active"]);
  expect(selected.phases.flatMap((p) => p.stages).map((s) => s.state)).toEqual(["skipped", "revising", "pending"]);
  expect(selected.blockers).toEqual([{ kind: "revising", ref: "execute" }]);
  put(root, `${RECORD}/aidlc-state.md`, state("- [x] requirements — EXECUTE\n- [-] execute — SKIP").replace("**Current Stage**: execute", "**Current Stage**: foreign"));
  const next = (await observed(root)).selected!;
  expect(next.activeStage).toBeUndefined(); expect(next.phases.map((p) => p.status)).toEqual(["completed", "pending"]);
  expect(next.totals).toEqual({ completed: 1, total: 2, skipped: 0 });
});

test("chronological decisions and gate ages respect workflow, recovery and same-time boundaries", async () => {
  const root = fresh();
  put(root, `${RECORD}/audit/z.md`, audit("STAGE_AWAITING_APPROVAL", 6) + audit("DECISION_RECORDED", 6));
  put(root, `${RECORD}/audit/a.md`, audit("QUESTION_ANSWERED", 7));
  put(root, `${BASE}/audit/foreign.md`, audit("DECISION_RECORDED", 8));
  const first = await observed(root);
  const gate = (result: ProgressResult) => result.selected?.phases.flatMap((p) => p.stages).find((s) => s.slug === "execute")?.gate;
  expect(gate(first)).toEqual({ kind: "[?]", ageMs: Math.max(0, Date.parse(first.generatedAt) - Date.parse(at(6))) });
  expect(first.selected?.blockers).toEqual([{ kind: "awaiting-approval", ref: "execute" }]);
  for (const later of [audit("GATE_APPROVED"), audit("WORKFLOW_STARTED"), audit("STAGE_JUMPED"), audit("STAGE_STARTED"),
    audit("STAGE_STARTED") + audit("STAGE_AWAITING_APPROVAL", 8, "**Recovered**: true"),
    audit("STAGE_STARTED") + audit("STAGE_AWAITING_APPROVAL", 8, "**Revalidated**: true"), audit("GATE_APPROVED", 6)]) {
    put(root, `${RECORD}/audit/a.md`, later); expect(gate(await observed(root))).toEqual({ kind: "[?]" });
  }
  put(root, `${RECORD}/audit/a.md`, audit("STAGE_STARTED", 7, "**Workflow**: single-stage:unrelated").replace("**Stage**: execute", "**Stage**: unrelated"));
  expect(gate(await observed(root))?.ageMs).toBeNumber();
  put(root, `${RECORD}/aidlc-state.md`, state("- [R] execute — EXECUTE"));
  put(root, `${RECORD}/audit/a.md`, audit("GATE_REJECTED", 8));
  const rejected = await observed(root); expect(gate(rejected)).toEqual({ kind: "[R]", ageMs: Math.max(0, Date.parse(rejected.generatedAt) - Date.parse(at(8))) });
  expect(rejected.selected?.blockers).toContainEqual({ kind: "pending-decision", ref: "execute" });
});

test("dispatch attribution needs same session, exact record and strict post-binding time; labels stay historical", async () => {
  const root = fresh(); put(root, `${RECORD}/aidlc-state.md`, state(""));
  const ledger = { schemaVersion: 1, session: "crew-a", intents: [], outstanding: [dispatch(0)], settled: [{ ...dispatch(1), outcome: "completed", settledAt: at(8) }] };
  put(root, `${SESSION}/crew-a.crew-dispatch.json`, ledger);
  for (const [change, attributed] of [[{}, true], [{ intent: "delivery-abcd" }, true], [{ intent: "delivery" }, false],
    [{ boundAt: at(7) }, false], [{ boundAt: at(8) }, false], [{ space: "design" }, false], [{ intent: null }, false]] as const) {
    put(root, `${SESSION}/crew-a.binding.json`, { ...binding, ...change });
    const selected = (await observed(root)).selected!;
    expect(selected.ledger).toEqual({ outstanding: 1, settled: 1 });
    expect(selected.blockers).toHaveLength(attributed ? 1 : 0); expect(selected.unattributedBlockers).toHaveLength(attributed ? 0 : 1);
  }
  rmSync(join(root, SESSION, "crew-a.binding.json")); put(root, `${SESSION}/crew-other.binding.json`, binding);
  expect((await observed(root)).selected?.unattributedBlockers).toHaveLength(1);
  rmSync(join(root, SESSION, "crew-other.binding.json"));
  for (const backend of ["kiro", "claude", "unknown", "codex", "blocked"] as const) {
    put(root, `${SESSION}/crew-a.binding.json`, { ...binding, backend });
    const result = await observed(root); const label = backend === "blocked" ? "codex" : backend;
    expect(result.state).toBe("ok"); expect(result.selected?.backend).toEqual({ asRecorded: label, conflict: false, source: "project-binding", ...(label === "codex" ? { codexAssociated: { source: "project-binding (recorded, not live)" } } : {}) });
  }
  put(root, `${SESSION}/crew-b.binding.json`, binding);
  expect((await observed(root)).selected?.backend).toMatchObject({ asRecorded: "codex", conflict: true });
  put(root, `${SESSION}/crew-a.binding.json`, { ...binding, backend: "claude" });
  expect((await observed(root)).selected?.backend).toMatchObject({ asRecorded: "unknown", conflict: true });
});

test("malformed UTF-8, JSON and schemas fail explicitly rather than reporting empty progress", async () => {
  for (const [path, value, code] of [
    [REGISTRY, Buffer.from([255]), "MALFORMED_SOURCE"], [REGISTRY, "{", "MALFORMED_JSON"], [REGISTRY, {}, "MALFORMED_REGISTRY"],
    [REGISTRY, [{ ...row(0), uuid: "../escape" }], "MALFORMED_REGISTRY"], [REGISTRY, [row(0), row(0)], "MALFORMED_REGISTRY"],
    [`${DATA}/stage-graph.json`, {}, "MALFORMED_PLAN"], [`${DATA}/scope-grid.json`, {}, "MALFORMED_PLAN"],
    [`${RECORD}/aidlc-state.md`, "broken", "MALFORMED_STATE"],
    [`${RECORD}/audit/a.md`, "**Event**: DECISION_RECORDED\n**Timestamp**: invalid", "MALFORMED_AUDIT"],
    [`${SESSION}/crew-bad.binding.json`, {}, "MALFORMED_BINDING"], [`${SESSION}/crew-bad.crew-dispatch.json`, {}, "MALFORMED_LEDGER"],
  ] as const) { const root = fresh(); put(root, path, value); refusal(await observed(root), code, "error"); }
});

test("missing required plan or state refuses without rebuilding", async () => {
  for (const path of [`${RECORD}/aidlc-state.md`, `${DATA}/stage-graph.json`, `${DATA}/scope-grid.json`]) {
    const root = fresh(); rmSync(join(root, path)); refusal(await observed(root), "SOURCE_UNREADABLE");
  }
});

test("ledger schema refuses duplicate runs, conversations, pending identities and unknown fields", async () => {
  const root = fresh();
  const base = { schemaVersion: 1, session: "crew-a", intents: [], outstanding: [dispatch(0)], settled: [] };
  const pending = { intentId: "pending", wave: "wave", stage: "execute", task: "work", role: "aidlc-crew-developer-agent", intendedAt: at(6), status: "intended" };
  for (const value of [{ ...base, session: "other" }, { ...base, extra: true }, { ...base, outstanding: [dispatch(0), dispatch(0)] },
    { ...base, outstanding: [dispatch(0), { ...dispatch(1), conversationId: dispatch(0).conversationId }] },
    { ...base, intents: [pending, pending] }, { ...base, outstanding: [{ ...dispatch(0), runId: "wrong" }] },
    { ...base, settled: [{ ...dispatch(1), outcome: "unknown", settledAt: at(8) }] }]) {
    put(root, `${SESSION}/crew-a.crew-dispatch.json`, value); refusal(await observed(root), "MALFORMED_LEDGER", "error");
  }
});

test("per-file byte limit accepts the boundary and refuses one extra byte", async () => {
  const root = fresh(false); put(root, REGISTRY, "[]".padEnd(PROGRESS_LIMITS.fileBytes));
  expect((await observed(root)).state).toBe("empty"); put(root, REGISTRY, "[]".padEnd(PROGRESS_LIMITS.fileBytes + 1)); refusal(await observed(root));
});

test("aggregate bytes include every audit shard with no partial fallback", async () => {
  const root = fresh(); let remaining = PROGRESS_LIMITS.totalBytes - snapshot(root).bytes; let last = "";
  for (let i = 0; remaining > 0; i++) { const length = Math.min(remaining, PROGRESS_LIMITS.fileBytes); last = `${RECORD}/audit/shard-${i}.md`; put(root, last, " ".repeat(length)); remaining -= length; }
  expect((await observed(root)).state).toBe("ok"); put(root, last, `${readFileSync(join(root, last), "utf8")} `); refusal(await observed(root));
});

test("per-directory enumeration accepts its boundary and refuses an extra entry", async () => {
  const root = fresh(false); put(root, REGISTRY, []);
  for (let i = 1; i < PROGRESS_LIMITS.directoryEntries; i++) put(root, `${BASE}/ignored-${i}`, "");
  expect((await observed(root)).state).toBe("empty"); put(root, `${BASE}/overflow`, ""); refusal(await observed(root));
});

test("total enumeration budget spans directories without truncating the census", async () => {
  const root = fresh(false);
  for (let s = 0; s < 5; s++) for (let i = 0; i < 1999; i++) put(root, `aidlc/spaces/space-${s}/intents/ignored-${i}`, "");
  // Five spaces plus 5 * 1999 children = 10000 enumerated entries.
  expect((await observed(root)).state).toBe("empty"); put(root, "aidlc/spaces/space-4/intents/overflow", ""); refusal(await observed(root));
});

test("intent budget is aggregate across spaces", async () => {
  const root = fresh(false); put(root, REGISTRY, Array.from({ length: 250 }, (_, i) => row(i)));
  put(root, "aidlc/spaces/design/intents/intents.json", Array.from({ length: 250 }, (_, i) => row(i)));
  expect((await observed(root)).intents).toHaveLength(PROGRESS_LIMITS.intents);
  put(root, "aidlc/spaces/design/intents/intents.json", Array.from({ length: 251 }, (_, i) => row(i))); refusal(await observed(root));
});

test("compiled stage and scope budgets admit their boundaries and refuse overflow", async () => {
  const root = fresh(); const graph = Array.from({ length: PROGRESS_LIMITS.stages }, (_, i) => ({ slug: `stage-${i}`, phase: "construction", number: `2.${i}` }));
  put(root, `${DATA}/stage-graph.json`, graph);
  const stages = Object.fromEntries(graph.map((s) => [s.slug, "EXECUTE"]));
  const grid = { standard: { stages }, ...Object.fromEntries(Array.from({ length: PROGRESS_LIMITS.scopes - 1 }, (_, i) => [`scope-${i}`, { stages: {} }])) };
  put(root, `${DATA}/scope-grid.json`, grid); put(root, `${RECORD}/aidlc-state.md`, state(graph.map((s) => `- [ ] ${s.slug} — EXECUTE`).join("\n")));
  expect((await observed(root)).selected?.totals).toEqual({ completed: 0, total: 200, skipped: 0 });
  put(root, `${DATA}/scope-grid.json`, { ...grid, overflow: { stages: {} } }); refusal(await observed(root));
  put(root, `${DATA}/scope-grid.json`, { standard: { stages: { ...stages, overflow: "EXECUTE" } } }); refusal(await observed(root));
  put(root, `${DATA}/scope-grid.json`, grid); put(root, `${DATA}/stage-graph.json`, [...graph, { slug: "overflow", phase: "construction", number: "2.201" }]); refusal(await observed(root));
});

test("ledger entry budget counts all arrays and all sessions", async () => {
  const root = fresh(); put(root, `${SESSION}/crew-a.binding.json`, binding);
  const ledger = { schemaVersion: 1, session: "crew-a", intents: [], outstanding: Array.from({ length: PROGRESS_LIMITS.ledgerEntries }, (_, i) => dispatch(i)), settled: [] };
  put(root, `${SESSION}/crew-a.crew-dispatch.json`, ledger);
  expect((await observed(root)).selected?.ledger).toEqual({ outstanding: 1000, settled: 0 });
  put(root, `${SESSION}/crew-b.crew-dispatch.json`, { ...ledger, session: "crew-b", outstanding: [], settled: [{ ...dispatch(1001), outcome: "completed", settledAt: at(8) }] }); refusal(await observed(root));
});

test("binding count is bounded even when all observations agree", async () => {
  const root = fresh(); for (let i = 0; i < PROGRESS_LIMITS.bindings; i++) put(root, `${SESSION}/crew-${i}.binding.json`, binding);
  expect((await observed(root)).selected?.backend.asRecorded).toBe("kiro"); put(root, `${SESSION}/crew-overflow.binding.json`, binding); refusal(await observed(root));
});

test("audit block budget includes separators and refuses partial interpretation", async () => {
  const root = fresh(); put(root, `${RECORD}/audit/a.md`, "\n---\n".repeat(PROGRESS_LIMITS.auditBlocks - 1));
  expect((await observed(root)).state).toBe("ok"); put(root, `${RECORD}/audit/a.md`, "\n---\n".repeat(PROGRESS_LIMITS.auditBlocks)); refusal(await observed(root));
});

test("root and ancestor links, internal links and special files refuse before target reads", async () => {
  const root = fresh(); const target = join(root, "target"); writeFileSync(target, "[]"); rmSync(join(root, REGISTRY));
  for (const path of [target, join(root, "absent")]) { symlinkSync(path, join(root, REGISTRY)); refusal(await observed(root), "UNSAFE_FILE_KIND"); rmSync(join(root, REGISTRY)); }
  const link = join(root, "linked-root"); symlinkSync(root, link, "dir"); refusal(await readProgress({ projectDir: link }), "UNSAFE_FILE_KIND"); rmSync(link);
  if (process.platform !== "win32") {
    const made = spawnSync("mkfifo", [join(root, REGISTRY)], { timeout: 2000 }); expect(made.status).toBe(0);
    refusal(await observed(root), "UNSAFE_FILE_KIND"); rmSync(join(root, REGISTRY));
  }
  rmSync(join(root, "aidlc"), { recursive: true }); symlinkSync(join(root, ".kiro-crew"), join(root, "aidlc"), "dir"); refusal(await observed(root), "UNSAFE_FILE_KIND");
});

test("a changed descriptor snapshot fails without publishing partial progress", () => {
  const root = fresh(); const target = join(root, RECORD, "aidlc-state.md"); const script = join(root, "change-during-read.ts");
  put(root, "change-during-read.ts", `import {mock} from 'bun:test';import * as fs from 'node:fs/promises';import {appendFileSync} from 'node:fs';const open=fs.open;
mock.module('node:fs/promises',()=>({...fs,open:async(path,...args)=>{const fd=await open(path,...args);if(path===${JSON.stringify(target)})appendFileSync(path,'changed');return fd;}}));
const {readProgress}=await import(${JSON.stringify(join(REPO_ROOT, "core/tools/aidlc-progress.ts"))});console.log(JSON.stringify(await readProgress({projectDir:${JSON.stringify(root)}})));`);
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", timeout: 10000 });
  expect(result.status, result.stderr).toBe(0); refusal(JSON.parse(result.stdout), "SOURCE_CHANGED");
  expect(readFileSync(target, "utf8")).toBe(`${state()}changed`);
});

function cli(root: string) {
  const tools = join(root, ".kiro-crew/tools");
  // Copy the actual dispatcher startup closure, not writer/recovery delegates.
  // A newly introduced dependency must be reviewed rather than silently mocked.
  for (const name of ["aidlc.ts", "aidlc-command.ts", "aidlc-color.ts", "aidlc-runtime-paths.ts", "aidlc-version.ts", "aidlc-progress.ts"]) cpSync(join(REPO_ROOT, "dist/kiro-crew/.kiro-crew/tools", name), join(tools, name));
  const machine = join(root, "machine"); const foreign = join(root, "foreign");
  for (const name of ["home", "tmp", "bin", "reservations", "versions/9.9.9"]) mkdirSync(join(machine, name), { recursive: true });
  mkdirSync(foreign); put(root, "machine/reservations/stale", "do not reap"); put(root, "machine/versions/9.9.9/aidlc", "do not dispatch"); put(root, "machine/pins.json", { retained: true });
  const engine = join(tools, "aidlc.ts");
  return (flags: string[], foreignCwd = false, windows = false) => {
    const before = snapshot(root); const argv = ["engine", "progress", ...flags];
    const result = spawnSync(process.execPath, windows ? ["-e", `Object.defineProperty(process,'platform',{value:'win32'});const {main}=await import(${JSON.stringify(engine)});await main(${JSON.stringify(argv)});`] : [engine, ...argv], {
      cwd: foreignCwd ? foreign : root, encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: join(machine, "home"), USERPROFILE: join(machine, "home"), TMPDIR: join(machine, "tmp"), TMP: join(machine, "tmp"), TEMP: join(machine, "tmp"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: join(machine, "bin"), AIDLC_PROJECT_DIR: foreign, CLAUDE_PROJECT_DIR: foreign, KIRO_PROJECT_DIR: foreign, AIDLC_DISPATCH_TOOLS_DIR: join(foreign, "unused"), AIDLC_PIN_DISPATCHED: "9.9.9" },
    });
    expect(result.error).toBeUndefined(); expect(snapshot(root)).toEqual(before);
    const body = JSON.parse(result.stdout); expect(result.stdout).toBe(`${JSON.stringify(body)}\n`); expect(body.schemaVersion).toBe(1);
    expect(result.status, result.stderr).toBe(body.state === "error" ? 1 : 0);
    if (body.state === "error") expect(body).toEqual({ schemaVersion: 1, state: "error", error: { code: expect.any(String), message: expect.any(String) } });
    return { body, stderr: result.stderr };
  };
}

test("CLI pin differences warn only on stderr; cwd and explicit project bypass startup mutations", () => {
  const root = fresh(); const run = cli(root);
  for (const pin of [null, AIDLC_VERSION, "9.9.9", "../invalid"]) {
    if (pin !== null) put(root, ".aidlc-version", pin);
    for (const foreign of [false, true]) {
      const result = run(["--json", ...(foreign ? ["--project-dir", root] : [])], foreign, pin === "../invalid");
      expect(result.body.state).toBe("ok"); expect(result.body.project.dir).toBe(root); expect(result.body.selected.totals).toEqual({ completed: 1, total: 3, skipped: 0 });
      if (pin !== null && pin !== AIDLC_VERSION) expect(result.stderr).toStartWith("PIN_MISMATCH:"); else expect(result.stderr).toBe("");
    }
  }
});

test("CLI rejects help, positional, duplicate and unsafe options as one JSON error", () => {
  const root = fresh(); const run = cli(root);
  for (const [flags, code] of [[[], "JSON_REQUIRED"], [["--help"], "INVALID_ARGUMENT"], [["--json", "extra"], "INVALID_ARGUMENT"],
    [["--json", "--json"], "INVALID_ARGUMENT"], [["--json", "--project-dir"], "INVALID_ARGUMENT"], [["--json", "--project-dir=relative"], "INVALID_ARGUMENT"],
    [["--json", "--project-dir", "relative"], "INVALID_PROJECT_DIR"], [["--json", "--space", "main", "--space", "design"], "INVALID_ARGUMENT"],
    [["--json", "--intent", "delivery"], "INVALID_SELECTION"], [["--json", "--space", "../escape"], "INVALID_SELECTION"],
    [["--json", "--", "--project-dir", root], "INVALID_ARGUMENT"], [["--json", "--quiet"], "INVALID_ARGUMENT"]] as [string[], string][]) {
    const result = run(flags); expect(result.body.error.code).toBe(code); expect(result.stderr).toBe("");
  }
});

test("CLI explicit intent selection preserves full census; unavailable plans never trigger recovery", () => {
  const root = fresh(); put(root, REGISTRY, [{ uuid: "record-abcd", slug: "delivery", dirName: "delivery-abcd", status: "active" }, row(0)]);
  put(root, `${BASE}/work-0/aidlc-state.md`, state()); put(root, "aidlc/active-space", "main"); const run = cli(root);
  expect(run(["--json"]).body.state).toBe("selection-required");
  for (const intent of ["record-abcd", "delivery"]) {
    const body = run(["--json", "--space", "main", "--intent", intent]).body;
    expect(body.selected.id).toBe("record-abcd"); expect(body.intents).toHaveLength(2);
  }
  rmSync(join(root, DATA, "stage-graph.json")); expect(run(["--json", "--space", "main", "--intent", "delivery"]).body.error.code).toBe("SOURCE_UNREADABLE");
});

test("CLI missing stamp is allowed but unsafe pins and absent project paths fail without writes", () => {
  const root = fresh(false); rmSync(join(root, DATA, "aidlc-stamp.json")); const run = cli(root);
  expect(run(["--json"]).body).toMatchObject({ state: "empty", project: { stamp: null } });
  expect(run(["--json", "--project-dir", join(root, "missing")]).body.error.code).toBe("SOURCE_UNREADABLE");
  put(root, REGISTRY, "{"); expect(run(["--json"]).body.error.code).toBe("MALFORMED_JSON");
  symlinkSync(join(root, REGISTRY), join(root, ".aidlc-version")); expect(run(["--json"]).body.error.code).toBe("UNSAFE_FILE_KIND");
});
