/**
 * Shared ESM rendering, no props, build step or workflow actions.
 * The browser loads only import-map modules. The environment check is evaluated at
 * module load, before host imports: DOM-free consumers get the same pure exports
 * without React or SDK stubs. It is not an authorization guard or a runtime fallback.
 * HTTP authorization belongs to routes.py; the SDK allowlist is client-side only.
 */
let React, useAppApi, useAppInfo, useTheme, icons;
if (typeof window !== "undefined") {
  const [react, sdk, lucide] = await Promise.all([
    import("react"), import("@kirocrew/app-sdk"), import("lucide-react"),
  ]);
  React = react;
  ({ useAppApi, useAppInfo, useTheme } = sdk);
  // These five named exports exist in Crew 0.6.0's vendor/lucide-react.mjs.
  const { Check, Loader2, Clock, ArrowRight, AlertTriangle } = lucide;
  icons = { completed: Check, active: Loader2, pending: Clock, skipped: ArrowRight, blocked: AlertTriangle };
}

export const DISCLOSURE = "Observe-only is an application guarantee: this route runs unsandboxed inside the Crew gateway under the App Kit's local-app trust and never writes AIDLC state.";
export const ATTRIBUTION = "Attribution: this panel shows the conversation Crew reports for this tab (host-UI attribution; owner session required).";
export const PROVIDER_NOT_RECORDED = "not currently recorded";
export const POLL_MS = 5_000;
export const MAX_BACKOFF_MS = 60_000;
export const GUARD_MESSAGE = "Progress unavailable — the App Kit route guard is not available in this Crew build";
const ACCESS_REMEDY = "Access denied. Use an authenticated owner dashboard session and check that AI-DLC is enabled, then retry.";
const SETUP_REMEDY = "Project setup needs attention. Rerun project setup and doctor, then retry.";
const NO_BOUND_PROJECTS = "No bound projects. Select your configured project in a new dashboard chat and message aidlc-crew; its first status call binds the project.";
const PROJECTS_PATH = "/api/apps/aidlc/projects";
const LABELS = ["kiro", "claude", "codex", "unknown"];
const STAGES = ["pending", "in-progress", "awaiting-approval", "revising", "completed", "skipped"];
const BLOCKERS = ["awaiting-approval", "revising", "pending-decision", "dispatch-outstanding"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string";
const optionalText = value => value === undefined || text(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const date = value => text(value) && Number.isFinite(Date.parse(value));
const providerValid = value => object(value) && LABELS.includes(value.label)
  && value.source === "crew-session-map" && typeof value.conflict === "boolean";
const intentValid = value => object(value) && text(value.space) && text(value.id)
  && text(value.displayName) && typeof value.eligible === "boolean" && optionalText(value.reason);
const blockerValid = value => object(value) && BLOCKERS.includes(value.kind) && text(value.ref);
const backendValid = value => object(value) && (value.asRecorded === null || LABELS.includes(value.asRecorded))
  && typeof value.conflict === "boolean" && optionalText(value.source)
  && (value.codexAssociated === undefined || (object(value.codexAssociated) && text(value.codexAssociated.source)));
const stageValid = value => object(value) && text(value.slug) && STAGES.includes(value.state)
  && (value.gate === undefined || (object(value.gate) && ["[?]", "[R]"].includes(value.gate.kind)
    && (value.gate.ageMs === undefined || count(value.gate.ageMs))));

function selectedValid(value, intents) {
  return object(value) && text(value.displayName) && optionalText(value.description)
    && optionalText(value.scope) && optionalText(value.status) && optionalText(value.activeStage)
    && text(value.space) && text(value.id)
    && (intents === undefined || intents.some(intent => intent.eligible && intent.space === value.space && intent.id === value.id))
    && Array.isArray(value.phases) && value.phases.every(phase => object(phase) && text(phase.name)
      && ["completed", "active", "pending"].includes(phase.status)
      && Array.isArray(phase.stages) && phase.stages.every(stageValid))
    && object(value.totals) && [value.totals.completed, value.totals.total, value.totals.skipped].every(count)
    && value.totals.completed + value.totals.skipped <= value.totals.total
    && Array.isArray(value.blockers) && value.blockers.every(blockerValid)
    && Array.isArray(value.unattributedBlockers) && value.unattributedBlockers.every(blockerValid)
    && backendValid(value.backend) && object(value.ledger)
    && count(value.ledger.outstanding) && count(value.ledger.settled);
}

function failure(status, body, fallback = "INVALID_RESPONSE", message = "The gateway returned an invalid progress response.") {
  const error = object(body?.error) && text(body.error.code) && text(body.error.message)
    ? { code: body.error.code, message: body.error.message }
    : { code: status !== 200 ? `HTTP_${status}` : fallback, message };
  return {
    state: status === 503 || error.code === "GUARD_UNAVAILABLE" ? "unavailable" : "error",
    httpStatus: status, error, disclosure: DISCLOSURE,
    provider: providerValid(body?.provider) ? body.provider : undefined,
  };
}

/**
 * Decode before committing any UI snapshot. Oracle: schemaVersion 1 and the
 * reader union; non-200/error bodies never become progress, even with selected.
 * Failures preserve their code, not a zero-count fallback. No disabling option.
 * UI buckets reserve unavailable for HTTP 503/guard failure; other refusals are
 * errors with their original code (including the shim's 409/502/504 unavailable).
 */
export function decodeProjects(status, body) {
  if (status !== 200 || ["error", "unavailable"].includes(body?.state)) return failure(status, body);
  if (!object(body) || body.schemaVersion !== 1 || body.disclosure !== DISCLOSURE
    || !Array.isArray(body.projects) || !body.projects.every(project => object(project)
      && text(project.id) && /^[a-f0-9]{16}$/.test(project.id) && text(project.displayName) && date(project.boundAt)
      && typeof project.stampValid === "boolean"
      && (project.providerLabel === undefined || LABELS.includes(project.providerLabel)))
    || new Set(body.projects.map(project => project.id)).size !== body.projects.length
    || !Array.isArray(body.warnings) || !body.warnings.every(warning => object(warning)
      && text(warning.code) && count(warning.count))) return failure(status, null);
  return { ...body, state: body.projects.length ? "ok" : "empty" };
}

export function decodeProgress(status, body) {
  if (status !== 200 || ["error", "unavailable"].includes(body?.state)) return failure(status, body);
  if (!object(body) || body.schemaVersion !== 1 || body.disclosure !== DISCLOSURE
    || !date(body.generatedAt) || !object(body.project) || !text(body.project.dir)
    || !Array.isArray(body.intents) || !body.intents.every(intentValid) || !providerValid(body.provider)
    || !["ok", "empty", "selection-required"].includes(body.state)
    || (body.state === "ok" ? !selectedValid(body.selected, body.intents) : body.selected !== undefined)) {
    return failure(status, null);
  }
  return body;
}

/** Session envelope is the oracle, decoded before reducer publication. Unlike
 * the page, ok has no census to join: the shim already resolved the exact intent.
 * Refusals expose diagnostics/provider and a valid opaque revision, never selected.
 * References are correlation aids only: exactly eight lowercase hex, checked
 * before publication on success/refusal; malformed references are absent. Invalid
 * envelopes fail closed with no reference. No identity cache or disabling option.
 * Unknown/malformed envelopes fail closed; no fallback selection or bypass.
 */
export function decodeSessionProgress(status, body) {
  const bindingRevision = text(body?.bindingRevision) && /^[a-f0-9]{16}$/.test(body.bindingRevision)
    ? body.bindingRevision : undefined;
  const conversationRef = text(body?.conversationRef) && body.conversationRef.length === 8 && /^[0-9a-f]{8}$/.test(body.conversationRef)
    ? body.conversationRef : undefined;
  if (status !== 200 || ["error", "unavailable"].includes(body?.state)) {
    const result = failure(status, body);
    return { ...result, state: body?.state === "unavailable" ? "unavailable" : result.state, bindingRevision, conversationRef };
  }
  if (!object(body) || body.schemaVersion !== 1 || body.disclosure !== DISCLOSURE
    || !date(body.generatedAt) || !["ok", "census", "unbound", "unsupported"].includes(body.state)
    || (body.state !== "ok" && body.selected !== undefined)) return failure(status, null);
  const common = { state: body.state, generatedAt: body.generatedAt, disclosure: DISCLOSURE, conversationRef };
  if (body.state === "unbound") return text(body.guidance) ? { ...common, guidance: body.guidance } : failure(status, null);
  if (body.state === "unsupported") return text(body.reason) ? { ...common, reason: body.reason } : failure(status, null);
  if (!bindingRevision || !object(body.project) || !text(body.project.displayName)
    || body.project.stampValid !== true || !providerValid(body.provider)
    || (body.state === "ok" ? !selectedValid(body.selected) : !Array.isArray(body.census) || !body.census.every(intentValid))) {
    return failure(status, null);
  }
  return { ...common, bindingRevision,
    project: { displayName: body.project.displayName, stampValid: true }, provider: body.provider,
    ...(body.state === "ok" ? { selected: body.selected } : { census: body.census }),
  };
}

/** Display oracle: only the currently settled decoder snapshot. Read at render;
 * omit while loading (including refresh), and never remember a previous reference
 * through a no-reference refusal or SDK failure. No fallback/override; not auth.
 */
export function conversationReference(state) {
  return state.inFlight ? undefined : (state.error ?? state.view)?.conversationRef;
}

/** SDK 0.6.0 returns parsed success bodies but throws Error(`API <status>: <text>`).
 * Decode that transport at the boundary, before the union decoder. Non-JSON auth
 * pages and network/allowlist errors get safe text, never HTML or inferred data.
 */
export function decodeSdkError(error, decode) {
  const message = error instanceof Error ? error.message : "";
  const match = /^API (\d{3}): ([\s\S]*)$/.exec(message);
  if (match) {
    let body;
    try { body = JSON.parse(match[2]); } catch { body = null; }
    return decode(Number(match[1]), body);
  }
  const denied = message.includes("not permitted to access");
  return failure(200, { error: {
    code: denied ? "SDK_NOT_PERMITTED" : "REFRESH_FAILED",
    message: denied ? "The app is not permitted to access its progress API. Check the installed permissions.api grant."
      : "The refresh failed. Check the gateway connection and retry.",
  } });
}

export async function getDecoded(api, path, decode) {
  try { return decode(200, await api.get(path)); }
  catch (error) { return decodeSdkError(error, decode); }
}

export function progressPath(projectId, intent) {
  const params = new URLSearchParams({ project: projectId });
  if (intent) { params.set("space", intent.space); params.set("intent", intent.id); }
  return `/api/apps/aidlc/progress?${params}`;
}

/** Attribution is the reader's oracle, read before rendering; never infer it from
 * a ref, stage name or project ledger total. No UI override can merge the lists.
 */
export function partitionBlockers(selected) {
  return { selected: [...(selected?.blockers ?? [])], project: [...(selected?.unattributedBlockers ?? [])] };
}

/** Provider oracle: exact-key presence and normalized label, read at render.
 * False presence or unknown means no live observation, never disagreement. The
 * project aggregate omits presence; its known labels remain usable. Only two
 * known, disagreeing labels raise a conflict; source conflict flags are ignored.
 * No override; display only, never execution admission.
 */
export function combineLabels(readerBackend, provider) {
  const recorded = readerBackend?.asRecorded ?? null;
  const observed = provider?.label ?? null;
  const unavailable = provider?.present === false || observed === "unknown";
  const known = label => LABELS.includes(label) && label !== "unknown";
  const sources = [];
  if (recorded === "codex" || readerBackend?.codexAssociated) {
    sources.push(readerBackend?.codexAssociated?.source ?? "project-binding (recorded, not live)");
  }
  if (observed === "codex") sources.push(provider.source);
  return {
    recorded: `Backend as recorded: ${recorded ?? "not recorded"} (not live identity)`,
    recordedSource: readerBackend?.source ?? "no recorded source",
    provider: `Crew provider (session map): ${unavailable ? PROVIDER_NOT_RECORDED : observed ?? "not available"}`,
    providerSource: provider?.source ?? "no provider observation",
    conflict: !unavailable && known(recorded) && known(observed) && recorded !== observed,
    codex: sources.length ? `Codex-associated (source: ${[...new Set(sources)].join("; ")})` : null,
  };
}

export function initialState(now = 0, hidden = false, active = true, session = false) {
  return {
    projects: null, warnings: [], projectId: null, intent: null, intents: [], view: null,
    error: null, lastUpdated: null, failures: 0, nextAt: now, hidden, active, session, bindingRevision: null,
    inFlight: false, generation: 0, requestGeneration: null, immediate: false,
  };
}

export function planPolls(state, now) {
  const waitMs = Math.max(0, state.nextAt - now);
  const paused = state.hidden || state.active === false;
  return { poll: !paused && !state.inFlight && waitMs === 0,
    waitMs, nextSeconds: Math.ceil(waitMs / 1000), paused };
}

function clearSelection(state, now) {
  return { ...state, intent: null, intents: [], view: null, error: null, lastUpdated: null,
    failures: 0, nextAt: now, immediate: state.inFlight };
}

/**
 * Poll/selection oracle: inFlight, visibility and generation, read BEFORE each
 * request and BEFORE accepting its result. A switch clears all selected data but
 * retains the flight lock until settlement; stale generations cannot publish.
 * Hidden/inactive pauses new work, not an already running request. Retry/resume
 * queue an immediate refresh, never clear the lock. For session consumers, the
 * opaque revision and response state are checked before publication: a changed
 * revision invalidates the old view, and EVERY refusal discards selected data
 * even with the same revision (a refusal revision is not retention authority).
 * Page consumers retain their last-good-on-error behavior. No guard bypass.
 */
export function reduce(state, action) {
  switch (action.type) {
    case "tick":
      return planPolls(state, action.now).poll
        ? { ...state, inFlight: true, requestGeneration: state.generation, immediate: false } : state;
    case "visibility":
      return { ...state, hidden: action.hidden,
        nextAt: action.hidden ? state.nextAt : action.now,
        immediate: state.immediate || (!action.hidden && state.inFlight) };
    case "activity":
      if (state.active === action.active) return state;
      return { ...state, active: action.active,
        nextAt: action.active === false ? state.nextAt : action.now,
        immediate: state.immediate || (action.active !== false && state.inFlight) };
    case "retry":
      return { ...state, failures: 0, nextAt: action.now, immediate: state.inFlight };
    case "project":
      if (action.id === state.projectId || !state.projects?.some(project => project.id === action.id && project.stampValid)) return state;
      return { ...clearSelection(state, action.now), projectId: action.id, generation: state.generation + 1 };
    case "intent":
      if (!state.intents.some(intent => intent.eligible && intent.space === action.intent?.space && intent.id === action.intent?.id)) return state;
      return { ...state, intent: { space: action.intent.space, id: action.intent.id }, view: null,
        error: null, lastUpdated: null, failures: 0, nextAt: action.now,
        generation: state.generation + 1, immediate: state.inFlight };
    case "census": {
      if (action.generation !== state.generation) return state;
      const projects = action.result.projects;
      // The gateway guarantees recency order. Preserve an explicit valid project on refresh.
      const projectId = projects.find(project => project.id === state.projectId && project.stampValid)?.id
        ?? projects.find(project => project.stampValid)?.id ?? null;
      const next = projectId === state.projectId ? state : clearSelection(state, action.now);
      return { ...next, projects, warnings: action.result.warnings, projectId, immediate: state.immediate };
    }
    case "settle": {
      if (!state.inFlight || action.generation !== state.requestGeneration) return state;
      let next = { ...state, inFlight: false, requestGeneration: null, immediate: false };
      if (action.generation !== state.generation || !action.result) return { ...next, nextAt: action.now };
      if (state.session) {
        const bindingRevision = action.result.bindingRevision ?? null;
        if (bindingRevision !== state.bindingRevision || action.result.state !== "ok") {
          next = { ...next, view: null, intent: null, intents: [], lastUpdated: null };
        }
        next = { ...next, bindingRevision };
      }
      if (["error", "unavailable"].includes(action.result.state)) {
        const failures = state.failures + 1;
        // Failure n=1..5 => 5,10,20,40,60 seconds; later failures stay capped.
        const delay = Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(failures - 1, 4));
        return { ...next, error: action.result, failures, nextAt: action.now + (state.immediate ? 0 : delay) };
      }
      return { ...next, view: action.result, intents: action.result.intents ?? [], error: null,
        lastUpdated: action.result.generatedAt ?? new Date(action.now).toISOString(), failures: 0,
        nextAt: action.now + (state.immediate ? 0 : POLL_MS) };
    }
    default: return state;
  }
}

/** Per-instance scheduling. The reducer's flight/generation oracle is read before
 * invoking a fetcher and again before accepting its settlement. Visibility and
 * host activity gate new requests only, not an already-running settlement.
 * stop invalidates publication, NOT the flight lock; restart of the same hook
 * (including effect replay) waits for settlement. Other instances never wait on
 * this one. No timeout/abort unlock: the SDK must settle after server cleanup.
 * No disabling option; fetchers must use canRequest before a subsequent GET.
 */
export function createPollScheduler(fetcher, { now = Date.now, hidden = false, active = true, session = false } = {}) {
  let state = initialState(now(), hidden, active, session);
  let stopped = false;
  let publish = () => {};
  const getState = () => state;
  const send = action => {
    const next = reduce(state, { ...action, now: action.now ?? now() });
    if (next !== state) { state = next; if (!stopped) publish(next); }
  };
  return {
    getState, send,
    start(listener) { publish = listener; stopped = false; send({ type: "retry" }); },
    stop() { stopped = true; state = { ...state, generation: state.generation + 1 }; },
    tick() {
      if (stopped || !planPolls(state, now()).poll) return;
      send({ type: "tick" });
      const generation = state.generation;
      const current = () => !stopped && state.generation === generation;
      const canRequest = () => current() && !planPolls(state, now()).paused;
      return (async () => {
        let result;
        try { result = await fetcher({ getState, send, generation, current, canRequest }); }
        catch (error) { result = decodeSdkError(error, state.session ? decodeSessionProgress : decodeProgress); }
        finally { send({ type: "settle", generation, result }); }
      })();
    },
  };
}

/** Host pause oracle: document.hidden and the latest useAppInfo activity are read
 * before pumping and before a fetcher's subsequent GET, even if an activity
 * effect has not yet run. Hidden documents or an inactive host pause new work;
 * resuming queues an immediate pump without unlocking a flight. No bypass.
 */
export function usePolling(fetcher, { active = true, session = false } = {}) {
  const fetcherRef = React.useRef(fetcher);
  fetcherRef.current = fetcher;
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const [scheduler] = React.useState(() => createPollScheduler(context => fetcherRef.current({
    ...context,
    canRequest: () => context.canRequest() && !document.hidden && activeRef.current !== false,
  }), {
    hidden: document.hidden, active, session,
  }));
  const [snapshot, setSnapshot] = React.useState(scheduler.getState);
  const [now, setNow] = React.useState(() => Date.now());
  const controls = React.useRef(() => {});
  React.useEffect(() => {
    let stopped = false;
    let timer;
    scheduler.start(setSnapshot);
    function pump() {
      if (stopped) return;
      clearTimeout(timer);
      const time = Date.now();
      setNow(time);
      if (scheduler.getState().hidden !== document.hidden) scheduler.send({ type: "visibility", hidden: document.hidden });
      if (scheduler.getState().active !== activeRef.current) scheduler.send({ type: "activity", active: activeRef.current });
      const pending = scheduler.tick();
      if (pending) void pending.finally(pump);
      const state = scheduler.getState();
      const wait = planPolls(state, time).paused || state.inFlight ? 1000 : Math.min(1000, planPolls(state, time).waitMs);
      timer = setTimeout(pump, wait);
    }
    controls.current = action => { scheduler.send(action); pump(); };
    const visibility = () => controls.current({ type: "visibility", hidden: document.hidden });
    document.addEventListener("visibilitychange", visibility);
    pump();
    return () => {
      stopped = true;
      scheduler.stop();
      clearTimeout(timer);
      controls.current = () => {};
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [scheduler]);
  React.useEffect(() => { controls.current({ type: "activity", active }); }, [active]);
  return [snapshot, now, action => controls.current(action)];
}

function useProgress(api, active) {
  return usePolling(async ({ getState, send, generation, current, canRequest }) => {
    if (!canRequest()) return;
    let result = await getDecoded(api, PROJECTS_PATH, decodeProjects);
    if (!current() || ["error", "unavailable"].includes(result.state)) return result;
    send({ type: "census", result, generation });
    if (!getState().projectId) return result;
    // Hidden/inactive/switch after census must not start another HTTP request.
    if (document.hidden || !canRequest()) return;
    const { projectId, intent } = getState();
    result = await getDecoded(api, progressPath(projectId, intent), decodeProgress);
    if (result.state === "ok" && intent
      && (result.selected.space !== intent.space || result.selected.id !== intent.id)) {
      return failure(200, { error: { code: "SELECTION_MISMATCH", message: "The response does not match the selected intent." } });
    }
    return result;
  }, { active });
}

// Scope every selector; inherit host typography/tokens, with mode-aware fallbacks.
export const CSS = `
.aidlc-progress { --ap-bg:#12141a; --ap-card:#181b22; --ap-text:#e4e4e7; --ap-line:#454853; --ap-warn:#f2c878; color-scheme:dark; color:var(--text,var(--ap-text)); background:var(--bg,var(--ap-bg)); font:400 14px/1.6 var(--font-body,system-ui,sans-serif); padding:clamp(16px,3vw,40px); width:100%; min-width:0; min-height:0; flex:1; overflow:auto; overflow-wrap:anywhere; }
.aidlc-progress[data-mode="light"] { --ap-bg:#fafafa; --ap-card:#fff; --ap-text:#24262b; --ap-line:#b7bcc5; --ap-warn:#805000; color-scheme:light; }
.aidlc-progress * { box-sizing:border-box; }
.aidlc-progress .ap-content { max-width:1080px; margin:0 auto; }
.aidlc-progress h1,.aidlc-progress h2,.aidlc-progress h3 { color:var(--text-strong,var(--ap-text)); line-height:1.3; margin:0 0 12px; font-weight:600; }
.aidlc-progress h1 { font-size:clamp(24px,3vw,32px); letter-spacing:-.035em; }
.aidlc-progress h2 { font-size:18px; }
.aidlc-progress h3 { font-size:15px; }
.aidlc-progress p { margin:8px 0; }
.aidlc-progress .ap-kicker { font-size:12px; letter-spacing:.1em; text-transform:uppercase; }
.aidlc-progress .ap-pickers { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr)); gap:20px; margin:24px 0; }
.aidlc-progress label { display:block; font-weight:600; margin-bottom:8px; }
.aidlc-progress select,.aidlc-progress button { font:inherit; color:inherit; background:var(--card,var(--ap-card)); border:1px solid var(--border-strong,var(--ap-line)); border-radius:6px; min-height:44px; padding:9px 12px; }
.aidlc-progress select { width:100%; min-width:0; text-overflow:ellipsis; }
.aidlc-progress button { cursor:pointer; }
.aidlc-progress :is(select,button):focus-visible { outline:2px solid var(--accent,currentColor); outline-offset:3px; }
.aidlc-progress button:hover:not(:disabled) { border-color:var(--accent,currentColor); }
.aidlc-progress :disabled { cursor:not-allowed; opacity:.65; }
.aidlc-progress .ap-panel { padding:24px 0; border-top:1px solid var(--border,var(--ap-line)); }
.aidlc-progress .ap-overview { border-left:3px solid var(--accent,currentColor); background:var(--card,var(--ap-card)); padding:20px 24px; margin-bottom:24px; border-radius:0 6px 6px 0; }
.aidlc-progress .ap-counts { font-size:clamp(17px,2vw,22px); font-weight:500; font-variant-numeric:tabular-nums; }
.aidlc-progress .ap-columns { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(0,1fr); gap:32px; }
.aidlc-progress .ap-phase { margin:0 0 24px; }
.aidlc-progress .ap-row { display:flex; align-items:baseline; flex-wrap:wrap; justify-content:space-between; gap:8px 20px; }
.aidlc-progress .ap-status { display:inline-flex; align-items:center; gap:7px; font-size:13px; white-space:nowrap; }
.aidlc-progress svg { flex-shrink:0; }
.aidlc-progress .ap-stage-list { list-style:none; padding:0; margin:0; border-left:1px solid var(--border-strong,var(--ap-line)); }
.aidlc-progress .ap-stage { padding:9px 0 9px 16px; }
.aidlc-progress .ap-stage[data-active="true"] { border-left:3px solid var(--accent,currentColor); margin-left:-2px; background:var(--card,var(--ap-card)); }
.aidlc-progress .ap-mono { font:inherit; font-family:ui-monospace,monospace; overflow-wrap:anywhere; }
.aidlc-progress .ap-detail { font-size:13px; overflow-wrap:anywhere; }
.aidlc-progress .ap-warning { color:var(--ap-warn); }
.aidlc-progress .ap-blockers { padding-left:20px; margin:12px 0; }
.aidlc-progress .ap-blockers li { padding:4px 0; overflow-wrap:anywhere; }
.aidlc-progress .ap-notice { border:1px solid var(--border-strong,var(--ap-line)); padding:16px 20px; margin:20px 0; border-radius:6px; overflow-wrap:anywhere; }
.aidlc-progress .ap-labels { display:grid; gap:10px; }
.aidlc-progress .ap-labels p { margin:0; }
.aidlc-progress footer { margin-top:24px; }
.aidlc-progress .ap-disclosure { max-width:88ch; font-size:13px; }
.aidlc-progress .ap-announcement { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
@media (max-width:760px) { .aidlc-progress .ap-columns { grid-template-columns:minmax(0,1fr); gap:0; } }
`;

function h(type, props, ...children) { return React.createElement(type, props, ...children); }
const intentKey = intent => intent ? JSON.stringify([intent.space, intent.id]) : "";
const readable = value => value.replaceAll("-", " ");

function Status({ state }) {
  const kind = ["awaiting-approval", "revising"].includes(state) ? "blocked" : state === "in-progress" ? "active" : state;
  return h("span", { className: `ap-status${kind === "blocked" ? " ap-warning" : ""}` },
    h(icons[kind] ?? icons.pending, { size: 15, "aria-hidden": true }),
    state === "pending" ? "Remaining" : readable(state));
}

function IntentPicker({ state, send, id }) {
  const spaces = [...new Set(state.intents.map(intent => intent.space))];
  const selectedKey = intentKey(state.intent ?? state.view?.selected);
  return h("div", null, h("label", { htmlFor: id }, "Intent"),
    h("select", { id, value: selectedKey, onChange: event => {
      const intent = state.intents.find(item => intentKey(item) === event.target.value);
      if (intent) send({ type: "intent", intent });
    } }, h("option", { value: "", disabled: true }, "Choose an intent explicitly"),
    spaces.map(space => h("optgroup", { key: space, label: space },
      state.intents.filter(intent => intent.space === space).map(intent => h("option", {
        key: intentKey(intent), value: intentKey(intent), disabled: !intent.eligible,
      }, `${intent.displayName} · ${intent.id}${intent.eligible ? "" : ` — ${intent.reason ?? "not eligible"}`}`))))));
}

function BlockerSection({ title, items, project = false }) {
  return h("section", { className: "ap-panel" }, h("h2", null, title),
    project && h("p", { className: "ap-detail" }, "Project-wide observations; not attributed to the selected intent."),
    items.length ? h("ul", { className: "ap-blockers" }, items.map((item, index) => h("li", {
      key: `${item.kind}:${item.ref}:${index}`,
    }, readable(item.kind), " · ", h("span", { className: "ap-mono" }, item.ref))))
      : h("p", null, project ? "No project-level / unattributed blockers recorded." : "No selected-intent blockers recorded."));
}

function Overview({ selected }) {
  const blockers = partitionBlockers(selected);
  return h(React.Fragment, null,
    h("section", { className: "ap-overview" }, h("h2", null, selected.displayName),
      selected.description && h("p", null, selected.description),
      h("p", { className: "ap-detail" }, `${selected.space} · ${selected.id} · Scope: ${selected.scope ?? "not recorded"} · Status: ${selected.status ?? "not recorded"}`),
      h("p", { className: "ap-counts" }, `Stages completed ${selected.totals.completed}/${selected.totals.total} · skipped ${selected.totals.skipped}`),
      h("p", null, "Active stage: ", h("span", { className: "ap-mono" }, selected.activeStage ?? "None recorded"))),
    h("div", { className: "ap-columns" },
      h("section", { className: "ap-panel" }, h("h2", null, "Phases and stages"),
        selected.phases.map(phase => h("section", { className: "ap-phase", key: phase.name },
          h("div", { className: "ap-row" }, h("h3", null, readable(phase.name)), h(Status, { state: phase.status })),
          h("ul", { className: "ap-stage-list" }, phase.stages.map(stage => h("li", {
            key: stage.slug, className: "ap-stage", "data-active": stage.slug === selected.activeStage,
          }, h("div", { className: "ap-row" }, h("span", { className: "ap-mono" }, stage.slug), h(Status, { state: stage.state })),
          stage.gate && h("p", { className: "ap-detail" }, `Gate ${stage.gate.kind}${stage.gate.ageMs === undefined ? " · age not recorded" : ` · ${Math.floor(stage.gate.ageMs / 60000)} min at snapshot`}`))))))),
      h("div", null,
        h(BlockerSection, { title: "Selected-intent blockers", items: blockers.selected }),
        h(BlockerSection, { title: "Project-level / unattributed", items: blockers.project, project: true }))));
}

function Provenance({ backend, provider }) {
  const labels = combineLabels(backend, provider);
  return h("section", { className: "ap-panel ap-labels" }, h("h2", null, "Labels and provenance"),
    h("div", null, h("p", null, labels.recorded), h("p", { className: "ap-detail" }, `Source: ${labels.recordedSource}`)),
    h("div", null, h("p", null, labels.provider), h("p", { className: "ap-detail" }, `Source: ${labels.providerSource}`)),
    labels.conflict && h("p", { className: "ap-warning" }, "Conflict — recorded backend and provider labels disagree."),
    labels.codex && h("p", null, labels.codex),
    h("p", { className: "ap-detail" }, "Labels are observations, not execution authorization. Display does not admit Codex."));
}

export function ProgressBody({ state }) {
  const selected = state.view?.state === "ok" ? state.view.selected : null;
  const provider = state.view?.provider ?? state.error?.provider;
  return h(React.Fragment, null,
    selected && h(Overview, { selected }),
    h(Provenance, { backend: selected?.backend, provider }));
}

/** Remedies supplement, never replace, decoded diagnostics. This is display-only:
 * the route/decoder decisions and the reducer's retention rules remain the oracle.
 */
export function ErrorDetails({ error }) {
  const remedy = ["FORBIDDEN", "HTTP_401", "HTTP_403"].includes(error.code) ? ACCESS_REMEDY
    : ["INVALID_STAMP", "MATERIALIZATION_INVALID", "SDK_NOT_PERMITTED"].includes(error.code) ? SETUP_REMEDY : null;
  return h(React.Fragment, null,
    remedy && h("p", null, remedy),
    h("p", null, h("span", { className: "ap-mono" }, error.code), " · ", error.message));
}

/** Display oracle: the accepted view, read at render using ProgressBody's selected
 * predicate. An error without selected progress must not claim a stale snapshot.
 * No override. The live text depends only on the settled outcome, not the clock
 * or flight state, so countdown ticks and repeated outcomes stay silent.
 */
export function renderFooter({ state, now, send, disclosure = DISCLOSURE, attribution = false }) {
  const polls = planPolls(state, now);
  const error = state.error;
  const retainedProgress = state.view?.state === "ok" && state.view.selected;
  const refresh = state.hidden ? "refresh paused while hidden" : state.active === false ? "refresh paused while inactive"
    : state.inFlight ? "refreshing…" : `next refresh in ${polls.nextSeconds} s`;
  return h("footer", { className: "ap-panel" },
    h("p", { className: "ap-announcement", "aria-live": "polite", "aria-atomic": true },
      error ? "Progress could not be refreshed." : state.lastUpdated ? "Progress refreshed." : ""),
    h("div", { className: "ap-row" },
      h("div", null,
        h("p", null, "Last updated ", state.lastUpdated ? h("time", { dateTime: state.lastUpdated }, new Date(state.lastUpdated).toLocaleTimeString()) : "—", ` · ${refresh}`),
        error && h("p", { className: "ap-warning" }, retainedProgress
          ? "Showing the last successful snapshot; it may be out of date." : "No progress is displayed.")),
      h("button", { type: "button", disabled: state.inFlight, onClick: () => send({ type: "retry" }), "aria-label": "Retry progress refresh" }, "Retry")),
    h("p", { className: "ap-disclosure" }, disclosure),
    attribution && h("p", { className: "ap-disclosure" }, attribution));
}

export default function ProgressPage() {
  const api = useAppApi();
  const { mode } = useTheme();
  const { active } = useAppInfo();
  const [state, now, send] = useProgress(api, active);
  const id = React.useId();
  const error = state.error;
  return h("main", { className: "aidlc-progress", "data-mode": mode === "light" ? "light" : "dark" },
    h("style", null, CSS),
    h("div", { className: "ap-content" },
      h("header", null, h("p", { className: "ap-kicker" }, "Observe / AI-DLC"), h("h1", null, "AI-DLC progress"),
        h("p", null, "Stage counts and recorded blockers for a bound project. No workflow actions.")),
      h("div", { className: "ap-pickers" },
        h("div", null, h("label", { htmlFor: `${id}-project` }, "Project"),
          h("select", { id: `${id}-project`, value: state.projectId ?? "", disabled: !state.projects?.length,
            onChange: event => send({ type: "project", id: event.target.value }),
          }, h("option", { value: "", disabled: true }, state.projects === null ? "Loading bound projects…" : "No valid project selected"),
          (state.projects ?? []).map(project => h("option", { key: project.id, value: project.id, disabled: !project.stampValid },
            `${project.displayName} · ${project.id}${project.stampValid ? "" : " — missing or invalid project installation stamp"}`)))),
        state.intents.length > 0 && h(IntentPicker, { state, send, id: `${id}-intent` })),
      state.warnings.map(warning => h("p", { className: "ap-detail", key: warning.code }, `${warning.code}: ${warning.count} binding records ignored; nothing repaired.`)),
      error && h("section", { className: "ap-notice" },
        h("h2", null, error.error.code === "GUARD_UNAVAILABLE" ? GUARD_MESSAGE : error.state === "unavailable" ? "Progress unavailable" : "Progress could not be refreshed"),
        h(ErrorDetails, { error: error.error })),
      !error && state.projects === null && h("p", null, "Loading bound projects…"),
      state.projects?.length === 0 && h("p", { className: "ap-notice" }, NO_BOUND_PROJECTS),
      state.projects?.length > 0 && !state.projectId && h("p", { className: "ap-notice" }, SETUP_REMEDY, " No bound project has a valid project installation stamp. Disabled projects remain listed above."),
      !error && state.projectId && !state.view && h("p", null, "Loading selected progress…"),
      state.view?.state === "selection-required" && h("section", { className: "ap-notice" }, h("h2", null, "Choose an intent"), h("p", null, "Several intents are eligible. Select a space and intent above; no progress is shown until you choose.")),
      state.view?.state === "empty" && state.projectId && h("p", { className: "ap-notice" }, "No eligible intents in this project. No progress is available."),
      h(ProgressBody, { state }),
      h(renderFooter, { state, now, send })));
}
