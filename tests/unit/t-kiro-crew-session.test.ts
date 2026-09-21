// covers: hook:aidlc-session-start, hook:aidlc-record-human-turn,
// function:classifyEngineBinding, function:resolveCrewSessionKey
import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { auditBlockField, readAuditShardEvents, writeSessionBinding } from "../../core/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../core/tools/aidlc-testing-posture.ts";
import { resolveCrewSessionKey } from "../../harness/kiro-crew/mcp/aidlc-mcp-bridge.ts";
import { bindCrewSession, classifyEngineBinding, crewIdentityText, crewRecordedKeys, sessionHash } from "../../harness/kiro-crew/setup/aidlc-kiro-crew-setup.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT, removeWorkspaceRecord, runOrchestrateNext, seededRecordDir, seededStateFile, seedStateFile, withEnvAndFreshCaches } from "../harness/fixtures.ts";
import { connect, type RpcResponse } from "../harness/kiro-crew-live.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const roots: string[] = []; const clients: ReturnType<typeof connect>[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); for (const root of roots.splice(0)) cleanupTestProject(root); });
const fresh = () => { const root = createTestProject(); roots.push(root); return root; };
const runtime = join(REPO_ROOT, "dist/kiro-crew");
const json = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string) => { if (!existsSync(dir)) return; for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) { result[`${relative(root, path)}/`] = "dir"; visit(path); } else if (entry.isFile()) result[relative(root, path)] = `${statSync(path).mtimeMs}:${readFileSync(path).toString("base64")}`; } };
  visit(root); return result;
}
function fixture() {
  const root = fresh(); const home = join(root, "crew"); const app = join(root, "app"); const gateway = join(root, "gateway"); mkdirSync(home); mkdirSync(gateway); cpSync(join(runtime, "kiro-crew-app"), app, { recursive: true });
  const project = fresh();
  for (const part of [".kiro-crew", "aidlc"]) cpSync(join(runtime, part), join(project, part), { recursive: true });
  removeWorkspaceRecord(project);
  const key = "dashboard:session"; const session = `crew-${sessionHash(key)}`;
  const env = testGuardEnvironment({ PATH: process.env.PATH, HOME: root, TMPDIR: root, KIROCREW_HOME: home, KIROCREW_SESSION_KEY: key, AIDLC_INSTALL_ROOT: join(root, "machine"), AIDLC_BIN_DIR: join(root, "bin"), AIDLC_UNATTENDED: "0" }, "production");
  const binding = join(home, "apps/aidlc/data/bindings", `${sessionHash(key)}.json`);
  const engineBinding = join(project, "aidlc/.aidlc-sessions", `${session}.binding.json`);
  const map = (value: unknown = { [key]: { cwd: project } }) => json(join(home, "session_map.json"), value);
  const rpc = (requests: unknown[], options: { env?: NodeJS.ProcessEnv; args?: string[]; preload?: string; raw?: string } = {}) => spawnSync(process.execPath, [
    ...(options.preload ? ["--preload", options.preload] : []), join(app, "mcp/aidlc-mcp-bridge.ts"), ...(options.args ?? ["mcp", "--crew-home", home]),
  ], { cwd: gateway, env: { ...env, ...options.env }, encoding: "utf8", input: options.raw ?? `${requests.map((value) => JSON.stringify(value)).join("\n")}\n`, timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), maxBuffer: 10 * 1024 * 1024 });
  const call = (name = "aidlc_status", args: unknown = {}, options: Parameters<typeof rpc>[1] = {}) => {
    const result = rpc([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }], options);
    expect(result.status, result.stderr).toBe(0); return { ...result, response: JSON.parse(result.stdout) as RpcResponse };
  };
  const client = (overrides: NodeJS.ProcessEnv = {}) => { const c = connect({ command: process.execPath, args: [join(app, "mcp/aidlc-mcp-bridge.ts"), "mcp", "--crew-home", home] }, gateway, { ...env, ...overrides }); clients.push(c); return c; };
  const hook = (event: string, fields: Record<string, unknown> = {}) => spawnSync(process.execPath, [join(app, "hooks/aidlc-kiro-crew-hook-entry.ts"), "engine", "adapter", "kiro-crew", event], {
    cwd: gateway, env, encoding: "utf8", input: JSON.stringify({ hook_event_name: event, parent_session_key: key, ...fields }), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const engineEnv = { ...env, AIDLC_PROJECT_DIR: project, AIDLC_SESSION_OVERRIDE: session, AIDLC_HARNESS_DIR: ".kiro-crew", AIDLC_HARNESS_NAME: "kiro-crew" };
  return { root, home, app, gateway, project, key, session, env, engineEnv, binding, engineBinding, map, rpc, call, client, hook };
}
function ok(response: RpcResponse): string {
  expect(response.error).toBeUndefined(); expect(response.result?.isError, JSON.stringify(response)).toBe(false); return response.result!.content![0].text;
}

test("identity uses explicit, host, owner and parent records in order with bounded no-follow reads", () => {
  const f = fixture(); const scratch = join(f.home, "scratch"); mkdirSync(scratch);
  json(join(f.home, "session_map.json"), { "dashboard:map": {} });
  writeFileSync(join(f.home, `session_pid_${process.pid}.txt`), "dashboard:host\n");
  writeFileSync(join(f.home, `session_pid_${process.ppid}.txt`), "dashboard:parent\n");
  writeFileSync(join(scratch, ".owner"), String(process.pid));
  const keys = ["KIROCREW_SESSION_KEY", "KIROCREW_HOST_PID", "KIROCREW_SCRATCH"]; const previous = keys.map((key) => process.env[key]);
  try {
    Object.assign(process.env, { KIROCREW_SESSION_KEY: "dashboard:explicit", KIROCREW_HOST_PID: String(process.pid), KIROCREW_SCRATCH: scratch });
    expect(resolveCrewSessionKey(f.home)).toBe("dashboard:explicit"); delete process.env.KIROCREW_SESSION_KEY;
    expect(resolveCrewSessionKey(f.home)).toBe("dashboard:host"); delete process.env.KIROCREW_HOST_PID;
    expect(resolveCrewSessionKey(f.home)).toBe("dashboard:host"); delete process.env.KIROCREW_SCRATCH;
    expect(resolveCrewSessionKey(f.home)).toBe("dashboard:parent");
    expect(crewRecordedKeys(f.home)).toEqual(new Set(["dashboard:map", "dashboard:host", "dashboard:parent"]));
    const path = join(f.home, "identity"); writeFileSync(path, "x".repeat(4097)); expect(() => crewIdentityText(path)).toThrow();
    rmSync(path); symlinkSync(join(scratch, ".owner"), path); expect(() => crewIdentityText(path)).toThrow(); rmSync(path); mkdirSync(path); expect(() => crewIdentityText(path)).toThrow();
  } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
});

test("both binding readers distinguish missing, null, valid and corrupt state without repair", async () => {
  const f = fixture();
  const adapter = await import(pathToFileURL(join(f.project, ".kiro-crew/hooks/aidlc-kiro-crew-adapter.ts")).href) as { classifyEngineBinding: typeof classifyEngineBinding; crewSessionId(key: string): string };
  expect(adapter.crewSessionId(f.key)).toBe(`crew-${createHash("sha256").update(f.key).digest("hex")}`);
  expect(() => adapter.crewSessionId("\0")).toThrow();
  for (const classify of [classifyEngineBinding, adapter.classifyEngineBinding]) expect(classify(f.project, f.session).state).toBe("missing");
  const valid = { space: "team", intent: null, boundAt: "nonempty" };
  for (const value of [valid, { ...valid, intent: "missing" }, { ...valid, space: "../outside" }, { ...valid, boundAt: "" }, null]) {
    json(f.engineBinding, value); const before = readFileSync(f.engineBinding);
    for (const classify of [classifyEngineBinding, adapter.classifyEngineBinding]) expect(classify(f.project, f.session).state).toBe(value === valid ? "valid" : "corrupt");
    expect(readFileSync(f.engineBinding)).toEqual(before);
  }
  writeFileSync(f.engineBinding, "{"); expect(classifyEngineBinding(f.project, f.session).state).toBe("corrupt");
  rmSync(f.engineBinding); symlinkSync(join(f.project, ".kiro-crew/AGENTS.md"), f.engineBinding);
  for (const classify of [classifyEngineBinding, adapter.classifyEngineBinding]) expect(classify(f.project, f.session).state).toBe("corrupt");
});

test("a warm bridge rekeys and routes two projects without cross-project state writes", async () => {
  const f = fixture(); const other = fresh();
  for (const part of [".kiro-crew", "aidlc"]) cpSync(join(runtime, part), join(other, part), { recursive: true }); removeWorkspaceRecord(other);
  const second = "dashboard:second"; f.map({ [f.key]: { cwd: f.project }, [second]: { cwd: other } });
  const mapping = join(f.home, `session_pid_${process.pid}.txt`); writeFileSync(mapping, `${f.key}\n`);
  const c = f.client({ KIROCREW_SESSION_KEY: undefined, KIROCREW_HOST_PID: String(process.pid) });
  const beforeOther = snapshot(join(other, "aidlc"));
  ok(await c.request("tools/call", { name: "aidlc_status", arguments: {} }));
  expect(snapshot(join(other, "aidlc"))).toEqual(beforeOther); expect(existsSync(f.engineBinding)).toBe(true);
  const beforeFirst = snapshot(join(f.project, "aidlc")); writeFileSync(mapping, `${second}\n`);
  ok(await c.request("tools/call", { name: "aidlc_status", arguments: {} }));
  expect(snapshot(join(f.project, "aidlc"))).toEqual(beforeFirst);
  expect(existsSync(join(other, "aidlc/.aidlc-sessions", `crew-${sessionHash(second)}.binding.json`))).toBe(true);
  expect(existsSync(join(f.project, "aidlc/.aidlc-sessions", `crew-${sessionHash(second)}.binding.json`))).toBe(false);
  expect(existsSync(join(f.gateway, "aidlc"))).toBe(false);
});

test("repeated status and AgentSpawn preserve null selection and binding provenance", () => {
  const f = fixture(); f.map(); ok(f.call().response);
  const route = JSON.parse(readFileSync(f.binding, "utf8")); expect(route.source).toBe("session-map");
  writeSessionBinding(f.project, f.session, "team", null); const before = readFileSync(f.engineBinding); const mtime = statSync(f.engineBinding).mtimeMs;
  for (let i = 0; i < 2; i++) { ok(f.call().response); expect(f.hook("AgentSpawn").status).toBe(0); }
  expect(readFileSync(f.engineBinding)).toEqual(before); expect(statSync(f.engineBinding).mtimeMs).toBe(mtime);
  expect(JSON.parse(readFileSync(f.binding, "utf8"))).toEqual(route);
});

test("unbound negotiation, notifications and JSON-RPC errors remain protocol-only", () => {
  const f = fixture(); const before = snapshot(f.home);
  const result = f.rpc([], { env: { KIROCREW_SESSION_KEY: undefined }, raw: [
    "{", JSON.stringify({ jsonrpc: "1", id: 1, method: "ping" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "client-version" } }),
    JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "aidlc_status" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "missing" }), "",
  ].join("\n") });
  expect(result.status, result.stderr).toBe(0);
  const replies = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(replies).toHaveLength(5); expect(replies[0].error.code).toBe(-32700); expect(replies[1].error.code).toBe(-32600);
  expect(replies[2].result.protocolVersion).toBe("client-version"); expect(replies[3].result.tools.map(({ name }: { name: string }) => name).sort()).toEqual(["aidlc_bind_session", "aidlc_engine", "aidlc_status"]); expect(replies[4].error.code).toBe(-32601);
  expect(snapshot(f.home)).toEqual(before);
});

