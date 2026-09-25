// covers: subcommand:aidlc-utility:doctor
import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { applyApp, bindCrewSession, checkAppIdentity, classifyApp, isInstalledInvocation, materializationPaths, materializeApp, materializeHooks, readMaterializationReceipt, verifyRegisteredSpecs, writeMaterializationReceipt } from "../../harness/kiro-crew/setup/aidlc-kiro-crew-setup.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const runtime = join(REPO_ROOT, "dist/kiro-crew"); const portable = join(runtime, "kiro-crew-app");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTestProject(root); });
const json = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const read = (path: string) => readFileSync(path, "utf8");
function snapshot(root: string, prefix = ""): Record<string, string> {
  if (!existsSync(root)) return {};
  const result: Record<string, string> = {};
  for (const item of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name; const full = join(root, path);
    if (item.isDirectory()) { result[`${path}/`] = "directory"; Object.assign(result, snapshot(root, path)); }
    else if (item.isSymbolicLink()) result[path] = `link:${readlinkSync(full)}`;
    else if (item.isFile()) result[path] = `${statSync(full).mode}:${statSync(full).mtimeMs}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
    else result[path] = `special:${lstatSync(full).mode}`;
  }
  return result;
}
type SetupReport = { rows: { what: string; status: string; detail: string }[]; changed: string[] };
function fixture() {
  const root = createTestProject(); roots.push(root);
  const project = join(root, "project"); const home = join(root, "crew home's directory"); mkdirSync(project); mkdirSync(home);
  const paths = materializationPaths(home); const config = join(home, "config.json");
  const env = { PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter), HOME: root, USERPROFILE: root, TMPDIR: root, KIROCREW_HOME: home, KIRO_HOME: join(home, "kiro"), AIDLC_INSTALL_ROOT: join(root, "machine"), AIDLC_BIN_DIR: join(root, "bin"), NO_COLOR: "1" };
  const run = (command: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}, preload?: string) => {
    const result = spawnSync(process.execPath, [...(preload ? ["--preload", preload] : []), join(portable, "setup/aidlc-kiro-crew-setup.ts"), command, "--crew-home", home, "--json", ...args], {
      cwd: project, env: { ...env, ...overrides }, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), maxBuffer: 8 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined(); return { ...result, report: JSON.parse(result.stdout) as SetupReport };
  };
  const grant = () => json(config, { agent: { apps_trusted: ["aidlc"], apps_trusted_local: ["aidlc"], subagent_cwd_allowed_roots: [project] } });
  // Only the external host boundary is simulated; all admission, materialization,
  // verification, receipt and cleanup decisions are the real setup implementation.
  const host = (args: string[]) => {
    if (args[1] === "install") cpSync(args[2], paths.appRoot, { recursive: true });
    json(join(paths.appRoot, "installed.json"), { enabled: args[1] === "enable" });
    const server = JSON.parse(read(join(paths.appRoot, "app.json"))).mcpServers.engine;
    for (const name of ["kirocrew", "aidlc--aidlc-crew"]) json(join(home, "kiro/agents", `${name}.json`), { mcpServers: { "aidlc:engine": server } });
    return "registered";
  };
  const install = () => { grant(); return applyApp(portable, home, host); };
  const owned = () => ({ home: snapshot(home), project: snapshot(project) });
  return { root, project, home, paths, config, env, run, grant, host, install, owned };
}
type Fixture = ReturnType<typeof fixture>;
const projectArgs = (f: Fixture) => ["--project-dir", f.project, "--runtime-root", runtime];
function doctorFixture() {
  const f = fixture();
  for (const name of [".kiro-crew", "aidlc"]) cpSync(join(runtime, name), join(f.project, name), { recursive: true });
  mkdirSync(join(f.project, ".git")); f.install();
  const hooks = materializeHooks(JSON.parse(read(join(portable, "hooks.fragment.json"))).hooks, f.paths);
  json(join(f.home, "hooks.json"), { hooks });
   const key = "dashboard:doctor"; json(join(f.home, "session_map.json"), { [key]: { cwd: f.project, provider: "acp" } });
  const binding = bindCrewSession(f.home, f.project, key); const session = `crew-${binding.keyHash}`;
  const invokeDoctor = (args: string[], env: NodeJS.ProcessEnv = {}, preload?: string) => {
    const result = spawnSync(process.execPath, [...(preload ? ["--preload", preload] : []), join(f.project, ".kiro-crew/tools/aidlc.ts"), "--doctor", "--offline", ...args], {
      cwd: f.project, env: { ...f.env, ...env }, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), maxBuffer: 8 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined(); return result;
  };
  const run = (env: NodeJS.ProcessEnv = {}, preload?: string) => {
    const result = invokeDoctor(["--json"], env, preload);
    const checks = (JSON.parse(result.stdout).data.checks as { label: string; pass: boolean; severity?: string }[]).filter(({ label }) => label.startsWith("Crew integration — "));
    const row = (name: string) => { const found = checks.find(({ label }) => label.startsWith(`Crew integration — ${name}:`)); expect(found, result.stdout).toBeDefined(); return found!; };
    return { ...result, checks, row };
  };
  return { ...f, key, session, binding, hooks, doctor: run, humanDoctor: (env: NodeJS.ProcessEnv = {}, preload?: string) => invokeDoctor(["--verbose"], env, preload) };
}

test("status and trust are read-only pending reports on an unconfigured project", () => {
  const f = fixture(); const before = f.owned();
  const status = f.run("status", ["--project-dir", f.project]);
  expect(status.status).toBe(0); expect(status.report.rows).toHaveLength(9);
  expect(status.report.rows.filter(({ status }) => status === "pending")).toHaveLength(6);
  expect(status.report.rows.filter(({ status }) => status !== "pending").every(({ status }) => status === "ok")).toBe(true);
  expect(f.run("trust").report.rows[0].status).toBe("pending"); expect(f.owned()).toEqual(before);
});

test("CLI grammar and invalid runtime roots refuse before config mutation", () => {
  const f = fixture(); const before = f.owned();
  for (const [command, args] of [["unknown", []], ["project", []], ["project", ["--project-dir", "relative"]], ["project", ["--project-dir", f.project]], ["project", ["--project-dir", f.project, "--runtime-root", f.home]], ["trust", ["--apply"]], ["trust", ["--json"]], ["bind", ["--session-key"]]] as [string, string[]][]) {
    expect(f.run(command, args).status, command).toBe(1); expect(f.owned()).toEqual(before);
  }
});

test("project setup installs the engine and preserves foreign config bytes and local consent", () => {
  const f = fixture(); const raw = '{ "foreign":1e2, "agent":{"subagent_cwd_allowed_roots":[]} }\n'; const local = join(f.home, "config.local.json");
  writeFileSync(join(f.project, "AGENTS.md"), "Operator instructions\n");
  writeFileSync(join(f.project, ".gitignore"), "local-cache/\n");
  writeFileSync(f.config, raw); writeFileSync(local, raw);
  expect(f.run("project", projectArgs(f)).status).toBe(0);
  expect(read(f.config).replace(JSON.stringify(f.project), "")).toBe(raw); expect(read(local)).toBe(raw);
  expect(existsSync(join(f.project, ".kiro-crew/tools/aidlc.ts"))).toBe(true);
  expect(read(join(f.project, "AGENTS.md"))).toBe("Operator instructions\n");
  expect(read(join(f.project, ".gitignore"))).toContain("local-cache/\n");
  expect(existsSync(join(f.project, ".kiro-crew/tools/data/providers.json"))).toBe(false);
  const result = f.run("project", [...projectArgs(f), "--apply-local"]); expect(result.status, result.stdout).toBe(0);
  expect(read(local).replace(JSON.stringify(f.project), "")).toBe(raw);
  const before = [read(f.config), read(local)];
  expect(f.run("project", [...projectArgs(f), "--apply-local"]).status).toBe(0); expect([read(f.config), read(local)]).toEqual(before);
});

test("invalid layered config and failed ordinary installer do not append cwd grants", () => {
  const f = fixture();
  for (const raw of ['{"agent":{},"agent":{}}', '{"agent":{"subagent_cwd_allowed_roots":3}}', "[]", "{"]) {
    writeFileSync(f.config, raw); const before = f.owned();
    expect(f.run("project", projectArgs(f)).status).toBe(1); expect(f.owned()).toEqual(before);
  }
  writeFileSync(f.config, "{}");
  const broken = join(f.root, "broken-runtime"); cpSync(runtime, broken, { recursive: true });
  writeFileSync(join(broken, ".kiro-crew/tools/aidlc.ts"), "process.exit(19)"); const before = f.owned();
  expect(f.run("project", ["--project-dir", f.project, "--runtime-root", broken]).status).toBe(1); expect(f.owned()).toEqual(before);
});

test("atomic setup writes refuse symlinks and changed snapshots without overwriting competitors", () => {
  const f = fixture(); const key = "dashboard:atomic"; json(join(f.home, "session_map.json"), { [key]: {} });
  const binding = bindCrewSession(f.home, f.project, key); const before = read(binding.path);
  const foreign = join(f.root, "foreign.json"); writeFileSync(foreign, "foreign"); rmSync(binding.path); symlinkSync(foreign, binding.path);
  expect(() => bindCrewSession(f.home, f.project, key)).toThrow("symlink"); expect(read(foreign)).toBe("foreign"); rmSync(binding.path);
  writeFileSync(binding.path, "{}");
  const preload = join(f.root, "snapshot-change.ts");
  writeFileSync(preload, `import {mock} from 'bun:test'; import * as fs from 'node:fs'; const write=fs.writeFileSync;
    mock.module('node:fs',()=>({...fs,writeFileSync:(...args)=>{const result=write(...args);if(String(args[0]).startsWith(${JSON.stringify(binding.path)}+'.'))write(${JSON.stringify(binding.path)},'competing writer');return result;}}));`);
  const result = f.run("bind", ["--project-dir", f.project, "--session-key", key], {}, preload);
  expect(result.status).toBe(1); expect(result.stdout).toContain("Changed during setup"); expect(read(binding.path)).toBe("competing writer");
  expect(readdirSync(dirname(binding.path)).some((name) => name.endsWith(".tmp"))).toBe(false);
  writeFileSync(binding.path, before); const mtime = statSync(binding.path).mtimeMs;
  expect(bindCrewSession(f.home, f.project, key).changed).toBe(false); expect(statSync(binding.path).mtimeMs).toBe(mtime);
});

test("hooks require stopped acknowledgement and refuse live or unknown gateway markers", () => {
  const f = fixture();
  expect(f.run("hooks", ["--apply"]).status).toBe(1); expect(existsSync(join(f.home, "hooks.json"))).toBe(false);
  for (const marker of ["gateway.lock", "run/gateway-8080.pid"]) {
    for (const text of [String(process.pid), "unknown"]) {
      const path = join(f.home, marker); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
      expect(f.run("hooks", ["--apply", "--gateway-stopped"]).status).toBe(1); expect(existsSync(join(f.home, "hooks.json"))).toBe(false); rmSync(path);
    }
  }
  expect(f.run("hooks", ["--apply", "--gateway-stopped"]).status).toBe(0);
});

test("hook merge preserves foreign bytes, is idempotent and refuses duplicate owned IDs", () => {
  const f = fixture(); const path = join(f.home, "hooks.json"); const foreign = '{ "id":"foreign", "number":1e2 }';
  writeFileSync(path, `{ "foreign":"\\u0061", "hooks":[${foreign}] }\n`);
  expect(f.run("hooks", ["--apply", "--gateway-stopped"]).status).toBe(0);
  const after = read(path); expect(after).toContain(foreign); expect(after).toContain('"foreign":"\\u0061"');
  expect(JSON.parse(after).hooks).toHaveLength(6); const mtime = statSync(path).mtimeMs;
  expect(f.run("hooks", ["--apply", "--gateway-stopped"]).status).toBe(0); expect(read(path)).toBe(after); expect(statSync(path).mtimeMs).toBe(mtime);
  const value = JSON.parse(after); value.hooks.push(value.hooks[1]); writeFileSync(path, JSON.stringify(value)); const before = read(path);
  expect(f.run("hooks", ["--apply", "--gateway-stopped"]).status).toBe(1); expect(read(path)).toBe(before);
});

test("both effective trust grants are required before staging or host calls", () => {
  const f = fixture();
  for (const agent of [{}, { apps_trusted: ["aidlc"] }, { apps_trusted_local: ["aidlc"] }, { apps_trusted: ["aidlc"], apps_trusted_local: [] }]) {
    json(f.config, { agent }); const before = f.owned(); let called = false;
    expect(() => applyApp(portable, f.home, () => { called = true; return ""; })).toThrow("TRUST_REQUIRED_STOP");
    expect(called).toBe(false); expect(f.owned()).toEqual(before);
  }
  f.grant(); json(join(f.home, "config.local.json"), { agent: { apps_trusted_local: [] } }); const before = f.owned();
  expect(() => applyApp(portable, f.home, () => { throw new Error("must not call host"); })).toThrow("TRUST_REQUIRED_STOP"); expect(f.owned()).toEqual(before);
});

test("app apply verifies install before enable and writes a durable idempotent receipt", () => {
  const f = fixture(); f.grant(); const config = read(f.config); const order: string[] = [];
  applyApp(portable, f.home, (args) => { order.push(args[1]); return f.host(args); }, ({ phase, specs }) => { order.push(`verify-${phase}`); expect(Object.keys(specs).sort()).toEqual(["aidlc--aidlc-crew", "kirocrew"]); });
  expect(order).toEqual(["install", "verify-install", "enable", "verify-enable"]); expect(read(f.config)).toBe(config);
  expect(checkAppIdentity(portable, f.paths.appRoot).matches).toBe(true);
  const receipt = join(f.paths.appRoot, ".aidlc-materialized.json"); const bytes = read(receipt); const mtime = statSync(receipt).mtimeMs;
  expect(writeMaterializationReceipt(portable, f.paths)).toBe(false); expect(read(receipt)).toBe(bytes); expect(statSync(receipt).mtimeMs).toBe(mtime);
  expect(readdirSync(dirname(f.paths.appRoot))).toEqual(["aidlc"]);
});

test("failed registration verification stops enablement and always removes staging", () => {
  for (const fault of ["install-error", "install-spec", "enable-spec", "enable-state"]) {
    const f = fixture(); f.grant(); const phases: string[] = [];
    expect(() => applyApp(portable, f.home, (args) => {
      phases.push(args[1]); if (fault === "install-error") throw new Error("host installation failed");
      const output = f.host(args);
      if (fault === `${args[1]}-spec`) rmSync(join(f.home, "kiro/agents/kirocrew.json"));
      if (fault === "enable-state" && args[1] === "enable") json(join(f.paths.appRoot, "installed.json"), { enabled: false });
      return output;
    })).toThrow();
    expect(phases).toEqual(fault.startsWith("install") ? ["install"] : ["install", "enable"]);
    expect(existsSync(join(f.paths.appRoot, ".aidlc-materialized.json"))).toBe(false);
    expect(readdirSync(dirname(f.paths.appRoot)).some((name) => name.startsWith(".aidlc-staging-"))).toBe(false);
  }
});

test("data-only app state remains installable while partial or symlink payloads are preserved", () => {
  const f = fixture(); f.grant(); expect(classifyApp(f.paths.appRoot).kind).toBe("absent");
  json(join(f.paths.appRoot, "data/kept.json"), { retained: true }); expect(classifyApp(f.paths.appRoot).kind).toBe("absent");
  writeFileSync(join(f.paths.appRoot, "stray"), "owned elsewhere"); const before = f.owned();
  expect(() => applyApp(portable, f.home, f.host)).toThrow("Partial app state"); expect(f.owned()).toEqual(before);
  rmSync(join(f.paths.appRoot, "stray")); applyApp(portable, f.home, f.host); expect(JSON.parse(read(join(f.paths.appRoot, "data/kept.json")))).toEqual({ retained: true });
  const other = fixture(); mkdirSync(dirname(other.paths.appRoot), { recursive: true }); symlinkSync(f.paths.appRoot, other.paths.appRoot);
  expect(classifyApp(other.paths.appRoot).kind).toBe("partial"); expect(() => applyApp(portable, other.home, other.host)).toThrow("Partial app state"); expect(lstatSync(other.paths.appRoot).isSymbolicLink()).toBe(true);
});

test("materialization quotes hook paths but keeps MCP paths as literal argv", () => {
  const f = fixture(); const target = join(f.root, "materialized"); cpSync(portable, target, { recursive: true });
  expect(materializeApp(target, f.paths)).toHaveLength(2);
  const server = JSON.parse(read(join(target, "app.json"))).mcpServers.engine;
  expect(server).toMatchObject({ command: process.execPath, args: [join(f.paths.appRoot, "mcp/aidlc-mcp-bridge.ts"), "mcp", "--crew-home", f.home] });
  const fragment = JSON.parse(read(join(portable, "hooks.fragment.json"))).hooks;
  const hooks = materializeHooks(fragment, f.paths);
  expect(hooks).toHaveLength(5); expect(String(hooks[0].command)).toContain("'\\''");
  expect(materializeApp(target, f.paths, portable)).toEqual([]);
  for (const broken of [[], [...fragment, fragment[0]], fragment.map((hook: object, index: number) => index ? hook : { ...hook, command: "bun relative.ts" })]) expect(() => materializeHooks(broken, f.paths)).toThrow();
});

test("invalid portable commands and paths refuse before either materialized file changes", () => {
  const f = fixture(); const target = join(f.root, "materialized"); cpSync(portable, target, { recursive: true });
  const source = join(f.root, "source"); cpSync(portable, source, { recursive: true });
  const mcp = join(source, "mcp.fragment.json"); const value = JSON.parse(read(mcp)); value.mcpServers.engine.args = ["relative.ts"]; json(mcp, value);
  const before = snapshot(target); expect(() => materializeApp(target, f.paths, source)).toThrow(); expect(snapshot(target)).toEqual(before);
  for (const bun of ["relative", join(f.root, `\${unresolved}`)]) expect(() => materializeApp(target, { ...f.paths, bun })).toThrow();
  expect(snapshot(target)).toEqual(before);
});

test("installed identity rejects receipt, inventory, extra-file and symlink tampering", () => {
  for (const fault of ["receipt", "inventory", "extra", "link", "payload"]) {
    const f = fixture(); f.install();
    const file = join(f.paths.appRoot, "mcp/aidlc-mcp-bridge.ts");
    if (fault === "receipt") writeFileSync(join(f.paths.appRoot, ".aidlc-materialized.json"), "{}");
    if (fault === "inventory") writeFileSync(join(f.paths.appRoot, "app-inventory.json"), '{"schemaVersion":2}');
    if (fault === "extra") writeFileSync(join(f.paths.appRoot, "unowned.txt"), "extra");
    if (fault === "link") { rmSync(file); symlinkSync(join(portable, "mcp/aidlc-mcp-bridge.ts"), file); }
    if (fault === "payload") writeFileSync(file, "changed bytes");
    const before = f.owned(); expect(checkAppIdentity(portable, f.paths.appRoot).matches).toBe(false);
    expect(() => applyApp(portable, f.home, f.host)).toThrow(); expect(f.owned()).toEqual(before);
    if (fault === "receipt") expect(readMaterializationReceipt(f.paths.appRoot)).toBeUndefined();
  }
});

test("same-version source drift and installed-source invocation cannot authorize an upgrade", () => {
  const f = fixture(); f.install(); const source = join(f.root, "source"); cpSync(portable, source, { recursive: true });
  const version = JSON.parse(read(join(source, "app.json"))).version;
  writeFileSync(join(source, "mcp/aidlc-mcp-bridge.ts"), "changed at the same version");
  expect(JSON.parse(read(join(source, "app.json"))).version).toBe(version);
  const before = f.owned(); expect(checkAppIdentity(source, f.paths.appRoot).matches).toBe(false);
  expect(isInstalledInvocation(f.paths.appRoot, f.paths.appRoot)).toBe(true);
  expect(() => applyApp(f.paths.appRoot, f.home, f.host)).toThrow("cannot decide source freshness"); expect(f.owned()).toEqual(before);
  expect(verifyRegisteredSpecs(f.home)).toHaveProperty("kirocrew");
});

test("doctor returns twelve integration checks and never repairs an absent or ready installation", () => {
  const f = doctorFixture(); const before = f.owned(); const ready = f.doctor();
  expect(ready.checks).toHaveLength(12); expect(ready.checks.every(({ pass }) => pass)).toBe(true); expect(f.owned()).toEqual(before);
  rmSync(join(f.paths.appRoot, ".aidlc-materialized.json")); const absent = f.owned(); const result = f.doctor();
  expect(result.status).toBe(1); expect(result.row("App installed+enabled").pass).toBe(false); expect(f.owned()).toEqual(absent);
});

test("doctor validates pinned runtime and scopes binding failures to the selected session", () => {
  const f = doctorFixture(); const other = join(dirname(f.binding.path), `${createHash("sha256").update("other").digest("hex")}.json`); writeFileSync(other, "{");
  expect(f.doctor().row("Conversation bound").pass).toBe(false);
  expect(f.doctor({ AIDLC_SESSION_OVERRIDE: f.session }).row("Conversation bound").pass).toBe(true);
  const spec = join(f.home, "kiro/agents/kirocrew.json"); const value = JSON.parse(read(spec)); value.mcpServers["aidlc:engine"].command = join(f.root, "absent-runtime"); json(spec, value);
  const before = f.owned(); const result = f.doctor({ AIDLC_SESSION_OVERRIDE: f.session });
  expect(result.status).toBe(1); expect(result.row("Bridge runtime pinned").pass).toBe(false); expect(f.owned()).toEqual(before);
});

test("doctor warns about old children and unresolved or malformed dispatch state without settling it", () => {
  const f = doctorFixture(); const ledger = join(f.project, "aidlc/.aidlc-sessions", `${f.session}.crew-dispatch.json`);
  const now = new Date().toISOString(); const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const base = { intentId: "intent", wave: "wave", stage: "code-generation", task: "draft", role: "aidlc-crew-developer-agent", intendedAt: old };
  for (const value of [
    { schemaVersion: 1, session: f.session, intents: [{ ...base, status: "pending-unknown" }], outstanding: [], settled: [] },
    { schemaVersion: 1, session: f.session, intents: [], outstanding: [{ ...base, childId: "child", runId: "child", conversationId: "conversation", dispatchedAt: old }], settled: [] },
    { schemaVersion: 1, session: f.session, intents: [], outstanding: [{ ...base, dispatchedAt: now }], settled: [] },
  ]) {
    json(ledger, value); const before = f.owned(); const result = f.doctor();
    expect(result.row("Dispatch ledger health").severity).toBe("warn"); expect(f.owned()).toEqual(before);
  }
});

function setupRow(report: SetupReport, name: string) {
  const row = report.rows.find(({ what }) => what === name); expect(row).toBeDefined(); return row!;
}
function selectClaude(f: Fixture, global = "claude", member = "claude") {
  const value = existsSync(f.config) ? JSON.parse(read(f.config)) : {};
  json(f.config, { ...value, agent: { ...value.agent, acp_backend: global, member_acp_backend: member } });
}

test("setup and doctor resolve replacing backend axes without normalizing invalid selections", () => {
  const f = doctorFixture(); const base = JSON.parse(read(f.config)); const local = join(f.home, "config.local.json");
  for (const [axes, expected] of [
    [{}, "ok"], [{ acp_backend: "claude" }, "warn"], [{ acp_backend: "kas" }, "warn"], [{ acp_backend: "codex" }, "fail"],
    [{ acp_backend: "kiro-cli" }, "fail"], [{ acp_backend: "unknown" }, "fail"], [{ acp_backend: false }, "fail"], [{ member_acp_backend: null }, "fail"],
  ] as const) {
    json(f.config, { ...base, agent: { ...base.agent, ...axes } }); const before = f.owned();
    const status = f.run("status", ["--project-dir", f.project]); expect(setupRow(status.report, "Backend selection").status).toBe(expected);
    const doctor = f.doctor().row("Backend"); expect(doctor.pass).toBe(expected === "ok"); expect(doctor.severity === "warn").toBe(expected === "warn");
    expect(f.owned()).toEqual(before);
  }
  selectClaude(f); json(local, { agent: { acp_backend: "", member_acp_backend: "kas" } }); const before = f.owned();
  const row = setupRow(f.run("status", ["--project-dir", f.project]).report, "Backend selection"); expect(row.status).toBe("ok"); expect(row.detail).toContain("member_acp_backend=kas");
  expect(f.doctor().row("Backend").pass).toBe(true); expect(f.owned()).toEqual(before);
});

function versionExecutables(f: Fixture, names: string[], output: string) {
  const bin = join(f.root, "version-bin"); mkdirSync(bin);
  const trace = join(f.root, "version-calls.jsonl");
  for (const name of names) writeFileSync(join(bin, name), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const command=import.meta.path,args=process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)},JSON.stringify({command,args})+'\\n');
if(args.length!==1||args[0]!=='--version')process.exit(97);
if(process.env.FIXTURE_VERSION_FAILED==='1')process.exit(1);
process.stdout.write(${output});
`, { mode: 0o755 });
  const calls = () => existsSync(trace) ? read(trace).trim().split("\n").map((line) => JSON.parse(line) as { command: string; args: string[] }) : [];
  return { bin, trace, calls, env: { PATH: [bin, f.env.PATH].join(delimiter) } };
}

