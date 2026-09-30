import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmitContext } from "../../scripts/manifest-types.ts";
import { projectionFiles } from "../../core/tools/aidlc-distribution.ts";
import emit from "../../harness/kiro-crew/emit.ts";
import { collectAppEmissions } from "../../harness/kiro-crew/emit/app.ts";
import { buildAppInventory, validateAppKit, type AppInventory } from "../../harness/kiro-crew/emit/app-validator.ts";
import { collectSkillEmissions, type CrewSkillsManifest } from "../../harness/kiro-crew/emit/skills.ts";
import { parseCrewSkillFrontmatter, validateCrewSkillFrontmatter } from "../../harness/kiro-crew/emit/skill-grammar.ts";
import type { Emission } from "../../harness/kiro-crew/emit/types.ts";
import { validateCrewStamp } from "../../harness/kiro-crew/hooks/aidlc-kiro-crew-hook-entry.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";
import { registrationBackend } from "../harness/kiro-crew-live.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTestProject(root); });
const fresh = () => { const root = createTestProject(); roots.push(root); return root; };
const runtime = join(REPO_ROOT, "dist/kiro-crew");
const shell = Bun.which("sh")!;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function files(root: string, prefix = ""): Emission[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(root, path) : [{ path, content: readFileSync(join(root, path), "utf8"), mode: (statSync(join(root, path)).mode & 0o777) as Emission["mode"] }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function fixture(): EmitContext {
  const root = fresh(); const distRoot = join(root, "distribution");
  cpSync(runtime, distRoot, { recursive: true });
  for (const path of ["core/agents", "harness/kiro/agents", "harness/kiro-crew"]) cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
  return { repoRoot: root, coreRoot: join(root, "core"), harnessRoot: join(root, "harness/kiro-crew"), harnessName: "kiro-crew", distRoot, harnessDir: ".kiro-crew", trustedRouteNamespace: "engine", tierCap: null,
    substituteToken: (text) => text.replaceAll("{{HARNESS_DIR}}", ".kiro-crew").replaceAll("{{TOOL_PREFIX}}", "bun .kiro-crew/tools/") };
}
type Agent = { name: string; prompt: string; tools: string[]; allowedTools: string[]; resources: string[]; includeMcpJson: boolean; toolsSettings: { execute_bash: { deniedCommands: string[] } }; permissions: { rules: { capability: string; match: string[]; effect: string }[] } };
function changeJson(snapshot: Emission[], path: string, change: (value: Record<string, unknown>) => void): void {
  const entry = snapshot.find((file) => file.path === path)!;
  const value = JSON.parse(entry.content) as Record<string, unknown>; change(value); entry.content = JSON.stringify(value);
}

test("both distribution channels emit a valid owned inventory and project resources", () => {
  for (const channel of ["dist", "dist-release"]) {
    const project = join(REPO_ROOT, channel, "kiro-crew"); const app = join(project, "kiro-crew-app");
    const { descriptor } = projectionFiles(project);
    expect(descriptor.managedDirectories).toEqual([".kiro-crew", "aidlc"]);
    expect(descriptor.managedDirectories).not.toContain("kiro-crew-app");
    expect(descriptor.hostDirectories).toEqual(["kiro-crew-app"]);
    expect(descriptor.rootIntegrations.map(({ path }) => path)).toEqual([".gitignore"]);
    const snapshot = files(app);
    expect(validateAppKit(snapshot, project)).toEqual([]);
    const inventory = JSON.parse(readFileSync(join(app, "app-inventory.json"), "utf8")) as AppInventory;
    expect(inventory.files.map(({ path }) => path).sort()).toEqual(snapshot.map(({ path }) => path).sort());
    for (const file of inventory.files) {
      expect(statSync(join(app, file.path)).mode & 0o777).toBe(file.mode);
      if (file.path !== "app-inventory.json") expect(sha(readFileSync(join(app, file.path)))).toBe(file.sha256);
    }
    const self = inventory.files.find(({ path }) => path === "app-inventory.json")!; const digest = self.sha256; self.sha256 = "";
    expect(sha(`${JSON.stringify(inventory, null, 2)}\n`)).toBe(digest);
    expect(existsSync(join(app, "tools"))).toBe(false);
    expect(existsSync(join(project, ".kiro-crew/AGENTS.md"))).toBe(true);
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
  }
});

test("agent projection preserves deny rules while stripping approval and unprovisioned grants", () => {
  const ctx = fixture(); const sourcePath = join(ctx.repoRoot, "harness/kiro/agents/aidlc-product-lead-agent.json");
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as Agent;
  source.tools.push("@unmounted/read", "Task"); source.allowedTools.push("fs_write", "fs_read", "@unmounted/read");
  source.toolsSettings.execute_bash.deniedCommands.push("fixture-denial");
  writeFileSync(sourcePath, JSON.stringify(source));
  const output = collectAppEmissions(ctx);
  const agent = JSON.parse(output.find(({ path }) => path === "agents/aidlc-product-lead-agent.json")!.content) as Agent;
  expect(agent.name).toBe("aidlc-crew-product-lead-agent");
  expect(agent.tools).not.toContain("Task"); expect(agent.tools).not.toContain("@unmounted/read");
  expect(agent.allowedTools.every((tool) => tool === "thinking")).toBe(true);
  expect(agent.toolsSettings.execute_bash.deniedCommands).toEqual(source.toolsSettings.execute_bash.deniedCommands);
  expect(agent.permissions.rules.find(({ capability }) => capability === "fs_read")).toEqual({ capability: "fs_read", match: ["*"], effect: "ask" });
  expect(JSON.parse(output.find(({ path }) => path === "role-map.json")!.content).strippedMcpReferences["aidlc-product-lead-agent"]).toContain("@unmounted/read");
  const native = collectAppEmissions({ ...ctx, substituteToken: (text) => text.replaceAll("{{TOOL_PREFIX}}", "aidlc engine ").replaceAll("{{HARNESS_DIR}}", ".kiro-crew") });
  expect(validateAppKit([...files(join(ctx.distRoot, "kiro-crew-app")).filter(({ path }) => !native.some((entry) => entry.path === path)), ...native], ctx.distRoot)).toEqual([]);
});

test("role identity, missing personas and role-count errors abort before app replacement", () => {
  for (const fault of ["identity", "persona", "role-count"]) {
    const ctx = fixture(); const app = join(ctx.distRoot, "kiro-crew-app"); const before = files(app);
    if (fault === "identity") {
      const path = join(ctx.repoRoot, "harness/kiro/agents/aidlc.json");
      const value = JSON.parse(readFileSync(path, "utf8")); value.name = "foreign"; writeFileSync(path, JSON.stringify(value));
    } else if (fault === "persona") writeFileSync(join(ctx.distRoot, ".kiro-crew/agents/aidlc-developer-agent.md"), "no frontmatter\n");
    else rmSync(join(ctx.coreRoot, "agents/aidlc-developer-agent.md"));
    expect(() => emit(ctx), fault).toThrow(); expect(files(app)).toEqual(before);
  }
});

test("skill grammar handles scalar boundaries and refuses malformed required fields", () => {
  const valid = "---\nname: aidlc\ndescription: >-\n  First line\n  second line\n---\n";
  expect(parseCrewSkillFrontmatter(valid).get("description")).toBe("First line second line");
  expect(validateCrewSkillFrontmatter(valid.replaceAll("\n", "\r\n"), "SKILL.md")).toEqual([]);
  expect(validateCrewSkillFrontmatter(`${valid}${"body\n".repeat(494)}`, "SKILL.md")).toEqual([]);
  for (const bad of [valid.replace("name: aidlc", "name: ''"), valid.replace("description: >-", "description: []"), valid.replace("name: aidlc", "name: aidlc\nname: another"), valid.replace("name: aidlc", "name: aidlc\nhooks:\n  run: value"), valid.replace("name: aidlc", "name: aidlc\nallowed-tools: shell"), valid.replace(/^---/, " ---"), valid.replaceAll("\n", "\r"), `${valid}${"body\n".repeat(495)}`, valid.slice(0, -4)]) {
    expect(validateCrewSkillFrontmatter(bad, "SKILL.md").length, bad).toBeGreaterThan(0);
  }
});

test("skill inventory is ordered and unknown kinds or missing annexes never emit partially", () => {
  const ctx = fixture();
  const manifest = JSON.parse(collectSkillEmissions(ctx)[0].content) as CrewSkillsManifest;
  expect(manifest.skills.map(({ path }) => path)).toEqual(manifest.skills.map(({ path }) => path).sort());
  expect(new Set(manifest.resources).size).toBe(manifest.resources.length);
  expect(new Set(manifest.skills.map(({ kind }) => kind))).toEqual(new Set(["orchestrator", "stage-runner", "scope-runner", "session", "knowledge", "init", "compose"]));
  for (const uri of [...manifest.resources, manifest.questionRendering, manifest.delegation]) expect(statSync(join(ctx.distRoot, uri.replace(/^\w+:\/\//, ""))).isFile()).toBe(true);
  const app = join(ctx.distRoot, "kiro-crew-app"); const before = files(app);
  const extra = join(ctx.distRoot, ".kiro-crew/skills/unknown/SKILL.md"); mkdirSync(dirname(extra));
  writeFileSync(extra, "---\nname: unknown\ndescription: unknown skill\n---\n");
  expect(() => emit(ctx)).toThrow("unknown kind"); expect(files(app)).toEqual(before); rmSync(dirname(extra), { recursive: true });
  rmSync(join(ctx.distRoot, ".kiro-crew/skills/aidlc/delegation.md"));
  expect(() => emit(ctx)).toThrow(); expect(files(app)).toEqual(before);
});

test("collector path validation precedes deletion and preserves sibling trees", () => {
  const ctx = fixture(); const before = files(join(ctx.distRoot, "kiro-crew-app"));
  const sibling = join(ctx.distRoot, "sibling.txt"); writeFileSync(sibling, "foreign bytes");
  for (const paths of [["../escape"], ["absolute:entry"], ["a\\b"], ["same", "same"], ["file", "file/child"]]) {
    const script = join(ctx.repoRoot, "collector-test.ts");
    writeFileSync(script, `import {mock} from 'bun:test';
      mock.module(${JSON.stringify(join(REPO_ROOT, "harness/kiro-crew/emit/launcher.ts"))}, () => ({collectLauncherEmissions: () => ${JSON.stringify(paths.map((path) => ({ path, content: "text" })))}, substituteLauncherInvocation: (_ctx: unknown, text: string) => text}));
      for (const [name, fn] of [['skills','collectSkillEmissions'],['hooks','collectHookEmissions'],['app','collectAppEmissions']]) mock.module(${JSON.stringify(join(REPO_ROOT, "harness/kiro-crew/emit"))} + '/' + name + '.ts', () => ({[fn]: () => []}));
      const {default: emit} = await import(${JSON.stringify(join(REPO_ROOT, "harness/kiro-crew/emit.ts"))});
      emit({...${JSON.stringify(ctx)}, substituteToken: (text: string) => text});`);
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/invalid or duplicate path|file\/directory collision/);
    expect(files(join(ctx.distRoot, "kiro-crew-app"))).toEqual(before); expect(readFileSync(sibling, "utf8")).toBe("foreign bytes");
  }
  emit(ctx); expect(readFileSync(sibling, "utf8")).toBe("foreign bytes");
});

test("validator rejects malformed JSON, unresolved tokens, modes and inventory tampering", () => {
  const snapshot = files(join(runtime, "kiro-crew-app"));
  for (const [change, expected] of [
    [(list: Emission[]) => { list.find(({ path }) => path === "app.json")!.content = "{"; }, /invalid JSON/],
    [(list: Emission[]) => { list[0].content += "{{MISSING}}"; }, /unresolved placeholder/],
    [(list: Emission[]) => { list[0].mode = 0o600 as Emission["mode"]; }, /invalid mode/],
    [(list: Emission[]) => { list[0].content += "tampered"; }, /ownership\/mode\/hash mismatch/],
    [(list: Emission[]) => { list.push({ ...list[0] }); }, /duplicate emission path/],
  ] as const) {
    const changed = structuredClone(snapshot); change(changed);
    expect(validateAppKit(changed, runtime).join("\n")).toMatch(expected);
  }
});

test("validator enforces role identity, flat dispatch, permission gates and inline prompts", () => {
  const snapshot = files(join(runtime, "kiro-crew-app"));
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ name: "aidlc" }, /name collision/], [{ name: "invalid name" }, /invalid Crew dispatch/],
    [{ tools: ["Task"] }, /native dispatch/], [{ tools: ["@kirocrew-core/spawn_run"] }, /nested Crew dispatch/],
    [{ tools: ["@unmounted/read"] }, /undeclared MCP/], [{ tools: ["@aidlc:engine/aidlc_engine"] }, /bind_session grant/],
    [{ allowedTools: ["fs_read"] }, /guarded or unverified/], [{ allowedTools: ["@aidlc:engine/aidlc_bind_session"] }, /guarded or unverified/],
    [{ permissions: { rules: [] } }, /missing permission gate/], [{ toolsSettings: { autoApprove: ["*"] } }, /auto-approval surface/],
    [{ includeMcpJson: true }, /includeMcpJson/], [{ prompt: "file://persona.md" }, /inline text/],
    [{ prompt: "changed prompt" }, /inline prompt differs/], [{ model: "override" }, /forbidden model/],
  ];
  for (const [fields, expected] of cases) {
    const changed = structuredClone(snapshot);
    changeJson(changed, "agents/aidlc-product-lead-agent.json", (value) => Object.assign(value, fields));
    expect(validateAppKit(changed, runtime).join("\n")).toMatch(expected);
  }
  const changed = structuredClone(snapshot);
  changeJson(changed, "role-map.json", (value) => { value.roles = { aidlc: { dispatchName: "foreign", reviewer: true } }; });
  expect(validateAppKit(changed, runtime).join("\n")).toContain("invalid mapping");
});

test("validator refuses unsafe registered commands and escaping resources", () => {
  const ctx = fixture(); const snapshot = files(join(ctx.distRoot, "kiro-crew-app"));
  for (const command of ["bun relative.ts", "sh -c command", `'\${UNRESOLVED}' script`, "exec command", "'unterminated", "command && other"]) {
    const changed = structuredClone(snapshot);
    changeJson(changed, "hooks.fragment.json", (value) => { (value.hooks as { command: string }[])[0].command = command; });
    expect(validateAppKit(changed, ctx.distRoot).some((error) => error.startsWith("hooks.fragment.json:") && /command|interpreter|syntax|quote/.test(error))).toBe(true);
  }
  for (const args of [["relative.ts"], ["__AIDLC_UNKNOWN__"], ["-c"], [`\${HOME}`]]) {
    const changed = structuredClone(snapshot);
    changeJson(changed, "mcp.fragment.json", (value) => { value.mcpServers = { engine: { command: "bun", args } }; });
    expect(validateAppKit(changed, ctx.distRoot).join("\n")).toMatch(/PATH-relative|relative path|portable path marker|shell/);
  }
  const outside = join(ctx.repoRoot, "outside"); mkdirSync(outside); writeFileSync(join(outside, "text.md"), "outside");
  symlinkSync(outside, join(ctx.distRoot, ".kiro-crew/escape"));
  for (const uri of ["file://../outside/text.md", "file://.kiro-crew/absent.md", "file://.kiro-crew/escape/text.md", "file://.kiro-crew/AGENTS.md/*.md"]) {
    const changed = structuredClone(snapshot);
    changeJson(changed, "agents/aidlc.json", (value) => { (value.resources as string[]).push(uri); });
    expect(validateAppKit(changed, ctx.distRoot).join("\n")).toMatch(/escaping resource|project-relative/);
  }
});

test("entry and shell launcher agree on strict project-stamp grammar", () => {
  const ctx = fixture(); const stamp = join(ctx.distRoot, ".kiro-crew/tools/data/aidlc-stamp.json");
  const valid = readFileSync(stamp, "utf8");
  const bin = join(ctx.repoRoot, "bin"); mkdirSync(bin);
  const native = join(bin, "aidlc"); writeFileSync(native, "#!/bin/sh\nexit 0\n"); chmodSync(native, 0o755);
  const launcher = join(ctx.distRoot, "kiro-crew-app/aidlc-kiro-crew-launcher.sh");
  const run = () => spawnSync(shell, [launcher, "engine", "status"], { env: { PATH: bin, AIDLC_PROJECT_DIR: ctx.distRoot }, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(validateCrewStamp(stamp).ok).toBe(true); expect(run().status).toBe(0);
  for (const invalid of ["{}", valid.replace('"schemaVersion": 1', '"schemaVersion": 1e0'), valid.replace('"schemaVersion": 1', '"schemaVersion": 1,"schemaVersion": 1'), valid.replace('"kiro-crew"', '"kiro"'), valid.replace(/}\s*$/, ',"extra":true}'), valid.replace(/}\s*$/, ',"nested":{}}'), valid.replace('"kiro-crew"', '"kiro\\u002dcrew"'), valid.replace('"kiro-crew"', '"kiro-\ncrew"')]) {
    writeFileSync(stamp, invalid); expect(validateCrewStamp(stamp).ok, invalid).toBe(false); expect(run().status, invalid).toBe(1);
  }
});

test("relocated bootstrap selects Bun before native and never retries a failed runtime", () => {
  const ctx = fixture(); const home = join(ctx.repoRoot, "crew home"); const app = join(home, "apps/aidlc");
  cpSync(join(ctx.distRoot, "kiro-crew-app"), app, { recursive: true });
  const bin = join(ctx.repoRoot, "bin"); mkdirSync(bin); const trace = join(ctx.repoRoot, "runtime.json");
  for (const [name, code] of [["bun", 7], ["aidlc", 0]] as const) {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(trace)}, JSON.stringify({name:${JSON.stringify(name)},args:process.argv.slice(2),project:process.env.AIDLC_PROJECT_DIR})); process.exit(${code});`); chmodSync(path, 0o755);
  }
  const result = spawnSync(shell, [join(app, "aidlc-kiro-crew-bootstrap.sh"), "engine", "status", "literal; value"], { cwd: ctx.repoRoot, env: { PATH: bin, KIROCREW_HOME: home, AIDLC_PROJECT_DIR: ctx.distRoot }, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(result.status, result.stderr).toBe(7);
  expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual({ name: "bun", args: [join(ctx.distRoot, ".kiro-crew/tools/aidlc.ts"), "engine", "status", "literal; value"], project: ctx.distRoot });
});

test("bootstrap and launcher refuse missing app, engine and MCP runtime", () => {
  const ctx = fixture(); const app = join(ctx.distRoot, "kiro-crew-app"); const bin = join(ctx.repoRoot, "empty-bin"); mkdirSync(bin);
  const invoke = (file: string, args: string[] = []) => spawnSync(shell, [join(app, file), ...args], { env: { PATH: bin, KIROCREW_HOME: join(ctx.repoRoot, "absent-home"), AIDLC_PROJECT_DIR: ctx.distRoot }, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(invoke("aidlc-kiro-crew-bootstrap.sh").status).toBe(1);
  expect(invoke("aidlc-kiro-crew-launcher.sh").stderr).toContain("No runtime");
  const native = join(bin, "aidlc"); writeFileSync(native, "#!/bin/sh\nexit 0\n"); chmodSync(native, 0o755);
  expect(invoke("aidlc-kiro-crew-launcher.sh", ["mcp"]).stderr).toContain("requires bun");
  symlinkSync(process.execPath, join(bin, "bun")); rmSync(join(ctx.distRoot, ".kiro-crew/tools/aidlc.ts"));
  expect(invoke("aidlc-kiro-crew-launcher.sh").stderr).toContain("Missing project engine");
});

function namespaceFixture() {
  const root = fresh();
  // Reuse the upstream packaging fixture's source-only Claude projection to
  // isolate the native invocation check from App Kit resource validation.
  for (const path of ["core", "scripts", "harness/claude"]) cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
  for (const path of ["package.json", "bun.lock"]) cpSync(join(REPO_ROOT, path), join(root, path));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const harness = join(root, "harness/claude");
  cpSync(join(harness, "manifest.ts"), join(harness, "fixture-manifest.ts"));
  writeFileSync(join(harness, "manifest.ts"), `import manifest from "./fixture-manifest.ts";
export default { ...manifest, harnessFiles: [...manifest.harnessFiles, { src: "namespace-input.json", dst: "namespace-input.json" }] };
`);
  const source = join(harness, "namespace-input.json");
  const run = (value: unknown) => {
    writeFileSync(source, `${JSON.stringify(value)}\n`);
    return spawnSync(process.execPath, [join(root, "scripts/package.ts"), "claude"], {
      cwd: root, env: { ...process.env, TMPDIR: root }, encoding: "utf8",
      timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), maxBuffer: 8 * 1024 * 1024,
    });
  };
  return { root, source, run };
}

test("native packaging validates decoded multiline JSON prompts without changing their content", () => {
  const f = namespaceFixture();
  const value = { agents: [{ name: "composer", prompt: ["\n", "\r\n", "\r"].map((newline) =>
    `Run aidlc engine graph${newline}validate-grid --proposal composer-grid.json`,
  ).join("\n") }] };
  const result = f.run(value);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  for (const channel of ["dist", "dist-release"]) {
    expect(JSON.parse(readFileSync(join(f.root, channel, "claude/.claude/namespace-input.json"), "utf8"))).toEqual(value);
  }
});

test("native packaging refuses invalid decoded routes in JSON strings, nested values and keys", () => {
  const f = namespaceFixture();
  const invalid = "aidlc engine\ngraph missing-route";
  for (const [value, location] of [
    [invalid, "namespace-input.json:1:"],
    [{ agents: [{ prompt: invalid }] }, 'namespace-input.json["agents"][0]["prompt"]:1:'],
    [{ agents: [{ [invalid]: "ordinary value" }] }, " (key):1:"],
  ] as const) {
    const result = f.run(value);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(location);
    expect(result.stdout + result.stderr).toContain('unresolvable projected namespace invocation "aidlc engine graph missing-route"');
    expect(JSON.parse(readFileSync(f.source, "utf8"))).toEqual(value);
  }
}, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

test("child persona emission retains changed body and project bootstrap resources without native-only frontmatter", () => {
  const ctx = fixture(); const persona = join(ctx.distRoot, ".kiro-crew/agents/aidlc-developer-agent.md");
  const source = readFileSync(persona, "utf8"); const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const addition = "\nRead the project-specific greeting contract.\n";
  writeFileSync(persona, `---\nname: aidlc-developer-agent\nmodel: native-only\ndisallowedTools: Task, Agent\n---\n${body}${addition}`);
  const output = collectAppEmissions(ctx); const agent = JSON.parse(output.find(({ path }) => path === "agents/aidlc-developer-agent.json")!.content) as Agent;
  expect(agent.prompt.endsWith(body + addition)).toBe(true); expect(agent.prompt).not.toContain("model: native-only"); expect(agent.prompt).not.toContain("disallowedTools:");
  const skills = JSON.parse(output.find(({ path }) => path === "skills.manifest.json")?.content ?? collectSkillEmissions(ctx)[0].content) as CrewSkillsManifest;
  expect(agent.resources).toContain(skills.delegation); expect(agent.resources).toContain(skills.conductor);
  expect(agent.tools).toContain("@aidlc:engine/aidlc_bind_session"); expect(agent.allowedTools).not.toContain("@aidlc:engine/aidlc_bind_session");
  expect(agent.tools.some((tool) => tool.includes("spawn_"))).toBe(false);
});

test("both packaged bridges advertise the child project selector without permitting extra properties", () => {
  const root = fresh(); const home = join(root, "crew"); mkdirSync(home);
  for (const channel of ["dist", "dist-release"]) {
    const bridge = join(REPO_ROOT, channel, "kiro-crew/kiro-crew-app/mcp/aidlc-mcp-bridge.ts");
    const result = spawnSync(process.execPath, [bridge, "mcp", "--crew-home", home], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8", input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(result.status, result.stderr).toBe(0);
    const schema = JSON.parse(result.stdout).result.tools.find(({ name }: { name: string }) => name === "aidlc_bind_session").inputSchema;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, properties: { session_key: { type: "string", minLength: 1 }, project_dir: { type: "string", minLength: 1 } } });
    expect(schema.required ?? []).toEqual([]); expect(readdirSync(home)).toEqual([]); expect(existsSync(join(root, "aidlc/.aidlc-sessions"))).toBe(false);
  }
});

test("registration backend selection defaults to Kiro and refuses invalid selectors before scratch allocation", () => {
  expect(registrationBackend({})).toBe("kiro"); expect(registrationBackend({ AIDLC_KIRO_CREW_BACKEND: "claude" })).toBe("claude");
  const root = fresh(); const script = join(root, "registration-input.ts"); const marker = join(root, "scratch-called");
  writeFileSync(script, `import {mock} from 'bun:test';import {writeFileSync} from 'node:fs';const path=${JSON.stringify(join(REPO_ROOT, "tests/harness/fixtures.ts"))};const fixtures=await import(path);mock.module(path,()=>({...fixtures,createTestProject:()=>{writeFileSync(${JSON.stringify(marker)},'called');throw new Error('scratch called');}}));const {createRegistration}=await import(${JSON.stringify(join(REPO_ROOT, "tests/harness/kiro-crew-live.ts"))});createRegistration();`);
  for (const backend of ["codex", "kas", "", "CLAUDE", "other"]) {
    const result = spawnSync(process.execPath, [script], { cwd: root, env: { PATH: process.env.PATH, AIDLC_KIRO_CREW_LIVE: "1", AIDLC_KIRO_CREW_BACKEND: backend }, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("backend must be kiro or claude"); expect(existsSync(marker)).toBe(false);
  }
  for (const env of [{ AIDLC_KIRO_CREW_LIVE: "0" }, { AIDLC_KIRO_CREW_LIVE: "1", AIDLC_NO_LLM: "1" }]) {
    const result = spawnSync(process.execPath, [script], { cwd: root, env: { PATH: process.env.PATH, AIDLC_KIRO_CREW_BACKEND: "claude", ...env }, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("explicit live opt-in"); expect(existsSync(marker)).toBe(false);
  }
});

test("both channels expose the Codex stop through registered conductor, delegation and protocol resources", () => {
  for (const channel of ["dist", "dist-release"]) {
    const project = join(REPO_ROOT, channel, "kiro-crew"); const app = join(project, "kiro-crew-app");
    const manifest = JSON.parse(readFileSync(join(app, "skills.manifest.json"), "utf8")) as CrewSkillsManifest;
    const conductor = JSON.parse(readFileSync(join(app, "agents/aidlc.json"), "utf8")) as Agent;
    const paths = [manifest.conductor, manifest.delegation].map((uri) => {
      expect(conductor.resources).toContain(uri); return uri.replace(/^\w+:\/\//, "");
    });
    const actionablePaths = [...paths, ".kiro-crew/AGENTS.md"];
    paths.push(".kiro-crew/AGENTS.md", ...["construction", "ensemble", "reviewer", "swarm"].map((name) => `.kiro-crew/aidlc-common/protocols/stage-protocol-${name}.md`));
    for (const path of paths) {
      const content = readFileSync(join(project, path), "utf8");
      const stop = content.split("\n").find((line) => line.includes("Codex") && line.includes("#codex-backend"));
      expect(stop, path).toBeDefined(); expect(stop).toMatch(/\bstop\b/i); expect(stop).toContain("intercept Codex tool permissions or identify the calling conversation");
      expect(stop).toMatch(/(?:Do not dispatch, create artifacts|Stop without dispatch, artifact creation)/);
      expect(stop).toContain("transport"); expect(stop).toContain("workaround");
      if (actionablePaths.includes(path)) {
        expect(stop).toContain("Codex is not supported as a Kiro Crew backend");
        expect(stop).toContain("Choose Kiro CLI or Claude Code with its documented limits in Crew, then rerun setup and doctor.");
        expect(stop).toContain("Version changes do not bypass this refusal.");
        expect(stop).toContain("The native Codex CLI harness is unaffected.");
      }
    }
    // Resolve real projected resources and validate the owning App Kit rather
    // than pinning source prose or a digest of a historical protocol prefix.
    expect(validateAppKit(files(app), project)).toEqual([]);
  }
});

test("both channels register the progress page and routes with byte-derived inventory and a narrow API grant", () => {
  for (const channel of ["dist", "dist-release"]) {
    const project = join(REPO_ROOT, channel, "kiro-crew"); const app = join(project, "kiro-crew-app");
    const manifest = JSON.parse(readFileSync(join(app, "app.json"), "utf8"));
    expect(manifest.ui).toEqual({ entry: "index.mjs", pages: [{ route: "/apps/aidlc", label: "AI-DLC", icon: "Activity" }] });
    expect(manifest.backend).toEqual({ hooks: { routes: "backend.routes:register_routes" } });
    expect(manifest.permissions).toEqual({ api: ["/api/apps/aidlc"] }); expect(manifest.minKiroCrewVersion).toBe("0.7.1");
    expect(manifest.contributes.panelTabs).toHaveLength(1);
    expect(manifest.contributes.panelTabs[0]).toMatchObject({ id: "progress", entry: "panel.mjs", icon: "Activity" });
    const inventory = JSON.parse(readFileSync(join(app, "app-inventory.json"), "utf8")) as AppInventory;
    expect(inventory.files.filter(({ path }) => /^(ui|backend)\//.test(path)).map(({ path }) => path).sort()).toEqual(["backend/routes.py", "ui/index.mjs", "ui/panel.mjs"]);
    for (const path of ["ui/index.mjs", "backend/routes.py", "ui/panel.mjs"]) {
      const actual = readFileSync(join(app, path)); const source = readFileSync(join(REPO_ROOT, "harness/kiro-crew/app", path), "utf8").replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
      expect(actual.toString()).toBe(source); expect(inventory.files.find((file) => file.path === path)?.sha256).toBe(sha(actual));
    }
    expect(validateAppKit(files(app), project)).toEqual([]);
  }
});

test("page, route and SDK grant validation refuses absent, escaping and overbroad registrations", () => {
  const source = files(join(runtime, "kiro-crew-app"));
  for (const [patch, error] of [
    [{ ui: {} }, /ui.entry/], [{ ui: { entry: "../app.json" } }, /ui.entry/], [{ ui: { entry: "absent.mjs" } }, /ui.entry/],
    [{ ui: { entry: "index.mjs", pages: [] } }, /expected one/],
    [{ ui: { entry: "index.mjs", pages: [{ route: "/apps/other", label: "Other", icon: "Activity" }] } }, /expected one/],
    [{ backend: { hooks: { routes: "other:register_routes" } } }, /backend.hooks.routes/],
    [{ permissions: { api: ["/api"] } }, /own-namespace/], [{ permissions: { api: ["/api/apps/aidlc", "/api/other"] } }, /own-namespace/],
    [{ permissions: { api: ["/api/apps/aidlc"], extra: true } }, /own-namespace/],
  ] as [Record<string, unknown>, RegExp][]) {
    const changed = structuredClone(source); changeJson(changed, "app.json", (value) => Object.assign(value, patch));
    expect(validateAppKit(changed, runtime).join("\n")).toMatch(error);
  }
  for (const path of ["ui/index.mjs", "backend/routes.py"]) expect(validateAppKit(source.filter((file) => file.path !== path), runtime).join("\n")).toMatch(/emitted/);
});

test("missing progress assets stop collection before replacing a previously emitted App Kit", () => {
  for (const path of ["ui/index.mjs", "backend/routes.py", "ui/panel.mjs"]) {
    const ctx = fixture(); const app = join(ctx.distRoot, "kiro-crew-app"); const before = files(app);
    rmSync(join(ctx.harnessRoot, "app", path));
    expect(() => emit(ctx)).toThrow(); expect(files(app)).toEqual(before);
    expect(readFileSync(join(ctx.distRoot, ".kiro-crew/tools/aidlc.ts"), "utf8")).toBe(readFileSync(join(runtime, ".kiro-crew/tools/aidlc.ts"), "utf8"));
  }
});

type PanelManifest = { minKiroCrewVersion?: unknown; contributes: { panelTabs: Record<string, unknown>[] }; permissions: Record<string, unknown> } & Record<string, unknown>;
function panelErrors(change: (app: PanelManifest) => void, raw = (text: string) => text, path = "app.json") {
  const snapshot = files(join(runtime, "kiro-crew-app"));
  const entry = snapshot.find((file) => file.path === path)!;
  const app = JSON.parse(entry.content) as PanelManifest; change(app); entry.content = raw(JSON.stringify(app));
  // Rebuild with the production collector so schema refusal cannot be explained
  // by incidental inventory drift. No frozen digests or local validator model.
  snapshot.find((file) => file.path === "app-inventory.json")!.content = `${JSON.stringify(buildAppInventory(snapshot), null, 2)}\n`;
  const errors = validateAppKit(snapshot, runtime);
  expect(errors.join("\n")).not.toContain("ownership/mode/hash mismatch");
  return errors;
}

test("panel labels admit exactly 120 UTF-16 units and refuse blank, missing and oversized values", () => {
  for (const field of ["title", "menuLabel", "menuDescription"]) {
    for (const value of ["x".repeat(120), "😀".repeat(60)]) {
      expect(panelErrors((app) => { app.contributes.panelTabs[0][field] = value; })).toEqual([]);
    }
    for (const value of [undefined, null, 42, "", " \n", "x".repeat(121), `${"😀".repeat(60)}x`, "😀".repeat(61)]) {
      expect(panelErrors((app) => { app.contributes.panelTabs[0][field] = value; }).join("\n"), `${field}: ${value}`)
        .toContain(`${field} must be non-empty and at most 120 UTF-16 units`);
    }
  }
});

test("panel schema allows only one progress tab, its optional icon and the exact host floor", () => {
  for (const contributes of [undefined, null, [], {}, { panelTabs: null }, { panelTabs: [] }, { panelTabs: [null] }, { panelTabs: [{}, {}] }]) {
    expect(panelErrors((app) => { Object.assign(app, { contributes }); }).join("\n")).toContain("exactly one tab object");
  }
  for (const id of [undefined, "", "other", "Progress", "1progress", "progress/", "progress\n", "a".repeat(65)]) {
    expect(panelErrors((app) => { app.contributes.panelTabs[0].id = id; }).join("\n")).toContain("id must be progress");
  }
  for (const field of ["sessionControls", "commands", "fileMenuItems", "unknown"]) {
    expect(panelErrors((app) => { Object.assign(app.contributes, { [field]: [] }); }).join("\n")).toContain("contributes must contain only panelTabs");
  }
  expect(panelErrors((app) => { app.contributes.panelTabs[0].unknown = true; }).join("\n")).toContain("unknown tab field unknown");
  for (const icon of [null, 1, "", " "]) expect(panelErrors((app) => { app.contributes.panelTabs[0].icon = icon; }).join("\n")).toContain("icon must be a non-empty");
  expect(panelErrors((app) => { delete app.contributes.panelTabs[0].icon; })).toEqual([]);
  for (const version of [undefined, "0.6.0", "0.7.0", "0.7.2", "1.0.0", "0.7.1-beta", "invalid", 0.71]) {
    expect(panelErrors((app) => { app.minKiroCrewVersion = version; }).join("\n")).toContain("minKiroCrewVersion must be 0.7.1");
  }
});

test("panel entries must resolve within emitted UI assets without traversal, encoding or a redundant prefix", () => {
  for (const entry of [undefined, "", "ui/panel.mjs", "missing.mjs", "/panel.mjs", "../panel.mjs", "a/../../panel.mjs",
    "./panel.mjs", "a//panel.mjs", "..\\panel.mjs", "%2e%2e/panel.mjs", "https://example.invalid/panel.mjs", "panel.mjs\0"]) {
    expect(panelErrors((app) => { app.contributes.panelTabs[0].entry = entry; }).join("\n")).toContain("entry must resolve");
  }
  expect(panelErrors((app) => { app.contributes.panelTabs[0].entry = "panel.mjs"; })).toEqual([]);
  const source = files(join(runtime, "kiro-crew-app")).filter(({ path }) => path !== "ui/panel.mjs");
  expect(validateAppKit(source, runtime).join("\n")).toContain("entry must resolve");
});

test("raw JSON validation rejects duplicate decoded keys and approval keys at every JSON site but not literal text", () => {
  const unchanged = () => {};
  for (const raw of [
    (text: string) => text.replace("{", '{"contributes":{},'),
    (text: string) => text.replace("{", '{"contrib\\u0075tes":{},'),
    (text: string) => text.replace('"id":"progress"', '"id":"other","id":"progress"'),
  ]) expect(panelErrors(unchanged, raw).join("\n")).toContain("duplicate JSON key");
  for (const value of [true, false, null, [], {}]) {
    for (const site of ["root", "permissions", "contributes", "tab", "array"]) {
      expect(panelErrors((app) => {
        const target = site === "permissions" ? app.permissions : site === "contributes" ? app.contributes
          : site === "tab" ? app.contributes.panelTabs[0] : app;
        Object.assign(target, site === "array" ? { extra: [{ sessionApproval: value }] } : { sessionApproval: value });
      }).join("\n")).toContain("forbidden sessionApproval");
    }
  }
  for (const { path } of files(join(runtime, "kiro-crew-app")).filter(({ path }) => path.endsWith(".json") && path !== "app-inventory.json")) {
    expect(panelErrors(unchanged, (text) => text.replace("{", '{"overwritten":{"session\\u0041pproval":false},"overwritten":{},'), path).join("\n"))
      .toContain(`${path}: forbidden sessionApproval`);
  }
  expect(panelErrors((app) => { app.description = 'Literal "sessionApproval": true and "contributes": {} are not keys.'; })).toEqual([]);
});

test("panel and raw-key violations abort real emission before replacing the app or project engine", () => {
  const ctx = fixture(); const app = join(ctx.distRoot, "kiro-crew-app"); const before = files(app);
  const engine = readFileSync(join(ctx.distRoot, ".kiro-crew/tools/aidlc.ts"));
  for (const [prefix, expected] of [
    ['"contributes":{},', "duplicate JSON key contributes"],
    ['"permissions":{"session\\u0041pproval":true},', "forbidden sessionApproval"],
    ['"extra":[{"sessionApproval":false}],', "forbidden sessionApproval"],
  ]) {
    const script = join(ctx.repoRoot, "invalid-app.ts");
    writeFileSync(script, `import {mock} from 'bun:test';
const path=${JSON.stringify(join(REPO_ROOT, "harness/kiro-crew/emit/app-validator.ts"))};const real=await import(path);const build=real.buildAppInventory;
mock.module(path,()=>({...real,buildAppInventory:entries=>{const app=entries.find(e=>e.path==='app.json');app.content=app.content.replace('{','{'+${JSON.stringify(prefix)});return build(entries);}}));
const {default:emit}=await import(${JSON.stringify(join(REPO_ROOT, "harness/kiro-crew/emit.ts"))});emit({...${JSON.stringify(ctx)},substituteToken:text=>text.replaceAll('{{HARNESS_DIR}}','.kiro-crew').replaceAll('{{TOOL_PREFIX}}','bun .kiro-crew/tools/')});`);
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stderr).toContain(expected);
    expect(files(app)).toEqual(before); expect(readFileSync(join(ctx.distRoot, ".kiro-crew/tools/aidlc.ts"))).toEqual(engine);
  }
});