test("registered launch rejects invalid homes and ignores ambient project pins", () => {
  const f = fixture(); f.map();
  for (const args of [["mcp"], ["mcp", "--crew-home", "relative"], ["mcp", "--crew-home", join(f.root, "absent")], ["wrong", "--crew-home", f.home]]) expect(f.rpc([], { args }).status).toBe(1);
  ok(f.call("aidlc_status", {}, { env: { AIDLC_PROJECT_DIR: f.gateway, KIROCREW_HOME: f.gateway } }).response);
  expect(JSON.parse(readFileSync(f.binding, "utf8")).projectDir).toBe(f.project);
  const direct = fixture(); ok(direct.call("aidlc_status", {}, { args: [], env: { AIDLC_PROJECT_DIR: direct.project } }).response);
  expect(JSON.parse(readFileSync(direct.binding, "utf8")).source).toBe("direct-launch");
});

test("tool schemas and project overrides refuse before execution; raw argv is serialized literally", () => {
  const f = fixture(); f.map(); writeSessionBinding(f.project, f.session, "default", null);
  const marker = join(f.project, "argv.jsonl"); const engine = join(f.project, ".kiro-crew/tools/aidlc.ts");
  writeFileSync(engine, `import {appendFileSync} from 'node:fs'; const entry={args:process.argv.slice(2),session:process.env.AIDLC_SESSION_OVERRIDE,project:process.env.AIDLC_PROJECT_DIR,compiled:process.env.AIDLC_COMPILED_EXECUTABLE,source:process.env.AIDLC_SESSION_OVERRIDE_SOURCE}; appendFileSync(${JSON.stringify(marker)},JSON.stringify(entry)+${JSON.stringify("\n")}); console.log(JSON.stringify(entry));`);
  for (const [name, input] of [["missing", {}], ["aidlc_status", { value: 1 }], ["aidlc_engine", { args: "engine status" }], ["aidlc_engine", { args: [] }], ["aidlc_engine", { args: ["engine", "\0"] }], ["aidlc_engine", { args: ["config"] }], ["aidlc_engine", { args: ["engine", "--project-dir", f.project] }], ["aidlc_engine", { args: ["engine", `--project-dir=${f.project}`] }]]) expect(f.call(String(name), input).response.result?.isError).toBe(true);
  expect(existsSync(marker)).toBe(false);
  const values = ["literal ' ; $(value)", "long-token".repeat(600)];
  const result = f.rpc(values.map((value, id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "aidlc_engine", arguments: { args: ["engine", "orchestrate", "continue", value] } } })), { env: { AIDLC_COMPILED_EXECUTABLE: "foreign", AIDLC_SESSION_OVERRIDE_SOURCE: "foreign" } });
  expect(result.status).toBe(0);
  const rows = readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.map(({ args }) => args[3])).toEqual(values);
  for (const row of rows) { expect(row.session).toBe(f.session); expect(row.project).toBe(f.project); expect(row.compiled).toBeUndefined(); expect(row.source).toBeUndefined(); }
});