test("version observations use bounded argv and no-follow metadata without changing backend severity", () => {
  const f = doctorFixture(); selectClaude(f);
  const metadata = join(f.root, "kiro_crew"); mkdirSync(metadata); writeFileSync(join(metadata, "__init__.py"), '__version__ = "1.2.3"\n'); writeFileSync(join(metadata, "_build_info.py"), 'DISTRIBUTION = "test"\n');
  const adapterDir = join(f.root, "adapter"); mkdirSync(adapterDir); const adapter = join(adapterDir, "claude-agent-acp"); writeFileSync(adapter, "#!/bin/sh\nexit 99\n"); chmodSync(adapter, 0o755);
  const pkg = join(adapterDir, "package.json"); json(pkg, { name: "@agentclientprotocol/claude-agent-acp", version: "2.3.4" });
  const host = versionExecutables(f, ["kirocrew", "claude", "node"], `command.endsWith('kirocrew')?${JSON.stringify(`kirocrew 9.9.9\n${metadata}\n`)}:'v3.4.5'`);
  const env = { ...host.env, CLAUDE_AGENT_ACP_BIN: adapter }; const before = f.owned();
  for (const detail of [setupRow(f.run("status", ["--project-dir", f.project], env).report, "Backend selection").detail, f.doctor(env).row("Backend").label]) {
    expect(detail).toContain("Crew: 1.2.3; distribution: test"); expect(detail).toContain("package version: 2.3.4"); expect(detail).toContain("v3.4.5");
  }
  expect(host.calls().map((call) => call.command)).toEqual(["kirocrew", "claude", "node", "kirocrew", "claude", "node"].map((name) => join(host.bin, name)));
  for (const call of host.calls()) expect(call.args).toEqual(["--version"]);
  // Observe spawn options at the directly imported backend boundary; the CLI
  // checks above exercise the real executables across the doctor's re-spawn.
  const script = join(f.root, "version-options.ts");
  writeFileSync(script, `import {mock} from 'bun:test';import * as cp from 'node:child_process';const calls=[],spawn=cp.spawnSync;
mock.module('node:child_process',()=>({...cp,spawnSync:(command,args,options)=>{calls.push({command,args,timeout:options.timeout,maxBuffer:options.maxBuffer,shell:options.shell});return spawn(command,args,options);}}));
const file=${JSON.stringify(join(portable, "setup/aidlc-kiro-crew-setup.ts"))};const {backend}=await import(file);backend(${JSON.stringify(f.home)});console.log(JSON.stringify(calls));`);
  const bounded = spawnSync(process.execPath, [script], { env: { ...f.env, ...env }, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS) });
  expect(bounded.status, bounded.stderr).toBe(0);
  const calls = JSON.parse(bounded.stdout); expect(calls).toHaveLength(3);
  for (const call of calls) { expect(call.args).toEqual(["--version"]); expect(call.timeout).toBe(5000); expect(call.maxBuffer).toBe(64 * 1024); expect(call.shell).toBeUndefined(); expect(call.command).not.toBe(adapter); }
  rmSync(pkg); symlinkSync(join(metadata, "__init__.py"), pkg);
  const failedEnv = { ...env, FIXTURE_VERSION_FAILED: "1" };
  const row = setupRow(f.run("status", ["--project-dir", f.project], failedEnv).report, "Backend selection");
  expect(row.status).toBe("warn"); expect(row.detail).toContain("Crew: unknown"); expect(row.detail).toContain("package version: unknown");
  expect(f.doctor(failedEnv).row("Backend").severity).toBe("warn"); expect(f.owned()).toEqual(before);
});

