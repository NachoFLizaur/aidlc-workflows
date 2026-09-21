#!/usr/bin/env bun
/**
 * Crew dispatch ledger: transport bookkeeping, never engine success/approval
 * evidence. Only the conductor writes it; children remain flat. No host calls,
 * audit receipts, workflow transitions, or dependency releases happen here.
 *
 * A spawn accepted before confirmation leaves an intended or pending-unknown
 * entry. Re-entry requires reconciliation with Crew's saved runs, not redispatch.
 * Only confirmed outstanding children suppress the Stop adapter's nudge.
 *
 * Schema, session identity and exact intent/run correlation are checked under
 * the session's owner-stamped lock before mutation and again before atomic write.
 * Corruption, conflicting outcomes, missing identifiers and contention fail with
 * exit 1, never empty-state replacement. No bypass or expiry applies. Path-chain
 * checks refuse existing symlinks, not hostile concurrent filesystem changes.
 * Records are same-user bookkeeping, not authenticated grants. Reads take atomic
 * snapshots without a lock and never mutate, including old-session reconcile.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative } from "node:path";
import {
  assertNoSymlinkInChainOrThrow, resolveProjectDir, resolveWorkflowSelection,
  runWithOwnerStampedLock, validSessionId, writeFileAtomic,
} from "./aidlc-lib.ts";

type Intent = {
  intentId: string; wave: string; stage: string; task: string; role: string;
  intendedAt: string; status: "intended" | "pending-unknown";
};
type Dispatch = Omit<Intent, "status"> & {
  childId: string; conversationId: string; runId: string; dispatchedAt: string;
  previousChildId?: string;
};
type Outcome = "completed" | "failed" | "stopped" | "lost";
type Settled = Dispatch & { outcome: Outcome; settledAt: string };
export type CrewDispatchLedger = {
  schemaVersion: 1; session: string; intents: Intent[];
  outstanding: Dispatch[]; settled: Settled[];
};
const OUTCOMES = ["completed", "failed", "stopped", "lost"] as const;
const FLAGS: Record<string, string[]> = {
  intend: ["wave", "stage", "task", "role"],
  confirm: ["intent", "child", "conversation"],
  unknown: ["intent"], settle: ["child", "outcome", "run"],
  continue: ["child", "run"], "wave-status": ["wave"],
  reconcile: ["session"], list: [],
};
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && !v.includes("\0");
const id = (v: unknown): v is string => text(v) && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(v);
const timestamp = (v: unknown): boolean => text(v) && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const baseKeys = ["intentId", "wave", "stage", "task", "role", "intendedAt"];
const dispatchKeys = [...baseKeys, "childId", "conversationId", "runId", "dispatchedAt", "previousChildId"];
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const role = (v: unknown): v is string => text(v) && /^aidlc-crew-[a-z]+(?:-[a-z]+)*-agent$/.test(v);
function base(v: Record<string, unknown>): boolean {
  return id(v.intentId) && id(v.wave) && id(v.stage) && text(v.task) && role(v.role) && timestamp(v.intendedAt);
}
function dispatch(v: unknown): v is Dispatch {
  return object(v) && base(v) && id(v.childId) && id(v.conversationId) && v.runId === v.childId &&
    timestamp(v.dispatchedAt) && (v.previousChildId === undefined || id(v.previousChildId));
}

/** Exact schema validation precedes writes; corruption never drops fields. */
export function validateCrewDispatchLedger(v: unknown, session: string): asserts v is CrewDispatchLedger {
  const invalid = "malformed Crew dispatch ledger; preserve the file and reconcile before dispatch";
  requireValue(object(v) && keys(v, ["schemaVersion", "session", "intents", "outstanding", "settled"]) &&
    v.schemaVersion === 1 && v.session === session && validSessionId(session) &&
    Array.isArray(v.intents) && Array.isArray(v.outstanding) && Array.isArray(v.settled), invalid);
  requireValue(v.intents.every((e: unknown) => object(e) && keys(e, [...baseKeys, "status"]) && base(e) &&
    ["intended", "pending-unknown"].includes(String(e.status))), invalid);
  requireValue(v.outstanding.every((e: unknown) => dispatch(e) && keys(e, dispatchKeys)), invalid);
  requireValue(v.settled.every((e: unknown) => object(e) &&
    keys(e, [...dispatchKeys, "outcome", "settledAt"]) &&
    OUTCOMES.includes(e.outcome as Outcome) && timestamp(e.settledAt) && dispatch(e)), invalid);
  const ledger = v as CrewDispatchLedger;
  const runs = [...ledger.outstanding, ...ledger.settled];
  requireValue(new Set(runs.map((e) => e.childId)).size === runs.length &&
    new Set(ledger.intents.map((e) => e.intentId)).size === ledger.intents.length &&
    !ledger.intents.some((e) => runs.some((run) => run.intentId === e.intentId)) &&
    new Set(ledger.outstanding.map((e) => e.conversationId)).size === ledger.outstanding.length, invalid);
}