test("present corrupt routing, unsafe files and invalid stamps cannot fall back to launch cwd", () => {
  const f = fixture(); f.map();
  const mapPath = join(f.home, "session_map.json");
  for (const text of ["{", "[]", JSON.stringify({ [f.key]: { cwd: "relative" } }), JSON.stringify({ [f.key]: { cwd: 3 } }), " ".repeat(4 * 1024 * 1024 + 1)]) {
    writeFileSync(mapPath, text); expect(f.call("aidlc_status", {}, { env: { AIDLC_PROJECT_DIR: f.project } }).response.result?.isError).toBe(true); expect(existsSync(f.binding)).toBe(false); expect(readFileSync(mapPath, "utf8")).toBe(text);
  }
  f.map(); json(f.binding, {});
  expect(f.call().response.result?.isError).toBe(true); expect(readFileSync(f.binding, "utf8")).toBe("{}"); rmSync(f.binding);
  symlinkSync(mapPath, f.binding); expect(f.call().response.result?.isError).toBe(true); rmSync(f.binding);
  const stamp = join(f.project, ".kiro-crew/tools/data/aidlc-stamp.json"); writeFileSync(stamp, "{}");
  expect(f.call().response.result?.isError).toBe(true); expect(existsSync(f.binding)).toBe(false);
});