test("both collision reporters list every collision class in deterministic order without changing files", () => {
  const f = doctorFixture(); selectClaude(f, "", "claude");
  for (const [path, value] of [[".claude/settings.local.json", "{\"permissions\":{}}"], ["CLAUDE.md", "ambient"], [".claude/settings.json", "{}"], [".claude/hooks/local.json", "{}"], [".claude/tools/aidlc.ts", "engine"]]) {
    mkdirSync(dirname(join(f.project, path)), { recursive: true }); writeFileSync(join(f.project, path), value);
  }
  const before = f.owned(); const status = f.run("status", ["--project-dir", f.project]); const doctor = f.doctor();
  expect(status.status).toBe(1); expect(doctor.status).toBe(1); expect(doctor.row("Claude project collision").pass).toBe(false);
  const row = setupRow(status.report, "Claude project collision"); expect(row.status).toBe("fail");
  for (const text of [row.detail, doctor.row("Claude project collision").label]) {
    const indexes = ["local-settings", "ambient-instructions", "project-settings", "project-integrations", "existing-engine"].map((id) => text.indexOf(id));
    expect(indexes.every((value) => value >= 0)).toBe(true); expect(indexes).toEqual(indexes.toSorted((a, b) => a - b));
  }
  expect(f.owned()).toEqual(before);
  selectClaude(f, "", "kas"); expect(setupRow(f.run("status", ["--project-dir", f.project]).report, "Claude project collision").status).toBe("ok");
});