function ledgerPath(project: string, session: string): string {
  requireValue(validSessionId(session), "invalid session id");
  return assertNoSymlinkInChainOrThrow(project, `aidlc/.aidlc-sessions/${session}.crew-dispatch.json`);
}
function readLedger(project: string, session: string): CrewDispatchLedger {
  let raw: string;
  try { raw = readFileSync(ledgerPath(project, session), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, session, intents: [], outstanding: [], settled: [] };
    }
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("malformed Crew dispatch ledger JSON; preserve the file and reconcile before dispatch"); }
  validateCrewDispatchLedger(value, session);
  return value;
}

function mutate(ledger: CrewDispatchLedger, verb: string, f: Record<string, string>): unknown {
  const need = (key: string): string => {
    requireValue(text(f[key]), `--${key} is required`);
    return f[key];
  };
  const now = new Date().toISOString();
  if (verb === "intend") {
    const entry: Intent = {
      intentId: randomUUID(), wave: need("wave"), stage: need("stage"), task: need("task"),
      role: need("role"), intendedAt: now, status: "intended",
    };
    requireValue(![...ledger.intents, ...ledger.outstanding, ...ledger.settled].some((e) =>
      e.wave === entry.wave && e.stage === entry.stage && e.task === entry.task && e.role === entry.role),
    "dispatch identity already recorded; inspect list and reconcile, never retry automatically (use a new wave for authorized new work)");
    ledger.intents.push(entry);
    return entry;
  }
  if (verb === "confirm" || verb === "unknown") {
    const intentId = need("intent");
    const intent = ledger.intents.find((e) => e.intentId === intentId);
    if (verb === "confirm" && !intent) {
      const prior = [...ledger.outstanding, ...ledger.settled].find((e) => e.intentId === intentId && e.childId === need("child"));
      requireValue(prior && (!f.conversation || prior.conversationId === f.conversation), "unknown or conflicting intent confirmation");
      return { ...prior, duplicate: true };
    }
    requireValue(intent, "unknown intent; reconcile the recorded identity");
    if (verb === "unknown") { intent.status = "pending-unknown"; return intent; }
    const childId = need("child");
    requireValue(![...ledger.outstanding, ...ledger.settled].some((e) => e.childId === childId), "child id already recorded");
    const { status: _status, ...base } = intent;
    const entry: Dispatch = { ...base, childId, runId: childId, conversationId: f.conversation ?? childId, dispatchedAt: now };
    ledger.intents = ledger.intents.filter((e) => e.intentId !== intentId);
    ledger.outstanding.push(entry);
    return entry;
  }
  const childId = need("child");
  if (verb === "settle") {
    const runId = f.run ?? childId;
    const entry = ledger.outstanding.find((e) => e.childId === childId && e.runId === runId);
    const outcome = need("outcome") as Outcome;
    requireValue(OUTCOMES.includes(outcome), "--outcome must be completed|failed|stopped|lost");
    if (!entry) {
      const prior = ledger.settled.find((e) => e.childId === childId && e.runId === runId);
      requireValue(prior && prior.outcome === outcome, "unknown child/run or conflicting terminal outcome; reconcile, do not infer success");
      return { ...prior, duplicate: true };
    }
    const settled: Settled = { ...entry, outcome, settledAt: now };
    ledger.outstanding = ledger.outstanding.filter((e) => e !== entry);
    ledger.settled.push(settled);
    return settled;
  }
  requireValue(verb === "continue", "unknown mutation");
  const runId = need("run");
  const prior = ledger.settled.find((e) => e.childId === childId);
  requireValue(prior, "continuation requires a settled child and its saved conversation id");
  const duplicate = [...ledger.outstanding, ...ledger.settled].find((e) => e.childId === runId);
  if (duplicate) {
    requireValue(duplicate.previousChildId === childId, "new run id belongs to other work");
    return { ...duplicate, duplicate: true };
  }
  requireValue(![...ledger.outstanding, ...ledger.settled].some((e) => e.previousChildId === childId) &&
    !ledger.outstanding.some((e) => e.conversationId === prior.conversationId), "conversation already continued; use its latest settled run");
  const { outcome: _outcome, settledAt: _settledAt, ...base } = prior;
  const entry: Dispatch = { ...base, childId: runId, runId, previousChildId: childId, dispatchedAt: now };
  ledger.outstanding.push(entry);
  return entry;
}

