// covers: hook:aidlc-state-transition-guard, hook:aidlc-plan-approval-guard,
// hook:aidlc-review-freeze, hook:aidlc-record-human-turn, hook:aidlc-continue-workflow
import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { auditBlockField, readAuditShardEvents, runWithOwnerStampedLock, summaryAuthorizationRecordPath, writeSessionBinding } from "../../core/tools/aidlc-lib.ts";
import { boundCrewBackend, crewBackendFromRecords, type CrewBackendObservation } from "../../harness/kiro-crew/hooks/aidlc-kiro-crew-hook-entry.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT, seededAuditShard, seededRecordDir, seedStateFile } from "../harness/fixtures.ts";
import { connect, type RpcResponse } from "../harness/kiro-crew-live.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import corpus from "../fixtures/kiro-crew/payloads.json";
import claudeCorpus from "../fixtures/kiro-crew/claude-payloads.json";
import codexCorpus from "../fixtures/kiro-crew/codex-payloads.json";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const roots: string[] = [];
const clients: ReturnType<typeof connect>[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); for (const root of roots.splice(0)) cleanupTestProject(root); });
const key = corpus.spawn.parent_session_key;
const hash = createHash("sha256").update(key).digest("hex");
const session = `crew-${hash}`;
const guards = ["state-transition-guard", "plan-approval-guard", "review-freeze"];
type Payload = Record<string, unknown>;
type Call = { hook: string; payload: { tool_name?: string; tool_input?: Record<string, unknown>; session_id: string; agent_type?: string }; project: string; session: string; token?: string };
function fixture() {
  const project = createTestProject(); roots.push(project);
  const tree = join(project, ".kiro-crew");
  for (const part of [".kiro-crew", "aidlc", "kiro-crew-app"]) cpSync(join(REPO_ROOT, "dist/kiro-crew", part), join(project, part), { recursive: true });
  const home = join(project, "crew home"); const gateway = join(project, "gateway"); mkdirSync(home); mkdirSync(gateway);
  const adapter = join(tree, "hooks/aidlc-kiro-crew-adapter.ts");
  const entry = join(project, "kiro-crew-app/hooks/aidlc-kiro-crew-hook-entry.ts");
  const artifact = join(seededRecordDir(project), "inception/requirements-analysis/requirements.md");
  const env = testGuardEnvironment({ ...process.env, HOME: home, KIROCREW_HOME: home, AIDLC_PROJECT_DIR: project,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    CLAUDE_PROJECT_DIR: undefined, AIDLC_SESSION_OVERRIDE: undefined, AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
    AIDLC_COMPILED_EXECUTABLE: undefined, KIROCREW_HOOK_EVENT: undefined, KIROCREW_HOOK_CONTEXT: undefined, AIDLC_UNATTENDED: undefined,
    AIDLC_HARNESS_NAME: "kiro-crew", AIDLC_HARNESS_DIR: ".kiro-crew", AIDLC_CREW_BACKEND: "kiro" }, "production");
  const engineBinding = join(project, "aidlc/.aidlc-sessions", `${session}.binding.json`);
  const observe = (backend = "kiro", provider: unknown = "acp", extra: Payload = {}) => {
    mkdirSync(dirname(engineBinding), { recursive: true });
    writeFileSync(engineBinding, JSON.stringify({ space: "default", intent: null, boundAt: new Date().toISOString(), backend, ...extra }));
    writeFileSync(join(home, "session_map.json"), JSON.stringify({ [key]: { cwd: project, provider } }));
  };
  observe();
  const payload = (name: Exclude<keyof typeof corpus, "automation">): Payload => JSON.parse(JSON.stringify(corpus[name]).replaceAll("{{PROJECT}}", project).replaceAll("{{ARTIFACT}}", artifact));
  const invoke = (data: Payload | string, options: { entry?: boolean; env?: NodeJS.ProcessEnv; target?: string; route?: string[]; preload?: string } = {}) => {
    const event = options.target ?? (typeof data === "string" ? "PreToolUse" : String(data.hook_event_name));
    return spawnSync(process.execPath, [...(options.preload ? ["--preload", options.preload] : []), options.entry ? entry : adapter,
      ...(options.entry ? options.route ?? ["engine", "adapter", "kiro-crew", event] : [event])], {
      cwd: gateway, env: { ...env, ...options.env }, encoding: "utf8", input: typeof data === "string" ? data : JSON.stringify(data), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), maxBuffer: 4 * 1024 * 1024,
    });
  };
  const binding = join(home, "apps/aidlc/data/bindings", `${hash}.json`);
  const bind = () => { mkdirSync(dirname(binding), { recursive: true }); writeFileSync(binding, JSON.stringify({ projectDir: project, boundAt: new Date().toISOString() })); };
  const pre = (tool_name: string, tool_input?: unknown, extra: Payload = {}) => ({ hook_event_name: "PreToolUse", parent_session_key: key, tool_name, ...(tool_input === undefined ? {} : { tool_input }), ...extra });
  return { project, tree, home, gateway, adapter, entry, artifact, env, payload, invoke, binding, bind, pre, engineBinding, observe };
}
type Fixture = ReturnType<typeof fixture>;
function instrument(f: Fixture, responses: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const path = join(f.project, "calls.jsonl");
  for (const hook of [...guards, "reviewer-scope", "record-human-turn", "session-start", "continue-workflow", "write-audit-log"]) {
    const response = responses[hook] ?? {};
    writeFileSync(join(f.tree, "hooks", `aidlc-${hook}.ts`), `import {appendFileSync} from 'node:fs';
      const payload = JSON.parse(await Bun.stdin.text());
      appendFileSync(${JSON.stringify(path)}, JSON.stringify({hook:${JSON.stringify(hook)},payload,project:process.env.AIDLC_PROJECT_DIR,session:process.env.AIDLC_SESSION_OVERRIDE,token:process.env.AIDLC_INTERNAL_HUMAN_TURN_TOKEN})+${JSON.stringify("\n")});
      process.stdout.write(${JSON.stringify(response.stdout ?? "")}); process.stderr.write(${JSON.stringify(response.stderr ?? "")}); process.exit(${response.code ?? 0});`);
  }
  return () => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Call) : [];
}
function postFixture() {
  const f = fixture(); seedStateFile(f.project, "state-mid-inception.md");
  writeSessionBinding(f.project, session, "default", basename(seededRecordDir(f.project)));
  const shard = seededAuditShard(f.project); mkdirSync(dirname(shard), { recursive: true }); writeFileSync(shard, "# AI-DLC Audit Log\n");
  mkdirSync(dirname(f.artifact), { recursive: true }); writeFileSync(f.artifact, "# Requirements\n");
  const authorization = (recorded_at = new Date(Math.floor(Date.now() / 1000) * 1000 - 2000).toISOString()) => {
    const value = { version: 1, id: createHash("sha256").update(recorded_at).digest("hex"), stage: "requirements-analysis", unit: null, workflow: null, attempt: "fixture", questions_file: "questions.md", questions_sha256: createHash("sha256").update("questions").digest("hex"), choice: "Looks correct", recorded_at };
    const path = summaryAuthorizationRecordPath(seededRecordDir(f.project), value.stage, null);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); return value;
  };
  const rows = () => readAuditShardEvents(f.project, basename(seededRecordDir(f.project)), "default").filter(({ event }) => event === "ARTIFACT_CREATED" || event === "ARTIFACT_UPDATED");
  return { ...f, shard, authorization, rows };
}

test("event validation denies guarded malformed and conflicting envelopes", () => {
  const f = fixture(); const calls = instrument(f);
  for (const data of ["{", "[]", f.pre("Write", { path: "src/a.ts" }, { hook_event_name: "Stop" }), { ...f.pre("Write", {}), hook_event_name: undefined }]) {
    expect(f.invoke(data, { target: "PreToolUse" }).status).toBe(2);
  }
  expect(f.invoke("{", { target: "PostToolUse" }).status).toBe(0);
  expect(f.invoke(f.payload("spawn"), { env: { KIROCREW_HOOK_EVENT: "PreToolUse" } }).status).toBe(2);
  expect(calls()).toEqual([]);
});