test("unsafe project inspection refuses while seed and global existence only warn without reading global contents", () => {
  const f = doctorFixture(); selectClaude(f);
  const local = join(f.project, ".claude"); symlinkSync(f.home, local); const before = f.owned();
  expect(setupRow(f.run("status", ["--project-dir", f.project]).report, "Claude project collision").status).toBe("fail"); expect(f.doctor().row("Claude project collision").pass).toBe(false); expect(f.owned()).toEqual(before);
  rmSync(local); json(join(local, "settings.local.json"), { availableModels: ["model"] });
  const global = join(f.root, ".claude"); mkdirSync(global); writeFileSync(join(global, "private.json"), "must not be read");
  const preload = join(f.root, "global-read.ts"); const trace = join(f.root, "global-read-attempt");
  writeFileSync(preload, `import {mock} from 'bun:test';import * as fs from 'node:fs';const open=fs.openSync,read=fs.readFileSync;const check=p=>{if(typeof p==='string'&&p.startsWith(${JSON.stringify(global)})){fs.writeFileSync(${JSON.stringify(trace)},p);throw new Error('global contents forbidden');}};mock.module('node:fs',()=>({...fs,openSync:(p,...args)=>{check(p);return open(p,...args)},readFileSync:(p,...args)=>{check(p);return read(p,...args)}}));`);
  const seeded = f.owned(); const status = f.run("status", ["--project-dir", f.project], {}, preload);
  const row = setupRow(status.report, "Claude project collision"); expect(row.status).toBe("warn"); expect(row.detail).toContain("availableModels-only"); expect(row.detail).toContain("contents not read");
  expect(f.doctor({}, preload).row("Claude project collision").severity).toBe("warn"); expect(existsSync(trace)).toBe(false); expect(f.owned()).toEqual(seeded);
});