test("binding-map and explicit-key conflicts refuse without changing selected project", () => {
  const f = fixture(); const other = fresh(); f.map({ [f.key]: { cwd: f.project }, "dashboard:other": {} }); bindCrewSession(f.home, f.project, f.key);
  const before = readFileSync(f.binding); f.map({ [f.key]: { cwd: other }, "dashboard:other": {} });
  expect(f.call().response.result?.isError).toBe(true);
  for (const key of ["dashboard:unrecorded", "dashboard:other"]) expect(f.call("aidlc_bind_session", { session_key: key }).response.result?.isError).toBe(true);
  expect(readFileSync(f.binding)).toEqual(before); expect(existsSync(f.engineBinding)).toBe(false);
});

test("missing engine and advisory initialization failure cannot produce a ready session", () => {
  const f = fixture(); f.map(); const engine = join(f.project, ".kiro-crew/tools/aidlc.ts"); rmSync(engine);
  expect(f.call().response.result?.isError).toBe(true); expect(existsSync(f.binding)).toBe(false);
  writeFileSync(engine, "process.exit(0)");
  const result = f.call(); expect(result.response.result?.isError).toBe(true); expect(result.response.result?.content?.[0].text).toContain("did not create"); expect(existsSync(f.engineBinding)).toBe(false);
});