test("missing guards refuse before read-only exemptions and subprocess refusals relay unchanged", () => {
  const f = fixture(); instrument(f);
  rmSync(join(f.tree, "hooks/aidlc-plan-approval-guard.ts"));
  expect(f.invoke(f.pre("@aidlc:engine/aidlc_status", {})).status).toBe(2);
  const calls = instrument(f, { "state-transition-guard": { code: 2, stderr: "precise core refusal\n" } });
  const result = f.invoke(f.payload("write"));
  expect(result.status).toBe(2); expect(result.stderr).toBe("precise core refusal\n");
  expect(calls().map(({ hook }) => hook)).toEqual(["state-transition-guard"]);
});

test("unexpected core failure denies permission calls but remains advisory for notifications", () => {
  const f = fixture(); instrument(f, { "state-transition-guard": { code: 1 }, "session-start": { code: 1 } });
  rmSync(f.engineBinding);
  const denied = f.invoke(f.payload("write")); expect(denied.status).toBe(2); expect(denied.stderr).toContain("failed (exit 1)");
  const advisory = f.invoke(f.payload("spawn")); expect(advisory.status).toBe(0); expect(advisory.stderr).toContain("failed (exit 1)");
});

test("structured file batches retain read and write operations in guard order", () => {
  const f = fixture(); const calls = instrument(f);
  const result = f.invoke(f.pre("fs_read", { operations: [{ mode: "Line", path: "src/read.ts" }, { command: "create", path: "src/write.ts" }] }));
  expect(result.status, result.stderr).toBe(0);
  expect(calls().map(({ hook, payload }) => [hook, payload.tool_name, payload.tool_input?.file_path])).toEqual([
    ...guards.map((hook) => [hook, "Read", join(f.project, "src/read.ts")]), ...guards.map((hook) => [hook, "Write", join(f.project, "src/write.ts")]),
  ]);
});

test("malformed file targets, traversal and symlink escapes never reach guards", () => {
  const f = fixture(); const calls = instrument(f);
  symlinkSync(f.home, join(f.project, "linked"));
  for (const input of [{ path: "../outside" }, { path: "linked/a" }, { path: "\0" }, { paths: [] }, { path: 4 }, { command: "unknown", path: "src/a" }, { operations: [{ command: "create" }] }, { path: "src/a", mode: "unknown" }, { path: "src/a", limit: 0 }, { path: "src/a", offset: -1 }, { path: "src/a", unexpected: true }]) {
    expect(f.invoke(f.pre("fs_read", input)).status, JSON.stringify(input)).toBe(2);
  }
  expect(calls()).toEqual([]);
});

test("closed task-list and read-only MCP schemas exempt only their exact input", () => {
  const f = fixture(); const calls = instrument(f);
  for (const [tool, input] of [
    ["todo_list", { command: "create", task_list_description: "tasks", tasks: [{ task_description: "review", details: "notes" }] }],
    ["todo_list", { command: "complete", completed_task_ids: ["one"] }],
    ["@aidlc:engine/aidlc_status", {}], ["@aidlc:engine/aidlc_bind_session", { session_key: key }],
    ["@kirocrew-core/ask_question", { question: "Which?", options: ["one", "two"] }],
    ["@aidlc:engine/aidlc_engine", { args: ["doctor", "--verbose", "--json"] }],
  ] as const) expect(f.invoke(f.pre(tool, input)).status).toBe(0);
  expect(calls()).toEqual([]);
  for (const [tool, input] of [["todo_list", { command: "complete", completed_task_ids: [] }], ["@aidlc:engine/aidlc_status", { extra: true }], ["@unowned/read", {}]]) {
    f.invoke(f.pre(String(tool), input));
  }
  expect(calls().filter(({ hook }) => hook === guards[0])).toHaveLength(3);
});

test("shell and engine MCP mutation argv are guard input, never shell execution", () => {
  const f = fixture(); const calls = instrument(f); const marker = join(f.project, "must-not-exist");
  const command = `touch '${marker}'`;
  expect(f.invoke(f.pre("Running: shell", { command })).status).toBe(0);
  expect(calls()[0].payload.tool_input?.command).toBe(command);
  expect(f.invoke(f.pre("@aidlc:engine/aidlc_engine", { args: ["engine", "orchestrate", "next", "literal ' ; value"] })).status).toBe(0);
  expect(calls()[3].payload.tool_name).toBe("Bash");
  expect(calls()[3].payload.tool_input?.command).toContain("orchestrate");
  expect(existsSync(marker)).toBe(false);
  expect(f.invoke(f.pre("Running: shell")).status).toBe(2);
});

test("unknown structured tools stay guarded while title-only file notifications are advisory", () => {
  const f = fixture(); const calls = instrument(f);
  expect(f.invoke(f.pre("mystery", { value: 1 })).status).toBe(0);
  expect(calls().map(({ payload }) => payload.tool_name)).toEqual(["mystery", "mystery", "mystery"]);
  const advisory = f.invoke(f.pre("Creating note.md"));
  expect(advisory.status).toBe(0); expect(advisory.stderr).toContain("advisory"); expect(calls()).toHaveLength(3);
});

test("reviewer veto precedes MCP and task-list exemptions; inspectable reads reach reviewer guard last", () => {
  const f = fixture(); const calls = instrument(f); const role = { agent_role: "aidlc-crew-product-lead-agent" };
  for (const [name, input] of [["@aidlc:engine/aidlc_status", {}], ["todo_list", { command: "complete", completed_task_ids: ["one"] }], ["unknown", {}], ["Creating note.md", undefined]] as const) {
    const result = f.invoke(f.pre(name, input, role)); expect(result.status).toBe(2); expect(result.stderr).toContain("reviewer-scope veto");
  }
  expect(calls()).toEqual([]);
  expect(f.invoke(f.pre("fs_read", { path: "src/a.ts" }, role)).status).toBe(0);
  expect(calls().map(({ hook }) => hook)).toEqual([...guards, "reviewer-scope"]);
  expect(calls().every(({ payload }) => payload.agent_type === "aidlc-product-lead-agent")).toBe(true);
});

test("real transition guard refuses lifecycle mutation and allows state inspection", () => {
  const f = fixture();
  const denied = f.invoke(f.pre("execute_bash", { command: "bun .kiro-crew/tools/aidlc-state.ts approve user-stories" }));
  expect(denied.status).toBe(2); expect(denied.stderr).toMatch(/cannot be changed|only.*workflow/i);
  const allowed = f.invoke(f.pre("execute_bash", { command: "bun .kiro-crew/tools/aidlc-state.ts show" }));
  expect(allowed.status, allowed.stderr).toBe(0);
});

test("admitted human turns get fresh dispatcher tokens and automation cannot enter authority", () => {
  const f = fixture(); const path = join(f.project, "tokens.jsonl");
  writeFileSync(join(f.tree, "tools/aidlc.ts"), `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(path)}, JSON.stringify({args:process.argv.slice(2),token:process.env.AIDLC_INTERNAL_HUMAN_TURN_TOKEN,input:JSON.parse(await Bun.stdin.text())})+${JSON.stringify("\n")});`);
  for (let i = 0; i < 2; i++) expect(f.invoke(f.payload("human")).status).toBe(0);
  for (const prompt of corpus.automation) expect(f.invoke({ ...f.payload("human"), prompt }).stderr).toContain("HUMAN_TURN not recorded");
  for (const flags of [{ subagent_id: "child" }, { stop_hook_active: true }, { hook_continuation_count: 1 }]) expect(f.invoke({ ...f.payload("human"), ...flags }).stderr).toContain("HUMAN_TURN not recorded");
  const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(rows).toHaveLength(2); expect(rows[0].token).not.toBe(rows[1].token);
  for (const row of rows) { expect(row.token).toMatch(/^[a-z0-9-]+$/); expect(row.args[0]).toBe("--internal-aidlc-record-human-turn"); expect(row.input.session_id).toBe(session); }
});