test("Claude project and bind collisions precede installer, root grants and binding writes", () => {
  const f = fixture(); selectClaude(f); const key = "dashboard:collision"; json(join(f.home, "session_map.json"), { [key]: { provider: "claude_code" } });
  writeFileSync(join(f.project, "CLAUDE.md"), "operator content"); const before = f.owned();
  for (const [command, args] of [["project", projectArgs(f)], ["project", [...projectArgs(f), "--apply-local"]], ["bind", ["--project-dir", f.project, "--session-key", key]]] as [string, string[]][]) {
    const result = f.run(command, args);
    expect(result.status).toBe(1); expect(setupRow(result.report, "Claude project collision").status).toBe("fail"); expect(result.report.changed).toEqual([]); expect(f.owned()).toEqual(before);
  }
  expect(existsSync(join(f.project, ".kiro-crew"))).toBe(false); expect(existsSync(join(f.home, "apps/aidlc/data/bindings"))).toBe(false);
});

test("CLI child binding checks caller identity and effective roots while terminal recovery remains recorded-key only", () => {
  const f = doctorFixture(); selectClaude(f); const child = "subagent:developer";
  json(join(f.home, "session_map.json"), { [child]: { provider: "claude_code" }, [f.key]: { provider: "claude_code" } });
  const args = ["--project-dir", f.project, "--session-key", child];
  for (const identity of [f.key, "subagent:", "subagent:other", "bad\nkey"]) {
    const before = f.owned(); expect(f.run("bind", args, { KIROCREW_SESSION_KEY: identity }).status).toBe(1); expect(f.owned()).toEqual(before);
  }
  const result = f.run("bind", args, { KIROCREW_SESSION_KEY: child }); expect(result.status, result.stdout).toBe(0);
  const path = join(dirname(f.binding.path), `${createHash("sha256").update(child).digest("hex")}.json`); expect(JSON.parse(read(path)).source).toBe("project-dir");
  const before = f.owned(); expect(f.run("bind", args, { KIROCREW_SESSION_KEY: child }).status).toBe(0); expect(f.owned()).toEqual(before);
  json(join(f.home, "config.local.json"), { agent: { subagent_cwd_allowed_roots: [] } }); const replaced = f.owned();
  expect(f.run("bind", args, { KIROCREW_SESSION_KEY: child }).status).toBe(1); expect(f.owned()).toEqual(replaced);
  expect(f.run("bind", ["--project-dir", f.project, "--session-key", f.key]).status).toBe(0);
});

test("composition reports family counts and selected current identity without exposing raw keys or unknown labels", () => {
  const f = doctorFixture(); const privateKey = "dashboard:private-key"; const privateProvider = "private-provider-label";
  const cases = [
    { axes: ["", "kas"], map: { [f.key]: { provider: "acp" }, [privateKey]: { provider: "kas" } }, status: "ok", fragment: "consistent Kiro" },
    { axes: ["claude", "claude"], map: { [f.key]: { provider: "claude_code" } }, status: "warn", fragment: "with limitations" },
    { axes: ["claude", "kas"], map: { [f.key]: { provider: "claude_code" } }, status: "warn", fragment: "mixed backend" },
    { axes: ["", "kas"], map: { [f.key]: { provider: "claude_code" } }, status: "warn", fragment: "records-vs-config disagreement" },
    { axes: ["", "kas"], map: { [privateKey]: { provider: privateProvider } }, status: "warn", fragment: "unrecognized (1)" },
  ];
  for (const item of cases) {
    selectClaude(f, item.axes[0], item.axes[1]); json(join(f.home, "session_map.json"), item.map); const before = f.owned();
    const env = { AIDLC_SESSION_OVERRIDE: f.session, KIROCREW_SESSION_KEY: privateKey };
    const row = setupRow(f.run("status", ["--project-dir", f.project], env).report, "Crew composition"); const doctor = f.doctor(env).row("Crew composition");
    expect(row.status).toBe(item.status); expect(doctor.severity === "warn").toBe(item.status === "warn");
    for (const detail of [row.detail, doctor.label]) { expect(detail).toContain(item.fragment); expect(detail).not.toContain(privateKey); expect(detail).not.toContain(privateProvider); expect(detail).toContain("unrecorded children are not verified"); }
    expect(f.owned()).toEqual(before);
  }
});

test("whole-map composition limits admit 10000 records and warn on overflow, malformed and missing current records", () => {
  const f = doctorFixture(); const path = join(f.home, "session_map.json");
  const map = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [i === 0 ? f.key : `session:${i}`, { provider: "acp" }]));
  const valid = JSON.stringify(map);
  for (const [raw, status] of [[valid, "ok"], [valid.padEnd(4 * 1024 * 1024, " "), "ok"], [valid.padEnd(4 * 1024 * 1024 + 1, " "), "warn"], [JSON.stringify({ ...map, extra: {} }), "warn"], ["[]", "warn"], ["{", "warn"], ["{}", "warn"]]) {
    writeFileSync(path, raw); const before = f.owned(); const env = { AIDLC_SESSION_OVERRIDE: f.session };
    const row = setupRow(f.run("status", ["--project-dir", f.project], env).report, "Crew composition"); expect(row.status).toBe(status);
    expect(f.doctor(env).row("Crew composition").severity === "warn").toBe(status === "warn"); expect(f.owned()).toEqual(before);
  }
});

// Simulate only executable version observations. In mutator tests any other
// subprocess or Claude collision inspection records an attempt and fails; the
// real CLI still owns config resolution, admission, reporting and all writes.
function codexRuntime(f: Fixture, mutator = false) {
  const host = versionExecutables(f, ["kirocrew", "bun", "claude", "node", "aidlc"], `'kirocrew '+(process.env.FIXTURE_CREW_VERSION||'99.0.0')`);
  const collision = join(f.root, "collision-attempt"); const preload = join(f.root, "backend-runtime.ts");
  writeFileSync(preload, `import {mock} from 'bun:test';import * as cp from 'node:child_process';import * as fs from 'node:fs';const spawn=cp.spawnSync,lstat=fs.lstatSync;
    if(${mutator})mock.module('node:child_process',()=>({...cp,spawnSync:(command,args,options)=>{if(args?.length!==1||args[0]!=='--version'){fs.appendFileSync(${JSON.stringify(host.trace)},JSON.stringify({command,args})+'\\n');throw new Error('unexpected subprocess');}return spawn(command,args,options);}}));
    if(${mutator})mock.module('node:fs',()=>({...fs,lstatSync:(path,...args)=>{if([${JSON.stringify(join(f.project, ".claude"))},${JSON.stringify(join(f.project, "CLAUDE.md"))}].includes(path)){fs.writeFileSync(${JSON.stringify(collision)},String(path));throw new Error('unexpected collision inspection');}return lstat(path,...args);}}));`);
  return { ...host, preload, collision };
}
function codexDiagnostic(text: string) {
  expect(text).toContain("Codex is not supported as a Kiro Crew backend");
  expect(text).toContain("intercept Codex tool permissions or identify the calling conversation");
  expect(text).toContain("Choose Kiro CLI or Claude Code with its documented limits in Crew, then rerun setup and doctor.");
  expect(text).toContain("Version changes do not bypass this refusal.");
  expect(text).toContain("docs/guide/harnesses/kiro-crew.md#codex-backend");
  expect(text).toContain("The native Codex CLI harness is unaffected.");
}

test("effective global Codex refuses every setup command before writes, collision inspection or host mutation", () => {
  for (const installed of [false, true]) {
    const f = fixture(); if (installed) f.install(); else f.grant();
    selectClaude(f, installed ? "claude" : "codex", "claude");
    if (installed) json(join(f.home, "config.local.json"), { agent: { acp_backend: "codex", subagent_cwd_allowed_roots: [] } });
    const key = "dashboard:blocked-setup"; json(join(f.home, "session_map.json"), { [key]: { provider: "codex", cwd: f.project } });
    writeFileSync(join(f.project, "CLAUDE.md"), "operator-owned instructions");
    json(join(f.home, "hooks.json"), { hooks: [{ id: "foreign", command: "operator-command" }] });
    const host = codexRuntime(f, true); const before = f.owned();
    const commands: [string, string[]][] = [
      ["project", projectArgs(f)], ["project", [...projectArgs(f), "--apply-local"]], ["project", ["--project-dir", f.project, "--native"]],
      ["hooks", []], ["hooks", ["--apply", "--gateway-stopped"]], ["app", []], ["app", ["--apply"]], ["trust", []],
      ["bind", ["--project-dir", f.project, "--session-key", key]],
    ];
    for (const [command, args] of commands) {
      const result = f.run(command, args, host.env, host.preload); expect(result.status, command).toBe(1);
      expect(result.report.rows).toHaveLength(1); expect(setupRow(result.report, "Backend selection").status).toBe("fail"); codexDiagnostic(result.report.rows[0].detail);
      expect(result.report.changed).toEqual([]); expect(f.owned(), command).toEqual(before); expect(existsSync(host.collision)).toBe(false);
    }
    expect(host.calls().length).toBeGreaterThan(0);
    for (const call of host.calls()) expect(call.args).toEqual(["--version"]);
    expect(existsSync(join(f.project, ".kiro-crew"))).toBe(false); expect(existsSync(join(f.paths.appRoot, "data/bindings"))).toBe(false);
  }
});

