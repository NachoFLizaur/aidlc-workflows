// covers: hook:aidlc-state-transition-guard, hook:aidlc-plan-approval-guard,
// hook:aidlc-review-freeze, hook:aidlc-record-human-turn, hook:aidlc-continue-workflow
import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { auditBlockField, readAuditShardEvents, summaryAuthorizationRecordPath, writeSessionBinding } from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT, seededAuditShard, seededRecordDir, seedStateFile } from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import corpus from "../fixtures/kiro-crew/payloads.json";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTestProject(root); });
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
    CLAUDE_PROJECT_DIR: undefined, AIDLC_SESSION_OVERRIDE: undefined, AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
    AIDLC_COMPILED_EXECUTABLE: undefined, KIROCREW_HOOK_EVENT: undefined, KIROCREW_HOOK_CONTEXT: undefined, AIDLC_UNATTENDED: undefined,
    AIDLC_HARNESS_NAME: "kiro-crew", AIDLC_HARNESS_DIR: ".kiro-crew" }, "production");
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
  return { project, tree, home, gateway, adapter, entry, artifact, env, payload, invoke, binding, bind, pre };
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