test("AgentSpawn unwraps core context and a valid binding avoids lifecycle replay", () => {
  const f = fixture(); const calls = instrument(f, { "session-start": { stdout: JSON.stringify({ additionalContext: "workflow context" }) } });
  rmSync(f.engineBinding);
  expect(f.invoke(f.payload("spawn")).stdout).toBe("workflow context");
  writeSessionBinding(f.project, session, "team", null);
  expect(f.invoke(f.payload("spawn")).stdout).toBe(`AIDLC Runtime Session: ${session}\n`);
  expect(calls()).toHaveLength(1);
});

test("create and replace outputs invoke real audit stamping without duplicate suppression", () => {
  const f = postFixture(); const auth = f.authorization();
  for (const name of ["created", "replaced", "replaced"] as const) expect(f.invoke(f.payload(name)).status).toBe(0);
  expect(f.rows().map(({ event }) => event)).toEqual(["ARTIFACT_CREATED", "ARTIFACT_UPDATED", "ARTIFACT_UPDATED"]);
  for (const row of f.rows()) expect(auditBlockField(row.block, "Summary Authorization Id")).toBe(auth.id);
});

test("write freshness admits its exact floor and rejects stale or invalid authorization times", () => {
  const f = postFixture(); const auth = f.authorization(); const floor = Date.parse(auth.recorded_at);
  utimesSync(f.artifact, floor / 1000, floor / 1000);
  expect(f.invoke(f.payload("replaced")).status).toBe(0); expect(f.rows()).toHaveLength(1);
  for (const timestamp of [new Date(floor + 1000).toISOString(), "invalid"]) {
    f.authorization(timestamp); const before = f.rows();
    expect(f.invoke(f.payload("replaced")).stderr).toContain("freshness failed"); expect(f.rows()).toEqual(before);
  }
});

test("PostToolUse rejects unsupported outputs, children and unsafe artifact boundaries", () => {
  const f = postFixture(); f.authorization();
  const foreign = join(f.project, "foreign.md"); writeFileSync(foreign, "untouched");
  const link = join(dirname(f.artifact), "linked.md"); symlinkSync(f.artifact, link);
  const directory = dirname(f.artifact);
  for (const fields of [
    { subagent_id: "child" }, { agent_role: "aidlc-developer-agent" }, { tool_name: "unknown" },
    { tool_response: { output: 3 } }, { tool_response: { output: "Successfully appended text." } },
    ...[foreign, link, directory, join(directory, "absent.md"), "relative.md"].map((path) => ({ tool_response: { output: `Successfully created ${path} (1 lines).` } })),
  ]) {
    const result = f.invoke({ ...f.payload("created"), ...fields }); expect(result.status).toBe(0); expect(result.stderr).toContain("advisory"); expect(f.rows()).toEqual([]);
  }
  expect(readFileSync(foreign, "utf8")).toBe("untouched");
});

test("unstamped codekb writes remain observable and missing audit or hook failure drops rows", () => {
  const f = postFixture(); const path = join(f.project, "aidlc/spaces/default/codekb/repo/overview.md"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "old"); utimesSync(path, 1, 1);
  const payload = { ...f.payload("created"), tool_response: { output: `Successfully created ${path} (1 lines).` } };
  expect(f.invoke(payload).status).toBe(0); expect(f.rows()).toHaveLength(1);
  expect(auditBlockField(f.rows()[0].block, "Summary Authorization Id")).toBeNull();
  rmSync(f.shard); expect(f.invoke(payload).stderr).toContain("audit shard missing"); expect(existsSync(f.shard)).toBe(false);
  instrument(f, { "write-audit-log": { code: 1 } });
  expect(f.invoke(payload).status).toBe(0); expect(existsSync(f.shard)).toBe(false);
});

test("in-process PostToolUse restores all ambient resolver pins", async () => {
  const f = postFixture(); const adapter = await import(pathToFileURL(f.adapter).href) as { run(target: string, input: string): Promise<number> };
  const pins = ["AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "AIDLC_HARNESS_DIR", "AIDLC_HARNESS_NAME", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE"];
  const old = pins.map((pin) => process.env[pin]);
  try {
    process.env.AIDLC_PROJECT_DIR = f.project;
    const before = pins.map((pin) => process.env[pin]);
    expect(await adapter.run("PostToolUse", JSON.stringify({ ...f.payload("created"), subagent_id: "child" }))).toBe(0);
    expect(pins.map((pin) => process.env[pin])).toEqual(before);
  } finally { pins.forEach((pin, index) => { if (old[index] === undefined) delete process.env[pin]; else process.env[pin] = old[index]; }); }
});

test("outstanding children and malformed ledgers suppress Stop without rewriting transport state", () => {
  const f = fixture(); const calls = instrument(f, { "continue-workflow": { stdout: '{"decision":"block","reason":"continue"}' } });
  const path = join(f.project, "aidlc/.aidlc-sessions", `${session}.crew-dispatch.json`); mkdirSync(dirname(path), { recursive: true });
  for (const raw of [JSON.stringify({ outstanding: [{ childId: "child", task: "work", stage: "code-generation", dispatchedAt: new Date().toISOString() }] }), "{bad"] ) {
    writeFileSync(path, raw); const result = f.invoke(f.payload("stop")); expect(result.status).toBe(0); expect(result.stdout).toBe(""); expect(calls()).toEqual([]); expect(readFileSync(path, "utf8")).toBe(raw);
  }
  writeFileSync(path, '{"outstanding":[]}');
  expect(JSON.parse(f.invoke(f.payload("stop")).stdout)).toEqual({ decision: "block", reason: "continue" }); expect(calls()).toHaveLength(1);
});

test("invalid core Stop decisions are advisory rather than fabricated blocks", () => {
  const f = fixture();
  for (const stdout of ["not json", "null", '{"decision":"allow"}', '{"decision":"block","reason":""}']) {
    instrument(f, { "continue-workflow": { stdout } }); const result = f.invoke(f.payload("stop"));
    expect(result.status).toBe(0); expect(result.stdout).toBe(""); expect(result.stderr.length).toBeGreaterThan(0);
  }
});

test("entry distinguishes absent binding from corrupt routing and honors explicit project pins", () => {
  const f = fixture(); const calls = instrument(f);
  const options = { entry: true, env: { AIDLC_PROJECT_DIR: undefined } };
  expect(f.invoke(f.payload("write"), options).stderr).toContain("not participating"); expect(calls()).toEqual([]);
  f.bind(); writeFileSync(f.binding, "{");
  expect(f.invoke(f.payload("write"), options).status).toBe(2); expect(f.invoke(f.payload("spawn"), options).status).toBe(0);
  expect(calls()).toEqual([]); expect(readFileSync(f.binding, "utf8")).toBe("{");
  expect(f.invoke(f.payload("write"), { entry: true }).status).toBe(0); expect(calls()).toHaveLength(3);
  expect(existsSync(join(f.gateway, "aidlc"))).toBe(false);
});

test("entry validates route and import before forwarding original bytes with pinned context", () => {
  const f = fixture(); f.bind(); const path = join(f.project, "entry.json");
  writeFileSync(f.adapter, `import {writeFileSync} from 'node:fs'; const env = {cwd:process.cwd(),project:process.env.AIDLC_PROJECT_DIR,session:process.env.AIDLC_SESSION_OVERRIDE,harness:process.env.AIDLC_HARNESS_NAME,compiled:process.env.AIDLC_COMPILED_EXECUTABLE}; export function run(target: string,input: string,extra: string[]) {writeFileSync(${JSON.stringify(path)},JSON.stringify({env,target,input,extra})); process.stdout.write('x'.repeat(200000)); return 2;}`);
  const raw = `${JSON.stringify(f.payload("write"), null, 2)}\n`;
  const result = f.invoke(raw, { entry: true, env: { AIDLC_PROJECT_DIR: undefined, AIDLC_COMPILED_EXECUTABLE: "foreign", AIDLC_SESSION_OVERRIDE: "foreign" }, route: ["engine", "adapter", "kiro-crew", "PreToolUse", "literal value"] });
  expect(result.status).toBe(2); expect(result.stdout).toHaveLength(200000);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ env: { cwd: f.project, project: f.project, session, harness: "kiro-crew" }, target: "PreToolUse", input: raw, extra: ["literal value"] });
  rmSync(path);
  expect(f.invoke(raw, { entry: true, route: ["engine", "adapter", "other", "PreToolUse"] }).status).toBe(2); expect(existsSync(path)).toBe(false);
  writeFileSync(f.adapter, "throw new Error('import failed')");
  expect(f.invoke(raw, { entry: true }).status).toBe(2);
  expect(f.invoke(f.payload("spawn"), { entry: true }).status).toBe(0);
});