test("setup and doctor keep global Codex failed and member-only Codex advisory across overlays and versions", () => {
  const f = doctorFixture(); const base = JSON.parse(read(f.config)); const local = join(f.home, "config.local.json"); const host = codexRuntime(f);
  writeFileSync(join(f.project, "CLAUDE.md"), "operator instructions");
  const cases = [
    { base: "codex", local: undefined, member: "claude", status: "fail", version: "0.6.0" },
    { base: "", local: "codex", member: "claude", status: "fail", version: "99.0.0" },
    { base: "codex", local: "", member: "codex", status: "warn", version: "99.0.0" },
    { base: "codex", local: "", member: "kas", status: "ok", version: "99.0.0" },
  ];
  for (const item of cases) {
    json(f.config, { ...base, agent: { ...base.agent, acp_backend: item.base, member_acp_backend: item.member } });
    rmSync(local, { force: true }); if (item.local !== undefined) json(local, { agent: { acp_backend: item.local } });
    const before = f.owned(); const env = { ...host.env, FIXTURE_CREW_VERSION: item.version };
    const status = f.run("status", ["--project-dir", f.project], env, host.preload); const doctor = f.doctor(env, host.preload);
    const row = setupRow(status.report, "Backend selection"); const check = doctor.row("Backend");
    expect(row.status).toBe(item.status); expect(check.pass).toBe(item.status === "ok"); expect(check.severity === "warn").toBe(item.status === "warn");
    expect(status.status).toBe(item.status === "fail" ? 1 : 0); expect(doctor.status).toBe(item.status === "fail" ? 1 : 0);
    for (const detail of [row.detail, check.label]) { expect(detail).toContain(`Crew: ${item.version}`); if (item.status !== "ok") codexDiagnostic(detail); }
    if (item.status === "fail") {
      expect(setupRow(status.report, "Claude project collision")).toMatchObject({ status: "ok", detail: "not evaluated (global codex blocked; see Backend row)" });
      expect(doctor.row("Claude project collision")).toMatchObject({ pass: true }); expect(doctor.row("Claude project collision").label).toContain("not evaluated (global codex blocked");
    } else if (item.status === "warn") expect(row.detail).toContain("member-DM only; not delegated-child selection");
    expect(status.report.changed).toEqual([]); expect(f.owned()).toEqual(before);
  }
});

test("Codex config and provider observations take warning-only composition precedence in both reporters", () => {
  const f = doctorFixture(); const base = JSON.parse(read(f.config)); const host = codexRuntime(f);
  for (const item of [
    { global: "codex", member: "claude", providers: ["acp", "claude_code"], backend: "fail" },
    { global: "", member: "codex", providers: ["acp"], backend: "warn" },
    { global: "", member: "kas", providers: ["codex"], backend: "ok" },
    { global: "claude", member: "claude", providers: ["claude_code", "codex", "acp"], backend: "warn" },
  ]) {
    json(f.config, { ...base, agent: { ...base.agent, acp_backend: item.global, member_acp_backend: item.member } });
    json(join(f.home, "session_map.json"), Object.fromEntries(item.providers.map((provider, i) => [i ? `dashboard:other-${i}` : f.key, { provider, cwd: f.project }])));
    const before = f.owned(); const env = { ...host.env, AIDLC_SESSION_OVERRIDE: f.session };
    const status = f.run("status", ["--project-dir", f.project], env, host.preload); const doctor = f.doctor(env, host.preload);
    expect(setupRow(status.report, "Backend selection").status).toBe(item.backend);
    const row = setupRow(status.report, "Crew composition"); const check = doctor.row("Crew composition");
    expect(row.status).toBe("warn"); expect(check).toMatchObject({ pass: false, severity: "warn" });
    for (const detail of [row.detail, check.label]) {
      expect(detail).toContain("blocked: codex selected or recorded"); expect(detail).not.toContain("mixed backend configuration"); expect(detail).not.toContain("consistent backend configuration");
      expect(detail).toContain(`current session provider: ${item.providers[0]}`); expect(detail).not.toContain(f.key);
    }
    expect(f.owned()).toEqual(before);
  }
});

test("human doctor renders Codex failure and guide pointer without relaying diagnostic control characters", () => {
  const f = doctorFixture(); selectClaude(f, "codex", "kas"); const host = codexRuntime(f); const before = f.owned();
  const structured = f.doctor(host.env, host.preload); const human = f.humanDoctor(host.env, host.preload);
  expect(structured.status).toBe(1); expect(human.status).toBe(1); codexDiagnostic(human.stdout);
  expect(structured.row("Backend").label).toContain("unaffected.\n  See docs/guide/harnesses/kiro-crew.md#codex-backend\n  Observations");
  const line = human.stdout.split("\n").find((line) => line.includes("Crew integration — Backend:"));
  expect(line).toBeDefined(); expect(line).toContain("fail");
  expect(line).toContain("unaffected.?  See docs/guide/harnesses/kiro-crew.md#codex-backend?  Observations");
  expect(line).not.toContain("\r"); expect(line).not.toContain("\t"); expect(line).not.toContain("\u001b");
  expect(f.owned()).toEqual(before);
});

