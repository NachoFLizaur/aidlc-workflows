// covers: tool:aidlc-crew-dispatch
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CrewDispatchLedger } from "../../core/tools/aidlc-crew-dispatch.ts";
import { runWithOwnerStampedLock } from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

const projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) cleanupTestProject(project); });
function fixture() {
  const project = createTestProject(); projects.push(project);
  const session = "crew-ledger-test";
  const path = join(project, "aidlc/.aidlc-sessions", `${session}.crew-dispatch.json`);
  const env = { ...process.env, AIDLC_PROJECT_DIR: project, AIDLC_SESSION_OVERRIDE: session,
    AIDLC_SESSION_OVERRIDE_SOURCE: undefined, AIDLC_COMPILED_EXECUTABLE: undefined,
    AIDLC_HARNESS_DIR: ".kiro-crew", AIDLC_HARNESS_NAME: "kiro-crew" };
  const tool = join(REPO_ROOT, "dist/kiro-crew/.kiro-crew/tools/aidlc.ts");
  const invoke = (args: string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [tool, "engine", "crew-dispatch", ...args], {
    cwd: project, env: { ...env, ...overrides }, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const ok = (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const result = invoke(args, overrides); expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const intend = (task = "draft", wave = "first") => String(ok(["intend", "--wave", wave, "--stage", "code-generation", "--task", task, "--role", "aidlc-crew-developer-agent"]).intentId);
  const ledger = () => JSON.parse(readFileSync(path, "utf8")) as CrewDispatchLedger;
  return { project, session, path, env, tool, invoke, ok, intend, ledger };
}

test("intend, confirm and settle persist transport state without releasing dependents", () => {
  const f = fixture(); const intent = f.intend();
  expect(f.ledger().intents[0].status).toBe("intended");
  expect(f.ledger().outstanding).toEqual([]);
  expect(f.ok(["confirm", "--intent", intent, "--child", "child-a"]).conversationId).toBe("child-a");
  expect(f.ledger().intents).toEqual([]);
  expect(f.ledger().outstanding[0]).toMatchObject({ childId: "child-a", runId: "child-a", task: "draft" });
  expect(Number.isFinite(Date.parse(f.ledger().outstanding[0].dispatchedAt))).toBe(true);
  f.ok(["settle", "--child", "child-a", "--outcome", "completed"]);
  expect(f.ledger().outstanding).toEqual([]);
  expect(f.ok(["list", "--json"])).toMatchObject({ engineReceipts: "not-read", releaseDependents: false });
});

test("unconfirmed acceptance stays pending and refuses redispatch", () => {
  const f = fixture(); const intent = f.intend();
  expect(f.ok(["list"]).reconciliationRequired).toBe(true);
  f.ok(["unknown", "--intent", intent]); f.ok(["unknown", "--intent", intent]);
  expect(f.ledger().intents[0].status).toBe("pending-unknown");
  expect(f.invoke(["intend", "--wave", "first", "--stage", "code-generation", "--task", "draft", "--role", "aidlc-crew-developer-agent"]).status).toBe(1);
  expect(f.ok(["wave-status", "--wave", "first"])).toMatchObject({ reconciliationRequired: true, releaseDependents: false });
  f.ok(["confirm", "--intent", intent, "--child", "child-a"]);
  expect(f.ledger().intents).toEqual([]);
});

test("duplicate confirmation and settlement preserve bytes while conflicts refuse", () => {
  const f = fixture(); const intent = f.intend();
  f.ok(["confirm", "--intent", intent, "--child", "child-a"]);
  const before = readFileSync(f.path);
  expect(f.ok(["confirm", "--intent", intent, "--child", "child-a"]).duplicate).toBe(true);
  expect(f.invoke(["confirm", "--intent", intent, "--child", "child-b"]).status).toBe(1);
  expect(readFileSync(f.path)).toEqual(before);
  f.ok(["settle", "--child", "child-a", "--outcome", "failed"]);
  const settled = readFileSync(f.path);
  expect(f.ok(["settle", "--child", "child-a", "--outcome", "failed"]).duplicate).toBe(true);
  for (const child of ["child-a", "missing"]) expect(f.invoke(["settle", "--child", child, "--outcome", "completed"]).status).toBe(1);
  expect(readFileSync(f.path)).toEqual(settled);
});

test("continuation retains conversation lineage and ignores duplicate old outcomes", () => {
  const f = fixture();
  f.ok(["confirm", "--intent", f.intend(), "--child", "child-a", "--conversation", "conversation"]);
  expect(f.invoke(["continue", "--child", "child-a", "--run", "child-b"]).status).toBe(1);
  f.ok(["settle", "--child", "child-a", "--outcome", "completed"]);
  f.ok(["continue", "--child", "child-a", "--run", "child-b"]);
  expect(f.ledger().outstanding[0]).toMatchObject({ childId: "child-b", runId: "child-b", previousChildId: "child-a", conversationId: "conversation" });
  expect(f.ok(["continue", "--child", "child-a", "--run", "child-b"]).duplicate).toBe(true);
  f.ok(["settle", "--child", "child-a", "--outcome", "completed"]);
  expect(f.ledger().outstanding[0].childId).toBe("child-b");
  expect(f.invoke(["settle", "--child", "child-b", "--run", "child-a", "--outcome", "completed"]).status).toBe(1);
  f.ok(["settle", "--child", "child-b", "--outcome", "stopped"]);
  expect(f.invoke(["continue", "--child", "child-a", "--run", "child-c"]).status).toBe(1);
  f.ok(["continue", "--child", "child-b", "--run", "child-c"]);
  expect(f.ledger().outstanding[0].conversationId).toBe("conversation");
});

test("wave selection and old-session reconciliation are read-only", () => {
  const f = fixture(); f.ok(["confirm", "--intent", f.intend(), "--child", "child-a"]); f.intend("other", "second");
  expect(f.ok(["wave-status", "--wave", "first"])).toMatchObject({ intents: [], engineReceipts: "not-read", releaseDependents: false });
  const before = readFileSync(f.path);
  expect(f.ok(["reconcile", "--session", f.session], { AIDLC_SESSION_OVERRIDE: "other-session" })).toMatchObject({ session: f.session, reconciliationRequired: true });
  expect(readFileSync(f.path)).toEqual(before);
  expect(existsSync(join(dirname(f.path), "other-session.crew-dispatch.json"))).toBe(false);
});

test("corrupt schemas, identities and flags refuse without clobbering", () => {
  const f = fixture(); const intent = f.intend(); const valid = f.ledger();
  for (const bad of ["{broken", "null", "{}", ...[
    { ...valid, schemaVersion: 2 }, { ...valid, session: "foreign" }, { ...valid, extra: true },
    { ...valid, intents: [...valid.intents, ...valid.intents] }, { ...valid, outstanding: [{ childId: "a" }] },
  ].map((value) => JSON.stringify(value))]) {
    writeFileSync(f.path, bad);
    expect(f.invoke(["unknown", "--intent", intent]).status).toBe(1);
    expect(readFileSync(f.path, "utf8")).toBe(bad);
  }
  writeFileSync(f.path, JSON.stringify(valid));
  for (const args of [["confirm", "--intent", intent, "--child", "?"], ["reconcile", "--session", "../escape"], ["list", "--typo"], ["list", "--json", "--json"], ["unknown", "--intent"]]) expect(f.invoke(args).status).toBe(1);
  expect(f.invoke(["list"], { AIDLC_SESSION_OVERRIDE: "../escape" }).status).toBe(1);
  expect(f.ledger()).toEqual(valid);
});

test("symlink paths and held locks refuse writes without touching the target", () => {
  const f = fixture(); const intent = f.intend(); const before = readFileSync(f.path);
  const held = runWithOwnerStampedLock(`${f.path}.lock`, 0, 0, () => f.invoke(["unknown", "--intent", intent]));
  expect(held.acquired).toBe(true);
  if (!held.acquired) throw new Error("fixture lock was not acquired");
  expect(held.value.status).toBe(1); expect(held.value.stderr ?? "").toContain("busy");
  expect(readFileSync(f.path)).toEqual(before);
  const target = join(f.project, "foreign.json"); writeFileSync(target, before); rmSync(f.path);
  symlinkSync(target, f.path);
  expect(f.invoke(["unknown", "--intent", intent]).status).toBe(1);
  expect(readFileSync(target)).toEqual(before);
});

test("atomic ledger writes remain parseable and leave no temporary files", async () => {
  const f = fixture(); f.intend();
  mkdirSync(dirname(f.path), { recursive: true });
  const child = Bun.spawn([process.execPath, f.tool, "engine", "crew-dispatch", "intend", "--wave", "second", "--stage", "code-generation", "--task", "other", "--role", "aidlc-crew-developer-agent"], { cwd: f.project, env: f.env, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + (remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) ?? NATIVE_STARTUP_TIMEOUT_MS);
  try {
    do { expect([1, 2]).toContain(f.ledger().intents.length); await Bun.sleep(1); } while (child.exitCode === null && Date.now() < deadline);
    if (child.exitCode === null) child.kill();
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(f.ledger().intents).toHaveLength(2);
    expect(readdirSync(dirname(f.path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
});