test("capture redacts persisted secrets without changing adapter input or exit", () => {
  const f = fixture(); const data = join(f.home, "apps/aidlc/data"); mkdirSync(data, { recursive: true }); writeFileSync(join(data, "capture-hooks.enabled"), "");
  const marker = join(f.project, "forwarded.json");
  writeFileSync(f.adapter, `import {writeFileSync} from 'node:fs'; export function run(_target: string,input: string) {writeFileSync(${JSON.stringify(marker)},input);return 2;}`);
  const payload = { ...f.payload("write"), api_key: "secret-value", prompt: `Bearer private-token ${f.home}` };
  expect(f.invoke(payload, { entry: true }).status).toBe(2);
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(payload);
  const captures = join(data, "captures"); const names = readdirSync(captures); expect(names).toHaveLength(1);
  const text = readFileSync(join(captures, names[0]), "utf8");
  for (const secret of [key, "private-token", "secret-value", f.home]) expect(text).not.toContain(secret);
  expect(text).toContain("<redacted>"); expect(statSync(captures).mode & 0o777).toBe(0o700); expect(statSync(join(captures, names[0])).mode & 0o777).toBe(0o600);
});

test("unsafe capture files and ownership failures leave the adapter verdict unchanged", () => {
  for (const fault of ["flag-link", "flag-directory", "capture-link", "owner", "exclusive"]) {
    const f = fixture(); const data = join(f.home, "apps/aidlc/data"); mkdirSync(data, { recursive: true }); const flag = join(data, "capture-hooks.enabled");
    if (fault === "flag-link") symlinkSync(f.adapter, flag); else if (fault === "flag-directory") mkdirSync(flag); else writeFileSync(flag, "");
    if (fault === "capture-link") symlinkSync(f.gateway, join(data, "captures"));
    let preload: string | undefined;
    if (fault === "owner" || fault === "exclusive") {
      preload = join(f.project, "capture-fault.ts");
      writeFileSync(preload, `import {mock} from 'bun:test'; import * as fs from 'node:fs'; const lstat = fs.lstatSync; const open = fs.openSync;
        mock.module('node:fs', () => ({...fs,lstatSync: (...args) => { const info=lstat(...args); if (${JSON.stringify(fault)}==='owner' && args[0]===${JSON.stringify(data)}) info.uid = -1; return info; },openSync: (...args) => { if (${JSON.stringify(fault)}==='exclusive' && String(args[0]).includes('captures')) { fs.writeFileSync(${JSON.stringify(join(f.project, "capture-flags.json"))},JSON.stringify(args[1])); throw Object.assign(new Error('exists'),{code:'EEXIST'}); } return open(...args); }}));`);
    }
    writeFileSync(f.adapter, "export function run() {return 2;}");
    expect(f.invoke(f.payload("write"), { entry: true, preload }).status).toBe(2);
    expect(readdirSync(f.gateway)).toEqual([]);
    if (fault === "exclusive") expect(JSON.parse(readFileSync(join(f.project, "capture-flags.json"), "utf8")) & constants.O_EXCL).toBe(constants.O_EXCL);
    if (fault === "owner" || fault === "exclusive" || fault === "capture-link") expect(f.invoke(f.payload("write"), { entry: true, preload }).stderr).toContain("outcome unchanged");
  }
});

type Receipt = { path: string; atMs: number; commandHash: string };
function claudeFixture() {
  const f = postFixture(); f.env.AIDLC_CREW_BACKEND = "claude";
  // Isolate adapter correlation from guard policy, but keep the actual audit hook.
  const calls = instrument(f);
  cpSync(join(REPO_ROOT, "dist/kiro-crew/.kiro-crew/hooks/aidlc-write-audit-log.ts"), join(f.tree, "hooks/aidlc-write-audit-log.ts"));
  const path = join(f.home, "apps/aidlc/data/receipts", `${hash}.jsonl`);
  const entries = (): Receipt[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const seed = (rows: Receipt[]) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "")); };
  const payload = (name: "request" | "receipt" | "failure" | "rejection", artifact = f.artifact): Payload => JSON.parse(JSON.stringify(claudeCorpus[name]).replaceAll("{{KEY}}", key).replaceAll("{{ARTIFACT}}", artifact));
  const clock = join(f.project, "clock.ts");
  const at = (data: Payload, ms: number, env: NodeJS.ProcessEnv = {}) => { writeFileSync(clock, `Date.now = () => ${ms};`); return f.invoke(data, { preload: clock, env }); };
  const now = Date.now();
  const fresh = (ms = now, file = f.artifact) => { writeFileSync(file, "# Requirements\n"); utimesSync(file, ms / 1000, ms / 1000); };
  return { ...f, calls, path, entries, seed, claude: payload, at, now, fresh };
}

test("backend observations require the own provider and safe corroborating binding before import", () => {
  const f = fixture(); const map = join(f.home, "session_map.json");
  for (const [provider, backend] of claudeCorpus.providers) {
    if (backend !== "kiro" && backend !== "claude" && backend !== "unknown") throw new Error("Invalid expected backend in payload fixture");
    f.observe(backend, provider);
    expect(crewBackendFromRecords(f.home, key)).toEqual({ backend }); expect(boundCrewBackend(f.home, f.project, key)).toEqual({ backend });
  }
  for (const path of [map, f.engineBinding]) for (const fault of ["missing", "foreign", "malformed", "oversize", "link", "directory"]) {
    f.observe(); rmSync(path);
    if (fault === "link") symlinkSync(f.adapter, path);
    else if (fault === "directory") mkdirSync(path);
    else if (fault !== "missing") writeFileSync(path, fault === "foreign" ? JSON.stringify({ foreign: { provider: "acp" } }) : fault === "oversize" ? " ".repeat(4 * 1024 * 1024 + 1) : "{");
    expect(boundCrewBackend(f.home, f.project, key), `${path}:${fault}`).toEqual({ backend: "unknown" }); rmSync(path, { recursive: true, force: true });
  }
  const marker = join(f.project, "backend.json");
  writeFileSync(f.adapter, `import {writeFileSync} from 'node:fs'; const backend=process.env.AIDLC_CREW_BACKEND; export function run(){writeFileSync(${JSON.stringify(marker)},JSON.stringify(backend));return 0;}`);
  for (const extra of [{}, { backendConflict: true }, { backendConflict: false }]) {
    f.observe("claude", "claude_code", extra);
    expect(f.invoke({ ...f.payload("write"), ...claudeCorpus.child }, { entry: true, env: { AIDLC_CREW_BACKEND: "kiro" } }).status).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toBe("backendConflict" in extra ? "unknown" : "claude");
  }
});

