/** Registration-only support. Importing never looks up executables, creates a
 * home, starts a gateway or sends a model prompt. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { applyApp } from "../../harness/kiro-crew/setup/aidlc-kiro-crew-setup.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT, removeWorkspaceRecord } from "./fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

export const RUNTIME = join(REPO_ROOT, "dist/kiro-crew");
export const APP = join(RUNTIME, "kiro-crew-app");
export type Server = { command: string; args: string[]; env?: Record<string, string> };
export type RpcResponse = {
  jsonrpc: string; id: number;
  result?: { protocolVersion?: string; serverInfo?: { name: string }; tools?: { name: string }[]; content?: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
};

/** Read opt-in and both vetoes before lookup/mutation and immediately before
 * each live launch. Missing opt-in skips in the caller; a revoked gate throws.
 * There is no bypass and no fallback to the operator's existing home. */
export function requireLive(): void {
  if (process.env.AIDLC_KIRO_CREW_LIVE !== "1" || process.env.AIDLC_NO_LLM === "1" || process.argv.includes("--no-llm")) {
    throw new Error("Crew registration requires explicit live opt-in without a no-LLM veto");
  }
}
/** Read the selector before lookup or scratch allocation. Only Kiro and Claude
 * can register this journey; invalid values throw, never fall back. Selection
 * affects only the newly allocated home and cannot bypass live vetoes. */
export function registrationBackend(env: NodeJS.ProcessEnv = process.env): "kiro" | "claude" {
  const backend = env.AIDLC_KIRO_CREW_BACKEND ?? "kiro";
  if (backend !== "kiro" && backend !== "claude") throw new Error("Crew registration backend must be kiro or claude");
  return backend;
}
function prerequisites() {
  requireLive();
  const backend = registrationBackend();
  const crew = Bun.which("kirocrew");
  if (!crew || !Bun.which("bun")) throw new Error("Crew registration requires kirocrew and Bun on PATH");
  if (!existsSync(join(APP, "app.json")) || !existsSync(join(RUNTIME, ".kiro-crew/tools/aidlc.ts"))) {
    throw new Error("Crew registration requires the packaged App Kit and project runtime");
  }
  return { crew, backend };
}
function createCrewScratch(backend: "kiro" | "claude") {
  requireLive();
  const root = createTestProject();
  removeWorkspaceRecord(root);
  const home = join(root, "crew");
  const project = join(root, "selected project");
  const env = {
    PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
    HOME: root, USERPROFILE: root, TMPDIR: root,
    KIROCREW_HOME: home, KIRO_HOME: join(home, "kiro"), KIROCREW_WORKSPACE: join(root, "workspace"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    AIDLC_INSTALL_ROOT: join(root, "machine"), AIDLC_BIN_DIR: join(root, "bin"),
  };
  for (const path of [home, project]) mkdirSync(path, { recursive: true });
  // Crew encodes the default Kiro CLI backend as an empty acp_backend value.
  writeFileSync(join(home, "config.json"), JSON.stringify({ agent: { acp_backend: backend === "kiro" ? "" : "claude", member_acp_backend: backend === "kiro" ? "kas" : "claude" } }));
  const run = (command: string, args: string[]) => {
    requireLive();
    const result = spawnSync(command, args, { cwd: project, env, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  return { root, home, project, env, run, backend };
}
export type Registration = ReturnType<typeof createCrewScratch>;

/** The newly allocated scratch root is the only write oracle. Read setup's cwd
 * grant before granting this one app; no existing or caller-supplied home is
 * accepted. Failure throws before registration; no blanket-trust bypass. */
function grantScratchApp(f: Registration): void {
  const path = join(f.home, "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!config.agent?.subagent_cwd_allowed_roots?.includes(f.project) || config.agent.apps_allow_third_party !== undefined) {
    throw new Error("Project setup did not establish the isolated cwd grant");
  }
  config.agent.apps_trusted = ["aidlc"];
  config.agent.apps_trusted_local = ["aidlc"];
  writeFileSync(path, JSON.stringify(config));
}
export function createRegistration(): Registration {
  const { crew, backend } = prerequisites();
  const f = createCrewScratch(backend);
  try {
    f.run(process.execPath, [join(APP, "setup/aidlc-kiro-crew-setup.ts"), "project", "--project-dir", f.project, "--runtime-root", RUNTIME, "--crew-home", f.home]);
    grantScratchApp(f);
    applyApp(APP, f.home, (args) => f.run(crew, args));
    return f;
  } catch (error) { cleanupTestProject(f.root); throw error; }
}

/** Read the registered conductor after installation and before spawn. Missing
 * registration fails; never substitute portable/source argv. No bypass. */
export function registeredServer(f: Registration): Server {
  const agent = JSON.parse(readFileSync(join(f.home, "kiro/agents/aidlc--aidlc-crew.json"), "utf8"));
  const server = agent.mcpServers?.["aidlc:engine"] as Server | undefined;
  if (!server?.command || !Array.isArray(server.args)) throw new Error("Registered conductor has no aidlc:engine server");
  return server;
}

/** Shared bounded stdio transport for real registered and deterministic bridge
 * calls. The caller supplies test-owned cwd/env and, for live use, rechecks the
 * gate before calling. Protocol errors reject; no alternate executable. */
export function connect(server: Server, cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(server.command, server.args, { cwd, env: { ...env, ...server.env }, stdio: "pipe" });
  let diagnostics = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-65536); });
  child.stdin.on("error", (error) => { diagnostics += error.message; });
  const closed = new Promise<void>((done) => {
    child.once("close", () => done());
    child.once("error", (error) => { diagnostics += error.message; done(); });
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const lines = reader[Symbol.asyncIterator]();
  let id = 0;
  return {
    async request(method: string, params: unknown = {}): Promise<RpcResponse> {
      const current = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const line = await Promise.race([lines.next(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Crew MCP timed out: ${diagnostics}`)); }, remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS));
        })]);
        if (line.done) throw new Error(`Crew MCP closed: ${diagnostics}`);
        const response = JSON.parse(line.value) as RpcResponse;
        if (response.jsonrpc !== "2.0" || response.id !== current || response.error) throw new Error(`Crew MCP response: ${line.value}`);
        return response;
      } finally { clearTimeout(timer); }
    },
    initialized() { child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); },
    async close() { child.kill("SIGKILL"); await closed; reader.close(); },
  };
}
export async function initialize(client: ReturnType<typeof connect>): Promise<void> {
  const response = await client.request("initialize", { capabilities: {}, clientInfo: { name: "registration-test", version: "0" } });
  if (response.result?.serverInfo?.name !== "aidlc-kiro-crew" || !response.result.protocolVersion) throw new Error("Crew MCP handshake mismatch");
  client.initialized();
}