test("bridge binding snapshot changes are refused and competing bytes remain untouched", () => {
  const f = fixture(); f.map(); writeSessionBinding(f.project, f.session, "default", null);
  const preload = join(f.root, "binding-race.ts");
  writeFileSync(preload, `import {mock} from 'bun:test'; import * as fs from 'node:fs'; const write=fs.writeFileSync; mock.module('node:fs',()=>({...fs,writeFileSync:(...args)=>{const value=write(...args);if(String(args[0]).startsWith(${JSON.stringify(f.binding)}+'.'))write(${JSON.stringify(f.binding)},'competing');return value;}}));`);
  const result = f.call("aidlc_status", {}, { preload }); expect(result.response.result?.isError).toBe(true); expect(result.response.result?.content?.[0].text).toContain("changed during selection");
  expect(readFileSync(f.binding, "utf8")).toBe("competing"); expect(readdirSync(dirname(f.binding)).some((name) => name.endsWith(".tmp"))).toBe(false);
});

test("engine timeout and output overflow are tool errors rather than successful receipts", () => {
  const f = fixture(); f.map(); writeSessionBinding(f.project, f.session, "default", null);
  const engine = join(f.project, ".kiro-crew/tools/aidlc.ts"); const preload = join(f.root, "bounded-exec.ts"); const optionsPath = join(f.root, "options.json");
  // Shorten only the timer at the process boundary; execute the real child and
  // preserve the bridge's output limit, callback and error conversion.
  writeFileSync(preload, `import {mock} from 'bun:test'; import * as cp from 'node:child_process'; import {writeFileSync} from 'node:fs'; const exec=cp.execFile; mock.module('node:child_process',()=>({...cp,execFile:(command,args,options,callback)=>{writeFileSync(${JSON.stringify(optionsPath)},JSON.stringify({timeout:options.timeout,maxBuffer:options.maxBuffer}));return exec(command,args,{...options,timeout:100},callback);}}));`);
  for (const body of ["await Bun.sleep(10000);", "process.stdout.write('x'.repeat(5*1024*1024));"]) {
    writeFileSync(engine, body); const result = f.call("aidlc_status", {}, { preload }); expect(result.response.result?.isError).toBe(true);
    expect(JSON.parse(readFileSync(optionsPath, "utf8"))).toEqual({ timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  }
});

test("real same-session human summary confirmation records authority; automation and forged answers cannot", () => {
  const f = fixture(); f.map(); ok(f.call().response);
  ok(f.call("aidlc_engine", { args: ["engine", "intent", "create", "--scope", "express", "--arguments", "build a greeting", "--label", "greeting"] }).response);
  const selection = JSON.parse(readFileSync(f.engineBinding, "utf8")) as { intent: string };
  const record = join(f.project, "aidlc/spaces/default/intents", selection.intent);
  const questions = join(record, "inception/requirements-analysis/requirements-analysis-questions.md"); mkdirSync(dirname(questions), { recursive: true });
  const body = (answer: string) => `# Requirements\n\n## Summary\n\nKeep the greeting.\n\n## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]: ${answer}\n`;
  writeFileSync(questions, body(""));
  const identity = ["--stage", "requirements-analysis", "--checkpoint", "summary-confirmation", "--questions-file", relative(f.project, questions)];
  ok(f.call("aidlc_engine", { args: ["engine", "log", "decision", ...identity, "--decision", "Does this look correct?"] }).response);
  writeFileSync(questions, body("Looks correct"));
  const answer = () => f.call("aidlc_engine", { args: ["engine", "log", "answer", ...identity, "--details", "Looks correct"] }).response;
  expect(answer().result?.isError).toBe(true);
  expect(f.hook("UserPromptSubmit", { prompt: "[Subagent completion event] Looks correct" }).status).toBe(0); expect(answer().result?.isError).toBe(true);
  expect(f.hook("UserPromptSubmit", { prompt: "Looks correct" }).status).toBe(0); ok(answer());
  const rows = readAuditShardEvents(f.project, selection.intent, "default");
  expect(rows.filter(({ event }) => event === "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(1);
  expect(rows.filter(({ event }) => event === "HUMAN_TURN").map(({ block }) => auditBlockField(block, "Session"))).toEqual([f.session]);
});

test("engine-owned plan approval accepts own-words through the Crew hook and opens generation only afterwards", () => {
  const f = fixture(); f.map();
  // Seed only work and plan inputs; the engine creates the ask and receipt.
  const record = seededRecordDir(f.project); mkdirSync(record, { recursive: true });
  json(join(dirname(record), "intents.json"), [{ uuid: "00000000-0000-7000-8000-000000000001", slug: "fixture", dirName: basename(record), status: "in-flight" }]);
  writeFileSync(join(dirname(record), "active-intent"), basename(record)); seedStateFile(f.project, "state-brownfield-feature.md");
  const state = readFileSync(seededStateFile(f.project), "utf8").replace("- **Scope**: feature", "- **Scope**: poc").replace("- **Change Control**: strict (from scope feature)", "- **Guard Policy**: strict (set by you)\n- **Plan Approval**: on (set by you)").replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(f.project), state); writeSessionBinding(f.project, f.session, "default", basename(record)); bindCrewSession(f.home, f.project, f.key);
  const stage = join(record, "construction/code-generation"); mkdirSync(stage, { recursive: true });
  const contract = withEnvAndFreshCaches(f.engineEnv, () => renderTestingContract(resolveTestingPosture(f.project)));
  writeFileSync(join(stage, "code-generation-plan.md"), `# Code Generation Plan\n\n## Summary\n\n- Builds: greeting\n- Touches: src/greeting.ts\n\n## Steps\n\n- [ ] Build greeting\n\n${contract}`);
  writeFileSync(join(stage, "unit-test-instructions.md"), "# Unit Test Instructions\n\nCheck greeting output.\n");
  const next = () => runOrchestrateNext(join(f.project, ".kiro-crew/tools/aidlc-orchestrate.ts"), f.project, [], { cwd: f.project, env: f.engineEnv });
  const ask = next(); expect(ask.status, ask.out).toBe(0); expect(ask.directive).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  const write = () => f.hook("PreToolUse", { tool_name: "fs_write", tool_input: { command: "create", path: join(f.project, "src/greeting.ts") } });
  expect(write().status).toBe(2);
  expect(f.hook("UserPromptSubmit", { prompt: "[Continue — requested by the user] approve the plan" }).status).toBe(0); expect(write().status).toBe(2);
  expect(f.hook("UserPromptSubmit", { prompt: "I approve the plan, please go ahead." }).status).toBe(0);
  const approved = next(); expect(approved.status, approved.out).toBe(0); expect(approved.directive).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
  expect(write().status).toBe(0);
  expect(readAuditShardEvents(f.project, basename(record), "default").filter(({ event }) => event === "PLAN_APPROVAL_RECORDED")).toHaveLength(1);
});