test("unresolved backend refuses participating Pre and drops Post without defeating opt-out or guard checks", () => {
  const f = postFixture(); const calls = instrument(f);
  for (const backend of [undefined, "unknown", "claude_code", "kas", ""]) {
    const env = { AIDLC_CREW_BACKEND: backend };
    const pre = f.invoke(f.pre("mcp__aidlc_engine__aidlc_status", {}), { env });
    expect(pre.status).toBe(2); expect(pre.stderr).toContain("unknown or conflicting backend");
    expect(f.invoke(f.payload("created"), { env }).status).toBe(0); expect(f.rows()).toEqual([]);
  }
  f.observe("kiro", "claude_code");
  expect(f.invoke(f.payload("write"), { entry: true }).status).toBe(2); expect(calls()).toEqual([]);
  expect(f.invoke(f.payload("write"), { entry: true, env: { AIDLC_PROJECT_DIR: undefined } }).stderr).toContain("not participating");
  rmSync(join(f.tree, "hooks/aidlc-plan-approval-guard.ts"));
  const result = f.invoke(f.pre("mcp__aidlc_engine__aidlc_status", {}), { env: { AIDLC_CREW_BACKEND: "claude" } });
  expect(result.status).toBe(2); expect(result.stderr).toContain("aidlc-plan-approval-guard.ts");
});

test("Claude MCP aliases exempt exact schemas while malformed bind selectors stay guarded", () => {
  const f = claudeFixture();
  for (const name of ["mcp__aidlc_engine__aidlc_bind_session", "@aidlc:engine/aidlc_bind_session"]) {
    for (const input of [{}, { session_key: key }, { project_dir: f.project }, { session_key: key, project_dir: f.project }]) expect(f.invoke(f.pre(name, input)).status).toBe(0);
    expect(f.calls()).toEqual([]);
  }
  for (const input of [undefined, { extra: true }, { session_key: "" }, { project_dir: "\0" }, { project_dir: 1 }]) {
    const before = f.calls().length; expect(f.invoke(f.pre("mcp__aidlc_engine__aidlc_bind_session", input)).status).toBe(0);
    expect(f.calls().slice(before).map(({ payload }) => payload.tool_name)).toEqual(guards.map(() => "mcp__aidlc:engine__aidlc_bind_session"));
  }
  const start = f.calls().length;
  expect(f.invoke(f.pre("mcp__aidlc_engine__aidlc_engine", { args: ["engine", "orchestrate", "next"] })).status).toBe(0);
  expect(f.calls().slice(start).map(({ payload }) => payload.tool_name)).toEqual(guards.map(() => "Bash")); expect(f.entries()).toEqual([]);
});

test("Claude omitted fields stay advisory except native delegation, shell commands and reviewer vetoes", () => {
  const f = claudeFixture();
  for (const title of claudeCorpus.omitted) {
    const result = f.invoke(f.pre(title)); expect(result.status).toBe(0); expect(result.stderr).toContain("advisory");
    expect(f.invoke(f.pre(title, undefined, { agent_role: "aidlc-crew-product-lead-agent" })).status).toBe(2);
  }
  for (const title of ["Task", "Agent", "Bash", "Terminal"]) {
    const result = f.invoke(f.pre(title)); expect(result.status).toBe(2);
    expect(result.stderr).toContain(title === "Task" || title === "Agent" ? "notification-path denial is advisory" : "malformed guarded tool input");
  }
  expect(f.calls()).toEqual([]);
  expect(f.invoke(f.pre("Read requirements.md", { file_path: f.artifact })).status).toBe(0);
  expect(f.calls().map(({ payload }) => payload.tool_input?.file_path)).toEqual(guards.map(() => f.artifact));
  for (const path of ["../escape", "\0"]) expect(f.invoke(f.pre("Write requirements.md", { file_path: path })).status).toBe(2);
  expect(f.calls()).toHaveLength(3);
});

test("only conductor Bash requests passing every guard can append authority and Pre never audits", () => {
  for (const hook of guards) {
    const f = claudeFixture(); const calls = instrument(f, { [hook]: { code: 2, stderr: "guard refused\n" } });
    const result = f.invoke(f.claude("request")); expect(result.status).toBe(2); expect(result.stderr).toBe("guard refused\n");
    expect(calls().map(({ hook }) => hook)).toEqual(guards.slice(0, guards.indexOf(hook) + 1)); expect(f.entries()).toEqual([]); expect(f.rows()).toEqual([]);
  }
  const f = claudeFixture();
  for (const extra of [claudeCorpus.child, { agent_role: "foreign" }]) { expect(f.invoke({ ...f.claude("request"), ...extra }).status).toBe(0); expect(f.entries()).toEqual([]); }
  expect(f.invoke(f.pre("Bash", { command: "ARTIFACT \0" })).status).toBe(2);
  expect(f.at(f.claude("request"), f.now).status).toBe(0); expect(f.entries()).toMatchObject([{ path: f.artifact, atMs: f.now }]); expect(f.rows()).toEqual([]);
});

test("receipt extraction grants only literal in-boundary paths and ignores heredoc bodies and expansions", () => {
  const f = claudeFixture(); const linked = join(dirname(f.artifact), "linked.md"); symlinkSync(f.artifact, linked);
  for (const command of [`cat <<'EOF'\nARTIFACT ${f.artifact}\nEOF`, `printf 'ARTIFACT %s' "$TARGET"`, `printf 'ARTIFACT %s' '${join(f.project, "outside.md")}'`, `printf 'ARTIFACT %s' '${linked}'`, `cat <<$DELIMITER\nARTIFACT ${f.artifact}`]) {
    expect(f.invoke(f.pre("Bash", { command })).status).toBe(0); expect(f.entries()).toEqual([]);
  }
  const spaced = join(dirname(f.artifact), "with spaces.md");
  expect(f.at(f.claude("request", spaced), f.now).status).toBe(0);
  expect(f.entries().map(({ path }) => path)).toEqual([spaced]); expect(existsSync(spaced)).toBe(false); expect(f.rows()).toEqual([]);
});

test("receipt storage refuses relative homes, corrupt schemas, unsafe files and live contention without repair", () => {
  const f = claudeFixture();
  expect(f.invoke(f.claude("request"), { env: { KIROCREW_HOME: "relative" } }).status).toBe(2); expect(existsSync(f.path)).toBe(false);
  for (const raw of ["{", "{}\n", JSON.stringify({ path: f.artifact, atMs: -1, commandHash: hash }), "x".repeat(1024 * 1024 + 1)]) {
    mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, raw);
    expect(f.invoke(f.claude("request")).status).toBe(2); expect(readFileSync(f.path, "utf8")).toBe(raw);
  }
  rmSync(f.path); symlinkSync(f.artifact, f.path); const bytes = readFileSync(f.artifact);
  expect(f.invoke(f.claude("request")).status).toBe(2); expect(readFileSync(f.artifact)).toEqual(bytes); rmSync(f.path); mkdirSync(f.path);
  expect(f.invoke(f.claude("request")).status).toBe(2); rmSync(f.path, { recursive: true });
  const lock = runWithOwnerStampedLock(`${f.path}.lock`, 0, 0, () => {
    const result = f.invoke(f.claude("request")); expect(result.status).toBe(2); expect(result.stderr).toContain("lock contended"); expect(existsSync(f.path)).toBe(false);
  }); expect(lock.acquired).toBe(true);
});

test("receipt capacity admits 256 paths and persists expiry even when the next append refuses", () => {
  const f = claudeFixture(); const paths = Array.from({ length: 256 }, (_, i) => join(dirname(f.artifact), `artifact-${i}.md`));
  const command = `printf 'ARTIFACT %s' ${paths.map((path) => `'${path}'`).join(" ")}`;
  expect(f.at(f.pre("Bash", { command }), f.now).status).toBe(0); expect(f.entries()).toHaveLength(256);
  expect(statSync(f.path).mode & 0o777).toBe(0o600); expect(statSync(dirname(f.path)).mode & 0o777).toBe(0o700);
  const pending = f.entries(); f.seed([{ ...pending[0], atMs: f.now - 600001 }, ...pending]);
  const denied = f.at(f.claude("request"), f.now); expect(denied.status).toBe(2); expect(denied.stderr).toContain("256 pending"); expect(f.entries()).toEqual(pending);
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
  f.seed([{ ...pending[0], atMs: f.now - 600001 }, { ...pending[1], atMs: f.now - 600000 }]);
  expect(f.at(f.claude("receipt"), f.now).stderr).toContain("prior unconsumed"); expect(f.entries()).toEqual([{ ...pending[1], atMs: f.now - 600000 }]);
});

