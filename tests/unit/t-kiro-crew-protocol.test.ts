// covers: subcommand:aidlc-graph:validate-grid, subcommand:aidlc-log:review,
// subcommand:aidlc-log:link, subcommand:aidlc-state:unit
import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { appendAuditEntry } from "../../core/tools/aidlc-audit.ts";
import { auditBlockField, currentPipelineLinkReceipts, readAuditShardEvents, reviewRecordDigest, sessionPidMapDir, unitCompletedReceipts, writeSessionBinding } from "../../dist/kiro-crew/.kiro-crew/tools/aidlc-lib.ts";
import { sessionHash } from "../../harness/kiro-crew/setup/aidlc-kiro-crew-setup.ts";
import type { RunStageDirective } from "../../core/tools/aidlc-directive.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT, runOrchestrateNext, seedBoltDag, seededRecordDir, seededStateFile, seedStateFile, withEnvAndFreshCaches } from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) cleanupTestProject(project); });
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
function fixture() {
  const project = createTestProject(); projects.push(project);
  for (const name of [".kiro-crew", "aidlc"]) cpSync(join(REPO_ROOT, "dist/kiro-crew", name), join(project, name), { recursive: true });
  seedStateFile(project, "state-mid-inception.md");
  const session = "crew-protocol";
  // These cases isolate receipt correlation from the separately exercised human
  // approval path; keep the reviewer gate and ensemble evidence enabled.
  const env = { ...testGuardEnvironment(process.env, "production"), AIDLC_PROJECT_DIR: project, AIDLC_HARNESS_DIR: ".kiro-crew", AIDLC_HARNESS_NAME: "kiro-crew", AIDLC_SESSION_OVERRIDE: session, AIDLC_SESSION_OVERRIDE_SOURCE: undefined, AIDLC_COMPILED_EXECUTABLE: undefined, CLAUDE_PROJECT_DIR: undefined, AWS_AIDLC_DEFAULT_SCOPE: undefined,
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_ARTIFACT_GUARD: "1" };
  const tools = join(project, ".kiro-crew/tools"); const record = seededRecordDir(project);
  const run = (tool: string, args: string[]) => spawnSync(process.execPath, [join(tools, `aidlc-${tool}.ts`), ...args, "--project-dir", project], { cwd: project, env, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  const ok = (tool: string, args: string[]) => { const result = run(tool, args); expect(result.status, result.stdout + result.stderr).toBe(0); return result.stdout; };
  const rows = (event: string) => withEnvAndFreshCaches(env, () => readAuditShardEvents(project).filter((row) => row.event === event));
  const dispatch = (stage: string, role: string) => {
    const intended = JSON.parse(ok("crew-dispatch", ["intend", "--wave", stage, "--stage", stage, "--task", "work", "--role", role]));
    ok("crew-dispatch", ["confirm", "--intent", intended.intentId, "--child", "first"]);
    return () => ok("crew-dispatch", ["settle", "--child", "first", "--outcome", "completed"]);
  };
  return { project, session, record, tools, env, run, ok, rows, dispatch };
}
type Fixture = ReturnType<typeof fixture>;
function review(f: Fixture, stage = "requirements-analysis", unit?: string) {
  const reviewer = stage === "requirements-analysis" ? "aidlc-product-lead-agent" : "aidlc-architecture-reviewer-agent";
  const args = ["review", "--stage", stage, "--reviewer", reviewer, "--iteration", "1", ...(unit ? ["--unit", unit] : [])];
  const request = JSON.parse(f.ok("log", args)) as { requestId: string; reviewFile: string };
  const finish = (verdict = "READY", prior = "", added = "") => {
    write(join(f.project, request.reviewFile), `**Verdict:** ${verdict}\n**Reviewer:** ${reviewer}\n**Iteration:** 1\n\n### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n${prior}\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n${added}\n`);
    return f.run("log", [...args, "--verdict", verdict]);
  };
  return { ...request, args, finish };
}
function requirements(f: Fixture) {
  const dir = join(f.record, "inception/requirements-analysis");
  write(join(dir, "requirements.md"), "# Requirements\n\nThe greeting must be configurable.\n");
  write(join(dir, "requirements-analysis-questions.md"), "# Questions\n");
  return join(dir, "requirements.md");
}

test("grid validation accepts shipped scope input and rejects unknown or contradictory stage choices", () => {
  const f = fixture(); const scopes = JSON.parse(readFileSync(join(f.tools, "data/scope-grid.json"), "utf8")) as Record<string, { stages: Record<string, string> }>;
  const proposal = join(f.project, "proposal.json");
  writeFileSync(proposal, JSON.stringify({ stages: scopes.bugfix.stages }));
  const valid = JSON.parse(f.ok("graph", ["validate-grid", "--proposal", proposal, "--project-type", "greenfield"]));
  expect(valid.valid).toBe(true); expect(valid.nearest_stock.some(({ scope, diff }: { scope: string; diff: number }) => scope === "bugfix" && diff === 0)).toBe(true);
  const before = readFileSync(seededStateFile(f.project));
  for (const stages of [{ nonexistent: "EXECUTE" }, { ...scopes.feature.stages, "requirements-analysis": "invalid" }]) {
    writeFileSync(proposal, JSON.stringify({ stages }));
    const result = f.run("graph", ["validate-grid", "--proposal", proposal, "--strict"]);
    expect(JSON.parse(result.stdout).valid).toBe(false); expect(readFileSync(seededStateFile(f.project))).toEqual(before);
  }
});

test("composer transport completion neither approves a proposal nor changes the active workflow", () => {
  const f = fixture(); const before = readFileSync(seededStateFile(f.project));
  const complete = f.dispatch("compose", "aidlc-crew-composer-agent"); complete();
  const proposal = join(f.project, "invalid-proposal.json"); writeFileSync(proposal, JSON.stringify({ stages: { nonexistent: "EXECUTE" } }));
  const result = f.run("graph", ["validate-grid", "--proposal", proposal, "--strict"]); expect(JSON.parse(result.stdout).valid).toBe(false);
  expect(f.rows("RECOMPOSED")).toEqual([]); expect(f.rows("QUESTION_ANSWERED")).toEqual([]);
  expect(readFileSync(seededStateFile(f.project))).toEqual(before);
  expect(JSON.parse(f.ok("crew-dispatch", ["list"])).releaseDependents).toBe(false);
});

test("review request and terminal receipt pair by identity and keep reviewed artifacts unchanged", () => {
  const f = fixture(); const artifact = requirements(f); const before = readFileSync(artifact);
  const r = review(f); const complete = f.dispatch("requirements-analysis", "aidlc-crew-product-lead-agent"); complete();
  expect(f.rows("REVIEW_COMPLETED")).toEqual([]); expect(f.run("state", ["gate-start", "requirements-analysis"]).status).not.toBe(0);
  const finished = r.finish(); expect(finished.status, finished.stdout + finished.stderr).toBe(0);
  const completed = JSON.parse(finished.stdout); const requested = f.rows("REVIEW_REQUESTED").at(-1)!; const row = f.rows("REVIEW_COMPLETED").at(-1)!;
  expect(auditBlockField(requested.block, "Request Id")).toBe(r.requestId); expect(auditBlockField(row.block, "Request Id")).toBe(r.requestId);
  expect(auditBlockField(row.block, "Request Fingerprint")).toBe(auditBlockField(requested.block, "Artifact Fingerprint"));
  expect(auditBlockField(row.block, "Review Record Digest")).toBe(reviewRecordDigest(readFileSync(join(f.record, completed.reviewRecord))));
  expect(readFileSync(artifact)).toEqual(before); expect(f.run("state", ["gate-start", "requirements-analysis"]).status).toBe(0);
});

test("review rework creates a new paired receipt while retaining the transport conversation", () => {
  const f = fixture(); const artifact = requirements(f); const first = review(f);
  f.dispatch("requirements-analysis", "aidlc-crew-product-lead-agent")();
  const firstResult = first.finish(); expect(firstResult.status, firstResult.stderr).toBe(0);
  const recordPath = join(f.record, JSON.parse(firstResult.stdout).reviewRecord); const bytes = readFileSync(recordPath);
  f.ok("state", ["gate-start", "requirements-analysis"]); f.ok("state", ["reject", "requirements-analysis", "--feedback", "Specify the default greeting"]);
  writeFileSync(artifact, "# Requirements\n\nDefault greeting is hello.\n");
  const context = f.run("review-brief", ["context", "--stage", "requirements-analysis"]); expect(context.status, context.stderr).toBe(0);
  const second = review(f); expect(second.requestId).not.toBe(first.requestId);
  const continued = JSON.parse(f.ok("crew-dispatch", ["continue", "--child", "first", "--run", "second"])); expect(continued.conversationId).toBe("first");
  f.ok("crew-dispatch", ["settle", "--child", "second", "--outcome", "completed"]);
  const secondResult = second.finish(); expect(secondResult.status, secondResult.stderr).toBe(0);
  expect(f.rows("REVIEW_REQUESTED")).toHaveLength(2); expect(f.rows("REVIEW_COMPLETED")).toHaveLength(2);
  expect(readFileSync(recordPath)).toEqual(bytes); expect(JSON.parse(secondResult.stdout).reviewRecord).not.toBe(JSON.parse(firstResult.stdout).reviewRecord);
});

test("pipeline completion requires ordered engine link receipts, not host settlement", () => {
  const f = fixture(); seedStateFile(f.project, "state-brownfield-init-done.md");
  const stage = "reverse-engineering";
  withEnvAndFreshCaches({ ...f.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" }, () => appendAuditEntry("STAGE_STARTED", { Stage: stage, Agent: "aidlc-developer-agent" }, f.project));
  const receipts = () => withEnvAndFreshCaches(f.env, () => currentPipelineLinkReceipts(f.project, stage).map(({ link }) => link));
  f.dispatch(stage, "aidlc-crew-developer-agent")(); expect(receipts()).toEqual([]);
  const artifact = join(f.record, "inception/reverse-engineering/developer-scan.md");
  write(artifact, "## Developer Code Scan Results\n\n### Scan Coverage\n\n- src/\n\n## Handoff Summary\n\nGreeting implementation.\n");
  expect(f.ok("log", ["link", "--stage", stage, "--link", "aidlc-developer-agent", "--artifact", relative(f.project, artifact)])).toContain("PIPELINE_LINK_COMPLETED");
  expect(receipts()).toEqual(["aidlc-developer-agent"]);
  f.ok("log", ["link", "--stage", stage, "--link", "aidlc-architect-agent"]); expect(receipts()).toEqual(["aidlc-developer-agent", "aidlc-architect-agent"]);
});

test("collaborator readiness waits for every contribution and is read-only", () => {
  const f = fixture(); seedStateFile(f.project, "state-brownfield-init-done.md");
  const stage = "user-stories";
  const wait = () => JSON.parse(f.ok("orchestrate", ["wait", "--stage", stage, "--for", "collaborators", "--timeout", "0.01"]));
  const roles = ["aidlc-design-agent", "aidlc-developer-agent", "aidlc-quality-agent"];
  for (const [index, role] of roles.entries()) {
    write(join(f.record, "inception", stage, "contributions", `${role}.md`), `**Collaborator:** ${role}\n\n## Contribution\nReview greeting.\n\n## Positions\nNone\n`);
    const state = readFileSync(seededStateFile(f.project)); const before = f.rows("PIPELINE_LINK_COMPLETED");
    expect(wait().status).toBe(index === roles.length - 1 ? "settled" : "waiting");
    expect(readFileSync(seededStateFile(f.project))).toEqual(state); expect(f.rows("PIPELINE_LINK_COMPLETED")).toEqual(before);
  }
});

function waveFixture() {
  const f = fixture(); f.env.AIDLC_SKIP_ARTIFACT_GUARD = "0";
  writeFileSync(seededStateFile(f.project), `# AI-DLC State Tracking\n\n## Project Information\n- **Project**: Greeting\n- **Project Type**: Greenfield\n- **Scope**: feature\n- **State Version**: 8\n- **Skeleton Stance**: on\n- **Construction Iteration**: stage-major\n\n## Scope Configuration\n- **Stages to Execute**: all\n- **Stages to Skip**: none\n- **Depth**: Standard\n- **Test Strategy**: Standard\n- **Guard Policy**: strict (set by you)\n\n## Stage Progress\n\n### INCEPTION PHASE\n- [x] domain-design — EXECUTE\n- [x] units-generation — EXECUTE\n\n### CONSTRUCTION PHASE\n- [-] functional-design — EXECUTE\n- [ ] nfr-requirements — EXECUTE\n- [ ] nfr-design — EXECUTE\n- [ ] infrastructure-design — EXECUTE\n- [ ] code-generation — EXECUTE\n- [ ] build-and-test — EXECUTE\n\n## Current Status\n- **Lifecycle Phase**: CONSTRUCTION\n- **Current Stage**: functional-design\n- **Status**: Running\n`);
  seedBoltDag(f.project, ["alpha", "beta", { name: "dependent", depends_on: ["alpha", "beta"] }], [["alpha", "beta"], ["dependent"]]);
  write(join(f.record, "inception/units-generation/unit-of-work-dependency.md"), "# Unit Dependency\n\n```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n  - name: dependent\n    depends_on: [alpha, beta]\n```\n");
  const next = () => { const result = runOrchestrateNext(join(f.tools, "aidlc-orchestrate.ts"), f.project, [], { cwd: f.project, env: f.env }); expect(result.status, result.out).toBe(0); return result.directive as unknown as RunStageDirective; };
  const complete = (unit: string) => f.run("state", ["unit", "complete", "--wave", "--stage", "functional-design", "--unit", unit]);
  return { ...f, next, complete };
}

test("unit waves retain entry-local paths and reject completion with missing artifacts or review", () => {
  const f = waveFixture(); const directive = f.next();
  expect(directive.wave?.entries.map(({ unit }) => unit)).toEqual(["alpha", "beta"]);
  for (const entry of directive.wave!.entries) {
    expect(entry.required_produces.length).toBeGreaterThan(0);
    expect(entry.required_produces.every((path) => path.includes(`/construction/${entry.unit}/`))).toBe(true);
    expect(f.complete(entry.unit).status).not.toBe(0);
  }
  expect(withEnvAndFreshCaches(f.env, () => unitCompletedReceipts(f.project, directive.stage).size)).toBe(0);
  expect(f.next().wave?.entries.map(({ unit }) => unit)).toEqual(["alpha", "beta"]);
});

test("paired per-unit reviews and explicit unit receipts release only the dependent wave", () => {
  const f = waveFixture(); const first = f.next();
  for (const entry of first.wave!.entries) for (const path of entry.required_produces) write(join(f.project, path), `# ${entry.unit} design\n\nGreeting implementation.\n`);
  for (const unit of ["alpha", "beta"]) {
    const directive = f.next(); const entry = directive.wave!.entries.find((entry) => entry.unit === unit)!;
    expect(entry.review_state).toBe("outstanding"); expect(f.complete(unit).status).not.toBe(0);
    const requested = review(f, directive.stage, unit); const finished = requested.finish(); expect(finished.status, finished.stdout + finished.stderr).toBe(0);
    expect(withEnvAndFreshCaches(f.env, () => unitCompletedReceipts(f.project, directive.stage).has(unit))).toBe(false);
    const completed = f.complete(unit); expect(completed.status, completed.stdout + completed.stderr).toBe(0); expect(completed.stdout).toContain("UNIT_COMPLETED");
    if (unit === "alpha") expect(f.next().wave?.entries.map(({ unit }) => unit)).toEqual(["beta"]);
  }
  expect(f.next().wave?.entries.map(({ unit }) => unit)).toEqual(["dependent"]);
  expect(f.rows("UNIT_COMPLETED")).toHaveLength(2);
  expect(existsSync(join(f.record, "construction/dependent/functional-design/functional-spec.md"))).toBe(false);
});

/** Crew's gateway, not the conductor, owns child processes. Publish input only
 * after the intermediate launcher exits: detached alone still has the worker in
 * its ancestry. The detached host waits for that input before any bridge/engine
 * call. Missing launch/result fails within the operation budget, with no direct
 * spawn fallback or session-guard bypass; unfinished process groups are killed. */
function detachedBridgeCall(bridge: string, home: string, cwd: string, env: NodeJS.ProcessEnv, input: string): ReturnType<Fixture["run"]> {
  const dir = mkdtempSync(join(home, "bridge-call-")); const request = join(dir, "request"); const response = join(dir, "response");
  const timeout = remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)!; const deadline = Date.now() + timeout;
  const host = `
    import { spawnSync } from "node:child_process";
    import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
    const request = ${JSON.stringify(request)}, response = ${JSON.stringify(response)}, deadline = ${deadline};
    while (!existsSync(request)) { if (Date.now() >= deadline) process.exit(1); Bun.sleepSync(10); }
    const result = spawnSync(process.execPath, ${JSON.stringify([bridge, "mcp", "--crew-home", home])}, {
      encoding: "utf8", input: readFileSync(request, "utf8"), timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL",
    });
    writeFileSync(response + ".tmp", JSON.stringify(result)); renameSync(response + ".tmp", response);
  `;
  const launcher = spawnSync(process.execPath, ["-e", `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(host)}], { detached: true, stdio: "ignore" });
    child.on("error", (error) => { throw error; }); child.unref(); console.log(child.pid);
  `], { cwd, env, encoding: "utf8", timeout });
  const pid = Number(launcher.stdout.trim());
  let finished = false;
  try {
    expect(launcher.status, launcher.stderr).toBe(0);
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    writeFileSync(`${request}.tmp`, input); // Request publication is the launch-exit barrier.
    // The host must not read a partially written JSON-RPC request.
    renameSync(`${request}.tmp`, request);
    while (!existsSync(response) && Date.now() < deadline) Bun.sleepSync(10);
    expect(existsSync(response), "Detached bridge did not return within its operation budget").toBe(true);
    const result: ReturnType<Fixture["run"]> = JSON.parse(readFileSync(response, "utf8"));
    finished = result.status !== null;
    return result;
  } finally {
    if (!finished && Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error("Detached bridge cleanup failed:", error); }
    }
  }
}

function claudeChild(f: Fixture, role: string): Fixture & { home: string } {
  const home = createTestProject(); projects.push(home); const cwd = join(f.project, `child-${role}`); mkdirSync(cwd, { recursive: true });
  const key = `subagent:${role}`; const session = `crew-${sessionHash(key)}`;
  write(join(home, "config.json"), JSON.stringify({ agent: { acp_backend: "claude", member_acp_backend: "claude", subagent_cwd_allowed_roots: [f.project] } }));
  write(join(home, "session_map.json"), JSON.stringify({ [key]: { provider: "claude_code", cwd }, "dashboard:protocol": { provider: "claude_code", cwd: f.project } }));
  const env = { ...f.env, HOME: home, KIROCREW_HOME: home, KIROCREW_SESSION_KEY: key, AIDLC_SESSION_OVERRIDE: undefined };
  const bridge = join(REPO_ROOT, "dist/kiro-crew/kiro-crew-app/mcp/aidlc-mcp-bridge.ts");
  const call = (name: string, args: unknown) => {
    const result = detachedBridgeCall(bridge, home, cwd, env, `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`);
    expect(result.status, result.stderr).toBe(0);
    const response = JSON.parse(result.stdout); expect(response.error).toBeUndefined();
    return { ...result, status: response.result.isError ? 1 : 0, stdout: response.result.content[0].text as string };
  };
  const bound = call("aidlc_bind_session", { project_dir: f.project }); expect(bound.status, bound.stdout).toBe(0);
  expect(JSON.parse(bound.stdout)).toMatchObject({ backend: "claude", source: "project-dir", keyHash: sessionHash(key) });
  expect(existsSync(join(sessionPidMapDir(f.project), String(process.pid)))).toBe(false);
  writeSessionBinding(f.project, session, "default", basename(f.record));
  const run: Fixture["run"] = (tool, args) => call("aidlc_engine", { args: ["engine", tool, ...args] });
  const ok: Fixture["ok"] = (tool, args) => { const result = run(tool, args); expect(result.status, result.stdout + result.stderr).toBe(0); return result.stdout; };
  return { ...f, home, session, run, ok };
}

test("Claude composer grids are validated through the child bind before human approval can be recorded", () => {
  const f = fixture(); const parent = "dashboard:protocol"; f.session = `crew-${sessionHash(parent)}`; f.env.AIDLC_SESSION_OVERRIDE = f.session;
  f.env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "0"; writeSessionBinding(f.project, f.session, "default", basename(f.record));
  const child = claudeChild(f, "composer"); const proposal = join(f.project, "proposal.json"); const before = readFileSync(seededStateFile(f.project));
  writeFileSync(proposal, JSON.stringify({ stages: { nonexistent: "EXECUTE" } }));
  const invalid = child.run("graph", ["validate-grid", "--proposal", proposal, "--strict"]); expect(JSON.parse(invalid.stdout).valid).toBe(false);
  const scopes = JSON.parse(readFileSync(join(f.tools, "data/scope-grid.json"), "utf8")); writeFileSync(proposal, JSON.stringify({ stages: scopes.bugfix.stages }));
  expect(JSON.parse(child.ok("graph", ["validate-grid", "--proposal", proposal, "--project-type", "greenfield"])).valid).toBe(true);
  const settle = f.dispatch("compose", "aidlc-crew-composer-agent"); settle();
  f.ok("log", ["decision", "--stage", "requirements-analysis", "--decision", "Accept this proposed grid?", "--options", "Approve,Reject"]);
  const answer = () => f.run("log", ["answer", "--stage", "requirements-analysis", "--details", "Approve"]);
  const prompt = (text: string) => spawnSync(process.execPath, [join(f.project, ".kiro-crew/hooks/aidlc-kiro-crew-adapter.ts"), "UserPromptSubmit"], { cwd: f.project, env: { ...f.env, AIDLC_CREW_BACKEND: "claude", HOME: child.home, KIROCREW_HOME: child.home }, encoding: "utf8", input: JSON.stringify({ hook_event_name: "UserPromptSubmit", parent_session_key: parent, prompt: text }), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(prompt("[Subagent completion event] Approve").status).toBe(0); expect(answer().status).not.toBe(0); expect(f.rows("QUESTION_ANSWERED")).toEqual([]);
  expect(prompt("Approve").status).toBe(0); const approved = answer(); expect(approved.status, approved.stdout + approved.stderr).toBe(0);
  expect(f.rows("QUESTION_ANSWERED")).toHaveLength(1); expect(f.rows("RECOMPOSED")).toEqual([]); expect(readFileSync(seededStateFile(f.project))).toEqual(before);
});

test("Claude reviewer completion and rework pair new engine requests without treating child settlement as approval", () => {
  const f = fixture(); const artifact = requirements(f); const child = claudeChild(f, "product-lead");
  const first = review(child); f.dispatch("requirements-analysis", "aidlc-crew-product-lead-agent")();
  expect(f.rows("REVIEW_COMPLETED")).toEqual([]); expect(f.run("state", ["gate-start", "requirements-analysis"]).status).not.toBe(0);
  const result = first.finish(); expect(result.status, result.stdout).toBe(0); const saved = join(f.record, JSON.parse(result.stdout).reviewRecord); const bytes = readFileSync(saved);
  f.ok("state", ["gate-start", "requirements-analysis"]); f.ok("state", ["reject", "requirements-analysis", "--feedback", "Specify the default greeting"]);
  writeFileSync(artifact, "# Requirements\n\nDefault greeting is hello.\n");
  const context = child.ok("review-brief", ["context", "--stage", "requirements-analysis"]); expect(context).toContain("requirements.md");
  const second = review(child); expect(second.requestId).not.toBe(first.requestId);
  const continued = JSON.parse(f.ok("crew-dispatch", ["continue", "--child", "first", "--run", "rework"])); expect(continued.conversationId).toBe("first");
  f.ok("crew-dispatch", ["settle", "--child", "rework", "--outcome", "completed"]); expect(f.rows("REVIEW_COMPLETED")).toHaveLength(1);
  const finished = second.finish(); expect(finished.status, finished.stdout).toBe(0);
  expect(f.rows("REVIEW_COMPLETED").map(({ block }) => auditBlockField(block, "Request Id"))).toEqual([first.requestId, second.requestId]);
  expect(readFileSync(saved)).toEqual(bytes); expect(JSON.parse(finished.stdout).reviewRecord).not.toBe(JSON.parse(result.stdout).reviewRecord);
});

test("Claude child pipeline settlement cannot replace artifact-backed ordered link receipts", () => {
  const f = fixture(); seedStateFile(f.project, "state-brownfield-init-done.md"); const child = claudeChild(f, "developer"); const stage = "reverse-engineering";
  withEnvAndFreshCaches({ ...f.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" }, () => appendAuditEntry("STAGE_STARTED", { Stage: stage, Agent: "aidlc-developer-agent" }, f.project));
  const receipts = () => withEnvAndFreshCaches(f.env, () => currentPipelineLinkReceipts(f.project, stage).map(({ link }) => link));
  f.dispatch(stage, "aidlc-crew-developer-agent")(); expect(receipts()).toEqual([]);
  const artifact = join(f.record, "inception/reverse-engineering/developer-scan.md");
  expect(child.run("log", ["link", "--stage", stage, "--link", "aidlc-developer-agent", "--artifact", relative(f.project, artifact)]).status).not.toBe(0); expect(receipts()).toEqual([]);
  write(artifact, "## Developer Code Scan Results\n\n### Scan Coverage\n\n- src/\n\n## Handoff Summary\n\nGreeting implementation.\n");
  child.ok("log", ["link", "--stage", stage, "--link", "aidlc-developer-agent", "--artifact", relative(f.project, artifact)]); expect(receipts()).toEqual(["aidlc-developer-agent"]);
  child.ok("log", ["link", "--stage", stage, "--link", "aidlc-architect-agent"]); expect(receipts()).toEqual(["aidlc-developer-agent", "aidlc-architect-agent"]);
});

test("Claude unit child writes only its paired receipt and cannot release an unfinished sibling", () => {
  const f = waveFixture(); const child = claudeChild(f, "architect"); const first = f.next();
  const alpha = first.wave!.entries.find(({ unit }) => unit === "alpha")!;
  const intended = JSON.parse(f.ok("crew-dispatch", ["intend", "--wave", "design", "--stage", first.stage, "--task", "alpha", "--role", "aidlc-crew-architect-agent"]));
  f.ok("crew-dispatch", ["confirm", "--intent", intended.intentId, "--child", "alpha-child"]);
  f.ok("crew-dispatch", ["settle", "--child", "alpha-child", "--outcome", "failed"]);
  expect(child.run("state", ["unit", "complete", "--wave", "--stage", first.stage, "--unit", "alpha"]).status).not.toBe(0);
  expect(f.next().wave!.entries.map(({ unit }) => unit)).toEqual(["alpha", "beta"]);
  for (const path of alpha.required_produces) write(join(f.project, path), "# Alpha design\n\nGreeting implementation.\n");
  const request = review(child, first.stage, "alpha"); const reviewed = request.finish(); expect(reviewed.status, reviewed.stdout).toBe(0);
  expect(withEnvAndFreshCaches(f.env, () => unitCompletedReceipts(f.project, first.stage).size)).toBe(0);
  expect(child.ok("state", ["unit", "complete", "--wave", "--stage", first.stage, "--unit", "alpha"])).toContain("UNIT_COMPLETED");
  expect(f.next().wave!.entries.map(({ unit }) => unit)).toEqual(["beta"]); expect(f.rows("UNIT_COMPLETED")).toHaveLength(1);
  expect(withEnvAndFreshCaches(f.env, () => [...unitCompletedReceipts(f.project, first.stage).keys()])).toEqual(["alpha"]);
});