function cachePython() {
  const override = process.env.AIDLC_TEST_PYTHON312;
  const candidates = override === undefined ? [Bun.which("python3.12"), Bun.which("python3")] : [override];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    const result = spawnSync(candidate, ["-I", "-B", "-c", "import sys; print('.'.join(map(str,sys.version_info[:2])))"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    if (!result.error && result.status === 0 && result.stdout.trim() === "3.12") return candidate;
  }
  throw new Error("Cache tests require Python 3.12 on PATH or absolute AIDLC_TEST_PYTHON312; an invalid override cannot fall back");
}
function generateCache(python: string, source: string, optimize = 0, mode = "TIMESTAMP") {
  const result = spawnSync(python, ["-I", "-B", "-S", "-c",
    "import py_compile,sys; print(py_compile.compile(sys.argv[1],doraise=True,optimize=int(sys.argv[2]),invalidation_mode=getattr(py_compile.PycInvalidationMode,sys.argv[3])))", source, String(optimize), mode],
  { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
}
type CacheFile = { path: string; sha256: string };
type CacheCandidateRoots = { launcher: string | null; bundleRoot: string | null };
type CacheObservation = { ok: boolean; detail: string; calls: { command: string; args: string[]; timeout: number; maxBuffer: number; killSignal: string; cwd: string; shell?: boolean }[]; which: string[]; versions: string[] };
function cacheTwins(f: Fixture, app: string, files: CacheFile[], env: NodeJS.ProcessEnv, fault = "", candidateRoots: CacheCandidateRoots = { launcher: null, bundleRoot: null }) {
  const script = join(f.root, "cache-verifiers.ts");
  writeFileSync(script, `import {mock,spyOn} from 'bun:test';import * as cp from 'node:child_process';import * as fs from 'node:fs';const calls=[],which=[];const spawn=cp.spawnSync,lookup=Bun.which.bind(Bun);const roots=${JSON.stringify(candidateRoots)};const trace=process.env.FIXTURE_PYTHON_CALLS;
mock.module('node:child_process',()=>({...cp,spawnSync:(command,args,options)=>{calls.push({command,args,timeout:options.timeout,maxBuffer:options.maxBuffer,killSignal:options.killSignal,cwd:options.cwd,shell:options.shell});
if(${JSON.stringify(fault)}==='timeout')return {error:new Error('timed out'),status:null,stdout:Buffer.alloc(0)};
if(${JSON.stringify(fault)}==='compiler'&&args.length>5)return {status:1,stdout:Buffer.alloc(0)};
return spawn(command,args,options);}}));spyOn(Bun,'which').mockImplementation((name,...args)=>{which.push(name);return lookup(name,...args);});
const results=[];for(const file of ${JSON.stringify([join(REPO_ROOT, "harness/kiro-crew/setup/aidlc-kiro-crew-setup.ts"), join(REPO_ROOT, "core/tools/aidlc-utility.ts")])}){
const {verifyCrewInstalledEntries}=await import(file);calls.length=0;which.length=0;if(trace)fs.writeFileSync(trace,'');let ok=true,detail='';try{detail=verifyCrewInstalledEntries(${JSON.stringify(app)},${JSON.stringify(files)},roots);}catch(error){ok=false;detail=error.message;}const versions=trace?fs.readFileSync(trace,'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line)):[];results.push({ok,detail,calls:[...calls],which:[...which],versions});}console.log(JSON.stringify(results));`);
  const before = snapshot(app);
  const result = spawnSync(process.execPath, [script], { cwd: f.root, env: { ...f.env, ...env }, encoding: "utf8", timeout: NATIVE_FIXTURE_SETUP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(snapshot(app)).toEqual(before);
  const observations = JSON.parse(result.stdout) as CacheObservation[]; expect(observations).toHaveLength(2);
  for (const observation of observations) for (const call of observation.calls) {
    expect(call.args.slice(0, 4)).toEqual(["-I", "-B", "-S", "-c"]); expect(call.timeout).toBe(5000); expect(call.maxBuffer).toBe(4096); expect(call.killSignal).toBe("SIGKILL");
    expect(call.cwd).toBe(dirname(call.command)); expect(call.shell).toBeUndefined();
  }
  return observations;
}
function cacheFixture(count = 1) {
  const f = fixture(); const app = join(f.root, "cache-app"); const marker = join(f.root, "source-executed"); const files: CacheFile[] = [];
  for (let i = 0; i < count; i++) {
    const path = `backend/source-${i}.py`; const source = `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('not allowed')\nassert False, 'source must not execute'\n`;
    const full = join(app, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, source);
    files.push({ path, sha256: createHash("sha256").update(source).digest("hex") });
  }
  return { ...f, app, marker, files };
}

function cacheDiscoveryFixture() {
  const python = cachePython(); const f = cacheFixture(); const cache = generateCache(python, join(f.app, f.files[0].path));
  // Simulate version reports only; cache compilation still uses real CPython.
  const interpreter = (path: string, version = "3.12") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!${python}
import json,os,sys
if len(sys.argv)==6:
 with open(os.environ['FIXTURE_PYTHON_CALLS'],'a') as trace:
  trace.write(json.dumps(os.path.abspath(sys.argv[0]))+'\\n')
 print(${JSON.stringify(version)})
else:
 os.execv(${JSON.stringify(python)},[${JSON.stringify(python)},*sys.argv[1:]])
`, { mode: 0o755 });
    return path;
  };
  const sibling = interpreter(join(f.root, "crew-runtime/bin/python3.12")); const realLauncher = join(dirname(sibling), "kirocrew"); writeFileSync(realLauncher, "launcher location\n");
  const launcher = join(f.root, "launchers/kirocrew"); mkdirSync(dirname(launcher)); symlinkSync(realLauncher, launcher);
  const bundleRoot = join(f.root, "bundle"); const bundled = interpreter(join(bundleRoot, "kirocrew-backend-b/bin/python3.12"));
  const pathPython = interpreter(join(f.root, "path-bin/python3.12")); symlinkSync(pathPython, join(dirname(pathPython), "python3"));
  const env = { KIROCREW_PYTHON: undefined, PATH: dirname(pathPython), FIXTURE_PYTHON_CALLS: join(f.root, "python-versions.jsonl") }; const candidates = { launcher, bundleRoot };
  const run = (override?: string, fault = "", roots: CacheCandidateRoots = candidates) => cacheTwins(f, f.app, f.files, { ...env, KIROCREW_PYTHON: override }, fault, roots);
  return { ...f, cache, interpreter, sibling, bundled, bundleRoot, candidates, run };
}
function expectCacheResolution(results: CacheObservation[], interpreter: string | null, commands: string[]) {
  for (const result of results) {
    expect(result.ok, result.detail).toBe(interpreter !== null);
    expect(result.detail).toBe(interpreter === null
      ? "Unverifiable Python cache: Python 3.12 interpreter not resolvable; interpreter: unresolved. Stop Crew, delete __pycache__ and restart with PYTHONDONTWRITEBYTECODE=1, then recheck."
      : `; verified Python cache (interpreter: ${interpreter})`);
    expect(result.calls.map((call) => call.command)).toEqual(commands); expect(result.which).toEqual([]);
    expect(result.versions).toEqual(interpreter === null ? commands : commands.slice(0, -1));
  }
}

test("both cache verifiers use authoritative overrides without consulting usable injected fallbacks", () => {
  const f = cacheDiscoveryFixture(); const override = f.interpreter(join(f.root, "override/python3.12"));
  expectCacheResolution(f.run(override), override, [override, override]);
  const wrong = f.interpreter(join(f.root, "wrong/python3.12"), "3.11");
  const notExecutable = f.interpreter(join(f.root, "nonexecutable/python3.12")); chmodSync(notExecutable, 0o600);
  for (const invalid of ["relative", "", join(f.root, "absent/python3.12"), notExecutable, wrong]) {
    expectCacheResolution(f.run(invalid), null, invalid === wrong ? [wrong] : []);
  }
  rmSync(dirname(f.cache), { recursive: true });
  for (const result of f.run()) expect(result).toEqual({ ok: true, detail: "", calls: [], which: [], versions: [] });
  expect(existsSync(f.marker)).toBe(false);
});

test("both cache verifiers resolve launcher symlinks before bundles and ignore PATH interpreters", () => {
  const f = cacheDiscoveryFixture();
  // A decoy beside the symlink must not outrank the resolved launcher's sibling.
  f.interpreter(join(dirname(f.candidates.launcher), "python3.12"));
  expectCacheResolution(f.run(), f.sibling, [f.sibling, f.sibling]);
  for (const fault of ["missing", "nonexecutable", "wrong-version"]) {
    rmSync(f.sibling, { force: true });
    if (fault !== "missing") f.interpreter(f.sibling, fault === "wrong-version" ? "3.11" : "3.12");
    if (fault === "nonexecutable") chmodSync(f.sibling, 0o600);
    expectCacheResolution(f.run(), f.bundled, [...(fault === "wrong-version" ? [f.sibling] : []), f.bundled, f.bundled]);
  }
  expectCacheResolution(f.run(undefined, "", { launcher: null, bundleRoot: null }), null, []);
  expect(existsSync(f.marker)).toBe(false);
});

test("both cache verifiers bound bundle discovery before selecting sorted fixed-layout candidates", () => {
  const f = cacheDiscoveryFixture(); const roots: CacheCandidateRoots = { launcher: null, bundleRoot: f.bundleRoot };
  const later = f.interpreter(join(f.bundleRoot, "kirocrew-backend-c/bin/python3.12"));
  const earlier = f.interpreter(join(f.bundleRoot, "kirocrew-backend-a/bin/python3.12"), "3.11");
  for (const path of ["other-backend/bin/python3.12", "kirocrew-backend-/bin/python3.12", "nested/kirocrew-backend-first/bin/python3.12", "kirocrew-backend-flat/python3.12", "kirocrew-backend-generic/bin/python3"]) f.interpreter(join(f.bundleRoot, path));
  writeFileSync(join(f.bundleRoot, "kirocrew-backend-file"), "not a directory");
  const run = (bundleRoot: string | null = f.bundleRoot) => f.run(undefined, "", { ...roots, bundleRoot });
  expectCacheResolution(run(), f.bundled, [earlier, f.bundled, f.bundled]);
  rmSync(f.bundled); rmSync(later);
  expectCacheResolution(run(), null, [earlier]);
  f.interpreter(f.bundled);
  for (let count = readdirSync(f.bundleRoot).length; count < 64; count++) mkdirSync(join(f.bundleRoot, `unused-${count}`));
  expectCacheResolution(run(), f.bundled, [earlier, f.bundled, f.bundled]);
  const overflow = join(f.bundleRoot, "one-too-many"); mkdirSync(overflow);
  expectCacheResolution(run(), null, []); rmSync(overflow, { recursive: true });
  chmodSync(f.bundleRoot, 0);
  try { expectCacheResolution(run(), null, []); } finally { chmodSync(f.bundleRoot, 0o755); }
  const notDirectory = join(f.root, "bundle-file"); writeFileSync(notDirectory, "not a directory");
  const linked = join(f.root, "bundle-link"); symlinkSync(f.bundleRoot, linked);
  for (const absent of [null, join(f.root, "missing-bundle"), notDirectory, linked]) expectCacheResolution(run(absent), null, []);
  expect(existsSync(f.marker)).toBe(false);
});

test("both cache verifiers accept real compiled variants within budgets without executing source or trusting header metadata", () => {
  const python = cachePython(); const f = cacheFixture(16);
  const source = join(f.app, f.files[0].path); const bounded = `${read(source)}#`.padEnd(1024 * 1024, " ");
  writeFileSync(source, bounded); f.files[0].sha256 = createHash("sha256").update(bounded).digest("hex");
  const before = cacheTwins(f, f.app, f.files, { KIROCREW_PYTHON: "relative-invalid", PATH: "" });
  for (const result of before) { expect(result).toMatchObject({ ok: true, detail: "", calls: [], which: [] }); }
  for (const file of f.files) for (const [optimize, mode] of [[0, "TIMESTAMP"], [1, "UNCHECKED_HASH"], [2, "CHECKED_HASH"]] as const) generateCache(python, join(f.app, file.path), optimize, mode);
  for (const result of cacheTwins(f, f.app, f.files, { KIROCREW_PYTHON: python, PATH: "" })) {
    expect(result.ok, result.detail).toBe(true); expect(result.detail).toContain(`verified Python cache (interpreter: ${python})`);
    expect(result.which).toEqual([]); expect(result.calls).toHaveLength(17);
  }
  const cache = join(f.app, "backend/__pycache__/source-0.cpython-312.pyc"); const bytes = readFileSync(cache); bytes.fill(255, 8, 16); writeFileSync(cache, bytes);
  for (const result of cacheTwins(f, f.app, f.files, { KIROCREW_PYTHON: python })) expect(result.ok, result.detail).toBe(true);
  expect(existsSync(f.marker)).toBe(false);
});

test("both cache verifiers refuse unsafe entries and failed bounded interpreter checks", () => {
  const python = cachePython(); const f = cacheFixture(); const source = join(f.app, f.files[0].path);
  const cache = generateCache(python, source); const bytes = readFileSync(cache); const original = read(source);
  const refuse = (env: NodeJS.ProcessEnv, files = f.files, fault = "") => {
    for (const result of cacheTwins(f, f.app, files, env, fault)) { expect(result.ok, result.detail).toBe(false); expect(result.detail).toContain("Unverifiable Python cache:"); expect(result.detail).toContain("delete __pycache__"); expect(result.detail).toContain("PYTHONDONTWRITEBYTECODE=1"); }
  };
  const env = { KIROCREW_PYTHON: python }; refuse(env, f.files, "timeout"); refuse(env, f.files, "compiler");
  for (const kind of ["magic", "flags", "short", "payload", "oversize", "cache-link", "source-link", "source-drift", "source-oversize", "unknown", "fourth-variant", "no-sibling", "source-budget", ...(process.platform === "win32" ? [] : ["fifo"])]) {
    const extra = join(dirname(cache), "unrelated.cpython-312.pyc"); const foreign = join(f.app, "__pycache__"); const saved = join(f.root, "source-copy.py"); writeFileSync(saved, original);
    let files = f.files;
    if (kind === "magic") { const changed = Buffer.from(bytes); changed[0] ^= 1; writeFileSync(cache, changed); }
    if (kind === "flags") { const changed = Buffer.from(bytes); changed.writeUInt32LE(4, 4); writeFileSync(cache, changed); }
    if (kind === "short") writeFileSync(cache, bytes.subarray(0, 16));
    if (kind === "payload") { const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; writeFileSync(cache, changed); }
    if (kind === "oversize") writeFileSync(cache, Buffer.alloc(1024 * 1024 + 1));
    if (kind === "cache-link") { rmSync(cache); symlinkSync(saved, cache); }
    if (kind === "source-link") { rmSync(source); symlinkSync(saved, source); }
    if (kind === "source-drift") writeFileSync(source, "changed = True\n");
    if (kind === "source-oversize") writeFileSync(source, `#${" ".repeat(1024 * 1024)}`);
    if (kind === "unknown") writeFileSync(extra, bytes);
    if (kind === "fourth-variant") for (const name of ["source-0.cpython-312.opt-1.pyc", "source-0.cpython-312.opt-2.pyc", "source-0.cpython-312.opt-3.pyc"]) writeFileSync(join(dirname(cache), name), bytes);
    if (kind === "no-sibling") mkdirSync(foreign, { recursive: true });
    if (kind === "source-budget") files = [...f.files, ...Array.from({ length: 16 }, (_, i) => ({ path: `backend/extra-${i}.py`, sha256: f.files[0].sha256 }))];
    if (kind === "fifo") { rmSync(cache); expect(spawnSync("mkfifo", [cache], { timeout: 2000 }).status).toBe(0); }
    refuse(env, files);
    rmSync(dirname(cache), { recursive: true }); mkdirSync(dirname(cache)); writeFileSync(cache, bytes);
    rmSync(source); writeFileSync(source, original); rmSync(foreign, { recursive: true, force: true });
  }
  expect(existsSync(f.marker)).toBe(false);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

test("cache identity controls setup admission and doctor clearance without weakening source freshness or repairing files", () => {
  const python = cachePython(); const f = doctorFixture(); const cache = generateCache(python, join(f.paths.appRoot, "backend/routes.py"));
  const env = { KIROCREW_PYTHON: python }; const before = f.owned();
  const ready = f.run("status", ["--project-dir", f.project], env); const doctor = f.doctor(env);
  expect(setupRow(ready.report, "App installed+enabled")).toMatchObject({ status: "ok", detail: expect.stringContaining("verified Python cache") });
  expect(doctor.row("App installed+enabled")).toMatchObject({ pass: true, label: expect.stringContaining("verified Python cache") }); expect(f.owned()).toEqual(before);
  const oldPython = process.env.KIROCREW_PYTHON; process.env.KIROCREW_PYTHON = python;
  try {
    const local = checkAppIdentity(f.paths.appRoot, f.paths.appRoot); expect(local.matches, local.reason).toBe(true); expect(local.reason).toContain("source freshness not established");
    expect(() => applyApp(f.paths.appRoot, f.home, f.host)).toThrow("cannot decide source freshness");
    for (const fault of ["unresolved", "payload"]) {
      const selectedPython = fault === "unresolved" ? join(f.root, "absent-python") : python;
      process.env.KIROCREW_PYTHON = selectedPython;
      if (fault === "payload") { const bytes = readFileSync(cache); bytes[bytes.length - 1] ^= 1; writeFileSync(cache, bytes); }
      const refused = f.owned(); let called = false;
      const identity = checkAppIdentity(portable, f.paths.appRoot); expect(identity.matches).toBe(false);
      if (fault === "unresolved") expect(identity.reason).toContain("Python 3.12 interpreter not resolvable; interpreter: unresolved.");
      expect(() => applyApp(portable, f.home, () => { called = true; return ""; })).toThrow("Unverifiable Python cache"); expect(called).toBe(false);
      const failingEnv = { KIROCREW_PYTHON: selectedPython };
      const status = f.run("status", ["--project-dir", f.project], failingEnv); expect(status.status).toBe(1); expect(setupRow(status.report, "App installed+enabled").status).toBe("fail");
      const failed = f.doctor(failingEnv); expect(failed.status).toBe(1); expect(failed.row("App installed+enabled").pass).toBe(false);
      for (const text of [status.stdout, failed.stdout]) { expect(text).toContain("delete __pycache__"); expect(text).toContain("PYTHONDONTWRITEBYTECODE=1"); }
      expect(f.owned()).toEqual(refused);
    }
  } finally { if (oldPython === undefined) delete process.env.KIROCREW_PYTHON; else process.env.KIROCREW_PYTHON = oldPython; }
});