test("byte-identical requests coalesce through 2000 milliseconds and retain earliest arrival", () => {
  const f = claudeFixture(); const request = f.claude("request");
  expect(f.at(request, f.now).status).toBe(0); const first = f.entries()[0];
  expect(f.at(request, f.now + 2000).status).toBe(0); expect(f.entries()).toEqual([first]);
  expect(f.at(request, f.now - 1).status).toBe(0); expect(f.entries()).toEqual([{ ...first, atMs: f.now - 1 }]);
  expect(f.at(request, f.now + 2000).status).toBe(0); expect(f.entries()).toHaveLength(2);
  expect(f.entries().map(({ atMs }) => atMs)).toEqual([f.now - 1, f.now + 2000]); expect(f.rows()).toEqual([]);
});

test("newest prior request wins regardless of append order, leaving older and future entries pending", () => {
  const f = claudeFixture(); f.authorization();
  expect(f.at(f.claude("request"), f.now).status).toBe(0); const first = f.entries()[0];
  expect(f.at(f.claude("request"), f.now + 2001).status).toBe(0); const newest = f.entries()[1];
  const future = { ...first, atMs: f.now + 10000 }; f.seed([future, newest, first]); f.fresh(f.now + 3000);
  expect(f.at(f.claude("receipt"), f.now + 3000).stderr).toBe(""); expect(f.entries()).toEqual([future, first]); expect(f.rows()).toHaveLength(1);
  expect(f.at(f.claude("receipt"), f.now + 3000).stderr).toBe(""); expect(f.entries()).toEqual([future]); expect(f.rows()).toHaveLength(2);
  expect(f.at(f.claude("receipt"), f.now + 3000).stderr).toContain("prior unconsumed"); expect(f.rows()).toHaveLength(2);
});

test("independent paths consume per entry and a foreign session cannot consume the conductor request", () => {
  const f = claudeFixture(); f.authorization(); const other = join(dirname(f.artifact), "other.md");
  for (const file of [f.artifact, other]) expect(f.at(f.claude("request", file), f.now).status).toBe(0);
  f.fresh(f.now, f.artifact); f.fresh(f.now, other); const before = f.entries();
  expect(f.at({ ...f.claude("receipt"), parent_session_key: "dashboard:other" }, f.now).stderr).toContain("prior unconsumed"); expect(f.entries()).toEqual(before);
  expect(f.at(f.claude("receipt", other), f.now).stderr).toBe(""); expect(f.entries().map(({ path }) => path)).toEqual([f.artifact]);
  expect(f.at(f.claude("receipt"), f.now).stderr).toBe(""); expect(f.entries()).toEqual([]); expect(f.rows()).toHaveLength(2);
  expect(f.at(f.claude("receipt"), f.now).stderr).toContain("prior unconsumed"); expect(f.rows()).toHaveLength(2);
});

test("Claude receipt grammar drops titled, child, foreign-role and malformed fenced Posts without consuming", () => {
  const f = claudeFixture(); expect(f.at(f.claude("request"), f.now).status).toBe(0); const before = f.entries();
  const bad: Payload[] = [
    ...[claudeCorpus.child, { agent_role: "foreign" }, { tool_name: "Bash" }, { tool_name: "Write requirements.md" }].map((extra) => ({ ...f.claude("receipt"), ...extra })),
    ...claudeCorpus.invalidOutputs.map((output) => ({ ...f.claude("receipt"), tool_response: { output: output.replaceAll("{{ARTIFACT}}", f.artifact) } })),
  ];
  for (const payload of bad) { const result = f.at(payload, f.now); expect(result.status).toBe(0); expect(result.stderr).toContain("advisory"); expect(f.entries()).toEqual(before); expect(f.rows()).toEqual([]); }
});

test("receipt freshness rechecks request and authorization floors plus the actual file boundary", () => {
  const f = claudeFixture(); f.authorization(); expect(f.at(f.claude("request"), f.now).status).toBe(0); const pending = f.entries();
  for (const fault of ["stale-request", "stale-authorization", "missing", "directory", "link", "outside"]) {
    f.fresh(f.now); f.authorization(); f.seed(pending);
    if (fault === "stale-request") utimesSync(f.artifact, (f.now - 1) / 1000, (f.now - 1) / 1000);
    if (fault === "stale-authorization") f.authorization(new Date(f.now + 1000).toISOString());
    if (["missing", "directory", "link"].includes(fault)) rmSync(f.artifact);
    if (fault === "directory") mkdirSync(f.artifact);
    if (fault === "link") symlinkSync(f.adapter, f.artifact);
    const outside = join(f.project, "outside.md");
    if (fault === "outside") { writeFileSync(outside, "foreign"); f.seed([{ ...pending[0], path: outside }]); }
    const result = f.at(f.claude("receipt", fault === "outside" ? outside : f.artifact), f.now);
    expect(result.status).toBe(0); expect(result.stderr).toContain("advisory"); expect(f.rows()).toEqual([]); expect(f.entries()).toHaveLength(1);
    rmSync(f.artifact, { force: true, recursive: true });
  }
  f.seed(pending); f.authorization(new Date(f.now).toISOString()); f.fresh(f.now);
  expect(f.at(f.claude("receipt"), f.now).stderr).toBe(""); expect(f.rows()).toHaveLength(1); expect(f.entries()).toEqual([]);
});

test("failed or rejected Posts consume prior requests before title admission but exclude future and child Posts", () => {
  const f = claudeFixture(); expect(f.at(f.claude("request"), f.now).status).toBe(0); const first = f.entries()[0];
  const future = { ...first, atMs: f.now + 1000 };
  for (const name of ["failure", "rejection"] as const) {
    f.seed([first, future]);
    expect(f.at({ ...f.claude(name), ...claudeCorpus.child }, f.now).status).toBe(0); expect(f.entries()).toEqual([first, future]);
    const result = f.at(f.claude(name), f.now); expect(result.status).toBe(0); expect(result.stderr).toContain("consumed-failed"); expect(f.entries()).toEqual([future]); expect(f.rows()).toEqual([]);
  }
  f.seed([first]);
  expect(f.at({ ...f.claude("receipt"), tool_response: { output: `\`\`\`console\nExit code 1\nARTIFACT ${f.artifact}\n\`\`\`` } }, f.now).stderr).toContain("consumed-failed");
  expect(f.entries()).toEqual([]); expect(f.rows()).toEqual([]);
});

test("fresh Claude receipt consumes before real audit stamping and lost emission cannot replay", () => {
  const f = claudeFixture(); const auth = f.authorization();
  expect(f.at(f.claude("request"), f.now).status).toBe(0); f.fresh(f.now);
  expect(f.at(f.claude("receipt"), f.now).stderr).toBe(""); expect(f.entries()).toEqual([]);
  expect(f.rows()).toHaveLength(1); expect(auditBlockField(f.rows()[0].block, "Summary Authorization Id")).toBe(auth.id);
  expect(auditBlockField(f.rows()[0].block, "File")).toBe(`<project-dir>/${relative(f.project, f.artifact).replaceAll("\\", "/")}`);
  expect(f.at(f.claude("request"), f.now + 3000).status).toBe(0); f.fresh(f.now + 3000);
  writeFileSync(join(f.tree, "hooks/aidlc-write-audit-log.ts"), "process.exit(1)");
  expect(f.at(f.claude("receipt"), f.now + 3000).stderr).toContain("failed (exit 1)"); expect(f.entries()).toEqual([]);
  expect(f.at(f.claude("receipt"), f.now + 3000).stderr).toContain("prior unconsumed"); expect(f.rows()).toHaveLength(1);
});

test("real Claude guard denial cannot leave a Bash receipt request behind", () => {
  const f = postFixture(); f.env.AIDLC_CREW_BACKEND = "claude";
  const command = `bun .kiro-crew/tools/aidlc-state.ts approve user-stories; printf 'ARTIFACT %s' '${f.artifact}'`;
  const result = f.invoke(f.pre("Bash", { command })); expect(result.status).toBe(2); expect(result.stderr).toMatch(/cannot be changed|only.*workflow/i);
  expect(existsSync(join(f.home, "apps/aidlc/data/receipts", `${hash}.jsonl`))).toBe(false); expect(f.rows()).toEqual([]);
});