export function main(argv: string[]): void {
  try {
    const [verb, ...args] = argv;
    requireValue(verb && Object.hasOwn(FLAGS, verb), `Usage: engine crew-dispatch ${Object.keys(FLAGS).join("|")} [flags] [--json] [--project-dir <path>]`);
    const flags: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      const key = args[i].slice(2);
      requireValue(args[i].startsWith("--") && [...FLAGS[verb], "project-dir", "json"].includes(key) && !Object.hasOwn(flags, key), `unknown or duplicate argument: ${args[i]}`);
      if (key === "json") { flags[key] = "true"; continue; }
      const value = args[++i];
      requireValue(text(value) && !value.startsWith("--"), `--${key} requires a value`);
      flags[key] = value;
    }
    const project = realpathSync(resolveProjectDir(flags["project-dir"]));
    requireValue(process.env.AIDLC_SESSION_OVERRIDE === undefined || validSessionId(process.env.AIDLC_SESSION_OVERRIDE), "invalid AIDLC_SESSION_OVERRIDE");
    const session = verb === "reconcile" ? flags.session : resolveWorkflowSelection(project).sessionId;
    requireValue(session && validSessionId(session), "no valid conversation session; call aidlc_status to bind it (or set AIDLC_SESSION_OVERRIDE for direct engine use)");
    const path = ledgerPath(project, session);
    let result: unknown;
    if (["list", "reconcile", "wave-status"].includes(verb)) {
      const ledger = readLedger(project, session);
      if (verb === "wave-status") requireValue(id(flags.wave), "--wave is required and must be an identifier");
      const selected = verb === "wave-status" ? {
        ...ledger, intents: ledger.intents.filter((e) => e.wave === flags.wave),
        outstanding: ledger.outstanding.filter((e) => e.wave === flags.wave),
        settled: ledger.settled.filter((e) => e.wave === flags.wave),
      } : ledger;
      result = { ...selected, ...(verb === "wave-status" ? { wave: flags.wave } : {}),
        reconciliationRequired: selected.intents.length > 0 || (verb === "reconcile" && selected.outstanding.length > 0),
        engineReceipts: "not-read", releaseDependents: false,
        receiptHints: ["pipeline: engine log link", "supports: contribution files", "reviews: request/completion receipt pair", "unit waves: engine state unit complete --wave", "lifecycle: engine orchestrate report"],
        ...(verb === "reconcile" ? { action: "explicit stop/carry decision required; old session remains unchanged" } : {}),
      };
    } else {
      // Check the existing path chain before creating the lock parent.
      mkdirSync(dirname(path), { recursive: true });
      const lock = assertNoSymlinkInChainOrThrow(project, `${relative(project, path)}.lock`);
      const transaction = runWithOwnerStampedLock(lock, 20, 25, () => {
        const ledger = readLedger(project, session);
        const before = JSON.stringify(ledger);
        const value = mutate(ledger, verb, flags);
        validateCrewDispatchLedger(ledger, session);
        if (JSON.stringify(ledger) !== before) writeFileAtomic(ledgerPath(project, session), `${JSON.stringify(ledger, null, 2)}\n`);
        return value;
      });
      requireValue(transaction.acquired, "dispatch ledger busy; inspect status before retrying this bookkeeping operation; never retry spawn automatically");
      result = transaction.value;
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Crew dispatch: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
if (import.meta.main) main(process.argv.slice(2));
