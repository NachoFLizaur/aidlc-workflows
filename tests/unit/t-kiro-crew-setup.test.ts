// covers: subcommand:aidlc-utility:doctor
import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
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
    else result[path] = `${statSync(full).mode}:${statSync(full).mtimeMs}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
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
  const key = "dashboard:doctor"; json(join(f.home, "session_map.json"), { [key]: { cwd: f.project } });
  const binding = bindCrewSession(f.home, f.project, key); const session = `crew-${binding.keyHash}`;
  const run = (env: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(process.execPath, [join(f.project, ".kiro-crew/tools/aidlc.ts"), "--doctor", "--json", "--offline"], {
      cwd: f.project, env: { ...f.env, ...env }, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), maxBuffer: 8 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    const checks = (JSON.parse(result.stdout).data.checks as { label: string; pass: boolean; severity?: string }[]).filter(({ label }) => label.startsWith("Crew integration — "));
    const row = (name: string) => { const found = checks.find(({ label }) => label.startsWith(`Crew integration — ${name}:`)); expect(found, result.stdout).toBeDefined(); return found!; };
    return { ...result, checks, row };
  };
  return { ...f, key, session, binding, hooks, doctor: run };
}

test("status and trust are read-only pending reports on an unconfigured project", () => {
  const f = fixture(); const before = f.owned();
  const status = f.run("status", ["--project-dir", f.project]);
  expect(status.status).toBe(0); expect(status.report.rows).toHaveLength(6);
  expect(status.report.rows.every(({ status }) => status === "pending")).toBe(true);
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

test("doctor returns nine integration checks and never repairs an absent or ready installation", () => {
  const f = doctorFixture(); const before = f.owned(); const ready = f.doctor();
  expect(ready.checks).toHaveLength(9); expect(ready.checks.every(({ pass }) => pass)).toBe(true); expect(f.owned()).toEqual(before);
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