// Include directories, link targets, file modes, bytes and mtimes: refusing a
// call must not silently create routing state or rewrite an identical record.
function snapshot(root: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name; const full = join(root, path);
    if (entry.isDirectory()) { result[`${path}/`] = "directory"; Object.assign(result, snapshot(root, path)); }
    else if (entry.isSymbolicLink()) result[path] = `link:${readlinkSync(full)}`;
    else result[path] = `${statSync(full).mode}:${statSync(full).mtimeMs}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
  }
  return result;
}
function codexReason(text: string) {
  expect(text).toContain("Codex is not supported as a Kiro Crew backend");
  expect(text).toContain("intercept Codex tool permissions or identify the calling conversation");
  expect(text).toContain("Choose Kiro CLI or Claude Code with its documented limits in Crew, then rerun setup and doctor.");
  expect(text).toContain("Version changes do not bypass this refusal.");
  expect(text).toContain("docs/guide/harnesses/kiro-crew.md#codex-backend");
  expect(text).toContain("The native Codex CLI harness is unaffected.");
}
function refused(response: RpcResponse) {
  expect(response.error).toBeUndefined(); expect(response.result?.isError, JSON.stringify(response)).toBe(true);
  codexReason(response.result!.content![0].text);
}
function bridgeFixture() {
  const f = fixture(); const bridge = join(f.project, "kiro-crew-app/mcp/aidlc-mcp-bridge.ts");
  const trace = join(f.project, "engine-calls.jsonl"); const engine = join(f.tree, "tools/aidlc.ts");
  const engineBody = `import {appendFileSync,writeFileSync,mkdirSync} from 'node:fs';
    appendFileSync(${JSON.stringify(trace)},JSON.stringify({args:process.argv.slice(2),backend:process.env.AIDLC_CREW_BACKEND,session:process.env.AIDLC_SESSION_OVERRIDE,project:process.env.AIDLC_PROJECT_DIR,compiled:process.env.AIDLC_COMPILED_EXECUTABLE})+'\\n');`;
  writeFileSync(engine, `${engineBody} console.log('engine completed');`);
  const execTrace = join(f.project, "exec-calls.jsonl"); const execSpy = join(f.project, "bridge-exec.ts");
  writeFileSync(execSpy, `import {mock} from 'bun:test';import * as cp from 'node:child_process';import {appendFileSync} from 'node:fs';const exec=cp.execFile;mock.module('node:child_process',()=>({...cp,execFile:(command,args,options,callback)=>{appendFileSync(${JSON.stringify(execTrace)},JSON.stringify({command,args,backend:options.env.AIDLC_CREW_BACKEND})+'\\n');return exec(command,args,options,callback);}}));`);
  const env = { ...f.env, KIROCREW_SESSION_KEY: key, AIDLC_CREW_BACKEND: "claude", AIDLC_COMPILED_EXECUTABLE: join(f.gateway, "never-execute") };
  const tools: { name: string; arguments: Record<string, unknown> }[] = [{ name: "aidlc_bind_session", arguments: {} }, { name: "aidlc_status", arguments: {} }, { name: "aidlc_engine", arguments: { args: ["engine", "status"] } }];
  const rpc = (requests = tools, overrides: NodeJS.ProcessEnv = {}, preload?: string) => {
    const result = spawnSync(process.execPath, ["--preload", execSpy, ...(preload ? ["--preload", preload] : []), bridge, "mcp", "--crew-home", f.home], {
      cwd: f.gateway, env: { ...env, ...overrides }, encoding: "utf8", input: `${requests.map((params, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params })).join("\n")}\n`,
      timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as RpcResponse); expect(responses).toHaveLength(requests.length); return responses;
  };
  const client = (overrides: NodeJS.ProcessEnv) => { const c = connect({ command: process.execPath, args: ["--preload", execSpy, bridge, "mcp", "--crew-home", f.home] }, f.gateway, { ...env, ...overrides }); clients.push(c); return c; };
  const calls = () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const execs = () => existsSync(execTrace) ? readFileSync(execTrace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { ...f, bridge, engine, engineBody, trace, tools, rpc, client, calls, execs };
}

test("Codex observations retain their reason across stored conflicts and use the parent key before adapter import", () => {
  const f = fixture(); const marker = join(f.project, "import-backend.json"); const blocked = { backend: "blocked", reason: "codex" } satisfies CrewBackendObservation;
  writeFileSync(f.adapter, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({backend:process.env.AIDLC_CREW_BACKEND,session:process.env.AIDLC_SESSION_OVERRIDE}));export function run(){return 0;}`);
  for (const row of codexCorpus.observations) {
    f.observe(row.stored ?? "unknown", row.provider, row.backendConflict === undefined ? {} : { backendConflict: row.backendConflict });
    if (row.stored === null) rmSync(f.engineBinding);
    if (row.provider === "codex") expect(crewBackendFromRecords(f.home, key)).toEqual(blocked);
    expect(boundCrewBackend(f.home, f.project, key), JSON.stringify(row)).toEqual(blocked);
    expect(f.invoke({ ...f.payload("write"), ...claudeCorpus.child }, { entry: true, env: { AIDLC_CREW_BACKEND: "kiro" } }).status).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ backend: "blocked", session });
  }
  const map = join(f.home, "session_map.json");
  for (const fault of ["missing", "malformed", "link"]) {
    f.observe("blocked"); rmSync(map);
    if (fault === "malformed") writeFileSync(map, "{");
    if (fault === "link") symlinkSync(f.engineBinding, map);
    expect(crewBackendFromRecords(f.home, key)).toEqual({ backend: "unknown" }); expect(boundCrewBackend(f.home, f.project, key)).toEqual(blocked);
    rmSync(map, { force: true });
  }
  const child = "subagent:backend-child";
  for (const [parentProvider, childProvider, expected] of [["acp", "codex", "kiro"], ["codex", "acp", "blocked"]]) {
    f.observe("kiro"); writeFileSync(map, JSON.stringify({ [key]: { provider: parentProvider }, [child]: { provider: childProvider } }));
    expect(crewBackendFromRecords(f.home, child)).toEqual(childProvider === "codex" ? blocked : { backend: "kiro" });
    expect(crewBackendFromRecords(f.home, "toString")).toEqual({ backend: "unknown" });
    expect(f.invoke({ ...f.payload("write"), subagent_id: child }, { entry: true }).status).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ backend: expected, session });
  }
});

test("blocked hooks refuse before grammar or guards and leave receipts and audit untouched", () => {
  const f = claudeFixture(); f.authorization(); f.fresh(); f.bind(); f.observe("blocked", "codex", { intent: basename(seededRecordDir(f.project)) }); f.env.AIDLC_CREW_BACKEND = "blocked";
  f.seed([{ path: f.artifact, atMs: f.now, commandHash: hash }]);
  const before = snapshot(f.project);
  for (const entry of [false, true]) {
    for (const fields of codexCorpus.pre) {
      const data = JSON.parse(JSON.stringify(fields).replaceAll("{{ARTIFACT}}", f.artifact));
      const result = f.invoke({ ...f.payload("write"), ...data, tool_input: data.tool_input }, { entry });
      expect(result.status).toBe(2); codexReason(result.stderr);
      expect(f.calls()).toEqual([]); expect(snapshot(f.project)).toEqual(before);
    }
    for (const data of [f.payload("created"), f.claude("receipt"), f.claude("failure"), f.claude("rejection")]) {
      const result = f.invoke(data, { entry }); expect(result.status).toBe(0); expect(result.stderr).toContain("PostToolUse advisory"); codexReason(result.stderr);
      expect(f.calls()).toEqual([]); expect(f.rows()).toEqual([]); expect(snapshot(f.project)).toEqual(before);
    }
  }
  rmSync(join(f.tree, "hooks/aidlc-plan-approval-guard.ts")); const missing = snapshot(f.project);
  const guard = f.invoke(f.payload("write")); expect(guard.status).toBe(2); expect(guard.stderr).toContain("aidlc-plan-approval-guard.ts"); expect(guard.stderr).not.toContain("Codex is not supported"); expect(snapshot(f.project)).toEqual(missing);
  rmSync(f.binding); const unbound = snapshot(f.project);
  const optOut = f.invoke(f.payload("write"), { entry: true, env: { AIDLC_PROJECT_DIR: undefined } });
  expect(optOut.status).toBe(0); expect(optOut.stderr).toContain("not participating"); expect(snapshot(f.project)).toEqual(unbound);
});

test("every bridge tool rejects current or stored Codex before selection, binding, initialization or execution", () => {
  const f = bridgeFixture(); const map = join(f.home, "session_map.json");
  for (const state of ["missing", "fresh", "valid", "null-intent", "invalid-route"]) {
    f.observe("kiro", "codex"); rmSync(f.binding, { force: true });
    if (state === "missing" || state === "fresh") rmSync(dirname(f.engineBinding), { recursive: true });
    if (state !== "missing") f.bind();
    if (state === "valid") { seedStateFile(f.project, "state-mid-inception.md"); writeSessionBinding(f.project, session, "default", basename(seededRecordDir(f.project))); }
    if (state === "invalid-route") { writeFileSync(f.binding, "{"); writeFileSync(map, JSON.stringify({ [key]: { provider: "codex", cwd: "relative" } })); }
    const before = snapshot(f.project); for (const response of f.rpc()) refused(response);
    expect(f.calls()).toEqual([]); expect(f.execs()).toEqual([]); expect(snapshot(f.project), state).toEqual(before);
  }
  for (const stored of ["codex", "blocked"]) for (const provider of ["acp", "claude_code", null]) {
    f.observe(stored, provider, { backendConflict: true }); rmSync(f.binding, { force: true });
    const before = snapshot(f.project); for (const response of f.rpc()) refused(response);
    expect(f.calls()).toEqual([]); expect(f.execs()).toEqual([]); expect(snapshot(f.project)).toEqual(before); expect(existsSync(f.binding)).toBe(false);
  }
  for (const stored of [false, true]) {
    const child = "subagent:blocked-child"; const childHash = createHash("sha256").update(child).digest("hex");
    writeFileSync(map, JSON.stringify({ [key]: { provider: "acp", cwd: f.project }, [child]: { provider: stored ? "claude_code" : "codex", cwd: f.gateway } }));
    writeFileSync(join(f.home, "config.json"), JSON.stringify({ agent: { subagent_cwd_allowed_roots: [f.project] } }));
    if (stored) writeFileSync(join(dirname(f.engineBinding), `crew-${childHash}.binding.json`), JSON.stringify({ space: "default", intent: null, boundAt: new Date().toISOString(), backend: "blocked" }));
    const before = snapshot(f.project);
    refused(f.rpc([{ name: "aidlc_bind_session", arguments: { project_dir: f.project } }], { KIROCREW_SESSION_KEY: child })[0]);
    expect(snapshot(f.project)).toEqual(before); expect(f.calls()).toEqual([]); expect(f.execs()).toEqual([]); expect(existsSync(join(dirname(f.binding), `${childHash}.json`))).toBe(false);
  }
});

test("a warm admitted bridge rechecks a rekeyed Codex conversation without touching either session", async () => {
  const f = bridgeFixture(); const second = "dashboard:blocked";
  const mapping = join(f.home, `session_pid_${process.pid}.txt`); writeFileSync(mapping, key);
  writeFileSync(join(f.home, "session_map.json"), JSON.stringify({ [key]: { provider: "acp", cwd: f.project }, [second]: { provider: "codex", cwd: f.project } }));
  const client = f.client({ KIROCREW_SESSION_KEY: undefined, KIROCREW_HOST_PID: String(process.pid) });
  const first = await client.request("tools/call", f.tools[1]); expect(first.result?.isError, JSON.stringify(first)).toBe(false);
  expect(f.calls()).toEqual([{ args: ["engine", "status"], backend: "kiro", session, project: f.project }]);
  expect(f.execs()).toEqual([{ command: process.execPath, args: [f.engine, "engine", "status"], backend: "kiro" }]);
  writeFileSync(mapping, second); const before = snapshot(f.project);
  for (const params of f.tools) { refused(await client.request("tools/call", params)); expect(snapshot(f.project)).toEqual(before); }
  expect(f.calls()).toHaveLength(1);
});

test("bridge rechecks before execution and publication without erasing work already executed", () => {
  for (const boundary of ["before-exec", "initialization", "after-exec", "stored-after-exec"]) {
    const f = bridgeFixture(); f.bind(); const map = join(f.home, "session_map.json");
    const changeProvider = `writeFileSync(${JSON.stringify(map)},${JSON.stringify(JSON.stringify({ [key]: { provider: "codex", cwd: f.project } }))});`;
    const stored = JSON.stringify({ space: "default", intent: null, boundAt: new Date().toISOString(), backend: "blocked", backendConflict: true, retained: "engine output" });
    let preload: string | undefined;
    if (boundary === "before-exec") {
      f.observe("unknown"); preload = join(f.project, "publication-change.ts");
      writeFileSync(preload, `import {mock} from 'bun:test';import * as fs from 'node:fs';const rename=fs.renameSync;const writeFileSync=fs.writeFileSync;mock.module('node:fs',()=>({...fs,renameSync:(from,to)=>{const result=rename(from,to);if(to===${JSON.stringify(f.engineBinding)}){${changeProvider}}return result;}}));`);
    } else {
      if (boundary === "initialization") rmSync(f.engineBinding);
      const initialize = `mkdirSync(${JSON.stringify(dirname(f.engineBinding))},{recursive:true});writeFileSync(${JSON.stringify(f.engineBinding)},${JSON.stringify(JSON.stringify({ space: "default", intent: null, boundAt: "initialized" }))});`;
      writeFileSync(f.engine, `${f.engineBody}${boundary === "initialization" ? initialize : ""}${boundary === "stored-after-exec" ? `writeFileSync(${JSON.stringify(f.engineBinding)},${JSON.stringify(stored)});` : changeProvider}console.log('engine completed');`);
    }
    const bindingBefore = existsSync(f.engineBinding) ? { bytes: readFileSync(f.engineBinding), mtime: statSync(f.engineBinding).mtimeMs } : undefined;
    const response = f.rpc([f.tools[1]], {}, preload)[0]; refused(response);
    if (boundary === "before-exec") { expect(f.calls()).toEqual([]); expect(f.execs()).toEqual([]); expect(JSON.parse(readFileSync(f.engineBinding, "utf8"))).toMatchObject({ backend: "kiro" }); }
    else {
      expect(f.calls()).toEqual([{ args: boundary === "initialization" ? ["engine", "adapter", "kiro-crew", "AgentSpawn"] : ["engine", "status"], backend: boundary === "initialization" ? "unknown" : "kiro", session, project: f.project }]);
      expect(f.execs()).toEqual([{ command: process.execPath, args: [f.engine, ...f.calls()[0].args], backend: boundary === "initialization" ? "unknown" : "kiro" }]);
      if (boundary === "after-exec") {
        expect(response.result!.content![0].text).toContain("backend publication after engine execution failed");
        expect(readFileSync(f.engineBinding)).toEqual(bindingBefore!.bytes); expect(statSync(f.engineBinding).mtimeMs).toBe(bindingBefore!.mtime);
      } else expect(readFileSync(f.engineBinding, "utf8")).toBe(boundary === "stored-after-exec" ? stored : JSON.stringify({ space: "default", intent: null, boundAt: "initialized" }));
      expect(response.result!.content![0].text).not.toContain("engine completed");
    }
    const before = snapshot(f.project); for (const next of f.rpc()) refused(next); expect(snapshot(f.project)).toEqual(before);
  }
});
