import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import corpus from "../fixtures/kiro-crew/progress-payloads.json";
import panelCorpus from "../fixtures/kiro-crew/panel-payloads.json";
import { cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";

const PAGE = join(REPO_ROOT, "harness/kiro-crew/app/ui/index.mjs");
const PANEL = join(REPO_ROOT, "harness/kiro-crew/app/ui/panel.mjs");
const { DISCLOSURE, decodeProjects, decodeProgress, decodeSessionProgress, decodeSdkError, initialState, reduce, planPolls,
  partitionBlockers, combineLabels, progressPath, createPollScheduler, conversationReference } = await import(PAGE);
const projects = () => ({ schemaVersion: 1, projects: corpus.projects.map(({ boundAtHour, ...project }) => ({ ...project, boundAt: new Date(Date.UTC(2000, 0, 2, boundAtHour)).toISOString() })), warnings: [], disclosure: corpus.disclosure });
const progress = (state = "ok") => ({ schemaVersion: 1, state, generatedAt: new Date(Date.UTC(2000, 0, 2, 8)).toISOString(),
  project: { dir: REPO_ROOT, stamp: corpus.stamp }, intents: structuredClone(corpus.intents),
  ...(state === "ok" ? { selected: structuredClone(corpus.selected) } : {}), provider: corpus.provider, disclosure: corpus.disclosure });
const failed = () => decodeProgress(504, { error: { code: "READER_TIMEOUT", message: "Reader timed out" } });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function session(state = "ok") {
  const { eligible: _eligible, ...identity } = panelCorpus.intent;
  return { schemaVersion: 1, generatedAt: progress().generatedAt, state, disclosure: DISCLOSURE,
    conversationRef: digest(panelCorpus.sessionKey).slice(0, 8),
    ...(["ok", "census"].includes(state) ? { project: panelCorpus.project, bindingRevision: digest("example bindings\n").slice(0, 16), provider: panelCorpus.provider } : {}),
    ...(state === "ok" ? { selected: { ...structuredClone(corpus.selected), ...identity } } : {}),
    ...(state === "census" ? { census: [panelCorpus.intent] } : {}),
    ...(state === "unbound" ? { guidance: panelCorpus.guidance } : {}),
    ...(state === "unsupported" ? { reason: panelCorpus.reason } : {}) };
}
function refusal(row = panelCorpus.refusals[0]) {
  return { ...session(), state: row.state, error: { code: row.code, message: "Request refused" } };
}
function sessionGood() {
  return reduce(reduce(initialState(0, false, true, true), { type: "tick", now: 0 }),
    { type: "settle", generation: 0, now: 100, result: decodeSessionProgress(200, session()) });
}
function good() {
  const census = reduce(initialState(), { type: "census", generation: 0, now: 0, result: decodeProjects(200, projects()) });
  return reduce(reduce(census, { type: "tick", now: 0 }), { type: "settle", generation: 0, now: 100, result: decodeProgress(200, progress()) });
}

test("decoders admit project and progress unions without inventing selected progress", () => {
  expect(decodeProjects(200, projects()).state).toBe("ok");
  expect(decodeProjects(200, { ...projects(), projects: [] }).state).toBe("empty");
  for (const state of ["ok", "empty", "selection-required"]) {
    const result = decodeProgress(200, progress(state)); expect(result.state).toBe(state); expect(result.disclosure).toBe(DISCLOSURE);
    if (state === "ok") expect(result.selected.totals).toEqual({ completed: 1, total: 3, skipped: 0 }); else expect(result.selected).toBeUndefined();
  }
});

test("invalid progress schemas, nested fields and ineligible selected identities fail before rendering", () => {
  for (const body of [null, [], {}, "authentication required", { ...progress(), schemaVersion: 2 }, { ...progress(), provider: null },
    { ...progress(), disclosure: "missing" }, { ...progress(), intents: [null] }, { ...progress(), intents: corpus.intents.map((i) => ({ ...i, eligible: false })) },
    ...[{ phases: [null] }, { totals: { completed: 5, total: 3, skipped: 0 } }, { totals: { completed: -1, total: 3, skipped: 0 } },
      { blockers: [null] }, { backend: { asRecorded: {} } }, { description: {} }, { ledger: { outstanding: "1", settled: 0 } },
      { phases: [{ name: "work", status: "active", stages: [{ slug: "execute", state: "pending", gate: { kind: "[?]", ageMs: -1 } }] }] }]
      .map((patch) => ({ ...progress(), selected: { ...corpus.selected, ...patch } }))]) {
    const result = decodeProgress(200, body); expect(result.error.code).toBe("INVALID_RESPONSE"); expect(result.selected).toBeUndefined();
  }
});

test("project decoder refuses duplicates, malformed identities, timestamps and warning counts", () => {
  for (const body of [{ ...projects(), projects: [projects().projects[0], projects().projects[0]] },
    ...[{ id: "not-an-id" }, { boundAt: "invalid" }, { stampValid: 1 }, { providerLabel: "foreign" }].map((patch) => ({ ...projects(), projects: [{ ...projects().projects[0], ...patch }] })),
    { ...projects(), warnings: [{ code: "CORRUPT_BINDINGS", count: -1 }] }]) {
    expect(decodeProjects(200, body)).toMatchObject({ state: "error", error: { code: "INVALID_RESPONSE" } });
  }
});

test("HTTP refusals and SDK authentication, permission and network failures retain safe errors", () => {
  for (const [status, code] of [[400, "INVALID_QUERY"], [403, "FORBIDDEN"], [404, "UNKNOWN_PROJECT"], [409, "INVALID_STAMP"],
    [502, "READER_OUTPUT_OVERFLOW"], [502, "READER_MALFORMED"], [503, "GUARD_UNAVAILABLE"], [503, "MATERIALIZATION_INVALID"], [504, "READER_TIMEOUT"]] as const) {
    const body = { ...progress(), state: "error", error: { code, message: "Request refused" } };
    const decoded = decodeProgress(status, body);
    expect(decoded.error.code).toBe(code); expect(decoded.selected).toBeUndefined();
    expect(decodeSdkError(new Error(`API ${status}: ${JSON.stringify(body)}`), decodeProgress)).toEqual(decoded);
    expect(decodeProjects(status, body).error.code).toBe(code);
  }
  expect(decodeProgress(200, { ...progress(), state: "error", error: { code: "NEW_ERROR", message: "No snapshot" } }).selected).toBeUndefined();
  const html = decodeSdkError(new Error("API 403: <html>Sign in</html>"), decodeProjects);
  expect(html.error.code).toBe("HTTP_403"); expect(JSON.stringify(html)).not.toContain("<html>");
  expect(decodeSdkError(new Error("not permitted to access"), decodeProjects).error.code).toBe("SDK_NOT_PERMITTED");
  expect(decodeSdkError(new TypeError("Failed to fetch"), decodeProgress).error.code).toBe("REFRESH_FAILED");
});

test("selection URL encodes canonical space and identity rather than display name", () => {
  const path = progressPath(corpus.projects[0].id, { space: "design", id: "record:123", displayName: "must not be sent" });
  expect(path).toBe(`/api/apps/aidlc/progress?project=${corpus.projects[0].id}&space=design&intent=record%3A123`);
  expect(progressPath(corpus.projects[0].id, null)).toBe(`/api/apps/aidlc/progress?project=${corpus.projects[0].id}`);
});

test("visibility and retry never overlap an active request and queue an immediate refresh", () => {
  let state = reduce(initialState(), { type: "tick", now: 0 }); expect(state.inFlight).toBe(true);
  expect(reduce(state, { type: "tick", now: 10000 })).toBe(state);
  state = reduce(state, { type: "visibility", hidden: true, now: 1 }); expect(planPolls(state, 90000)).toMatchObject({ poll: false, paused: true });
  state = reduce(state, { type: "visibility", hidden: false, now: 2 }); state = reduce(state, { type: "retry", now: 3 });
  expect(state.immediate).toBe(true); expect(planPolls(state, 90000).poll).toBe(false);
  state = reduce(state, { type: "settle", generation: 0, now: 4, result: failed() }); expect(planPolls(state, 4).poll).toBe(true);
});

test("failed refreshes retain a stale last-good snapshot, bound backoff and recover to normal cadence", () => {
  let state = good(); const view = state.view; const updated = state.lastUpdated;
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    const now = state.nextAt; state = reduce(state, { type: "tick", now });
    state = reduce(state, { type: "settle", generation: 0, now, result: failed() });
    expect(state.nextAt - now).toBe(delay); expect(state.view).toBe(view); expect(state.lastUpdated).toBe(updated); expect(state.error.error.code).toBe("READER_TIMEOUT");
  }
  state = reduce(state, { type: "retry", now: 100000 }); expect(state.failures).toBe(0);
  state = reduce(state, { type: "tick", now: 100000 });
  state = reduce(state, { type: "settle", generation: 0, now: 100010, result: progress() });
  expect(state).toMatchObject({ failures: 0, error: null, inFlight: false, nextAt: 105010 });
  expect(planPolls(state, 100011).nextSeconds).toBe(5); expect(reduce(state, { type: "tick", now: 105009 })).toBe(state);
});

test("project census selects only valid stamps, preserves selection and clears removed data", () => {
  const body = projects(); body.projects.reverse();
  let state = reduce(initialState(), { type: "census", generation: 0, now: 0, result: body });
  expect(state.projectId).toBe(corpus.projects[0].id);
  body.projects.unshift({ ...projects().projects[0], id: "1111111111111111" });
  state = reduce(state, { type: "census", generation: 0, now: 1, result: body }); expect(state.projectId).toBe(corpus.projects[0].id);
  expect(reduce(state, { type: "project", id: corpus.projects[1].id, now: 2 })).toBe(state);
  for (const entries of [[], projects().projects.map((p) => ({ ...p, stampValid: false }))]) {
    expect(reduce(good(), { type: "census", generation: 0, now: 3, result: { projects: entries, warnings: [] } }))
      .toMatchObject({ projectId: null, intent: null, view: null, lastUpdated: null });
  }
});

test("project switch clears identity and data while a late response only releases its own lock", () => {
  const state = { ...good(), intent: { space: "main", id: "old" }, inFlight: true, requestGeneration: 0,
    projects: [...projects().projects, { ...projects().projects[0], id: "1111111111111111" }] };
  const switched = reduce(state, { type: "project", id: "1111111111111111", now: 200 });
  expect(switched).toMatchObject({ intent: null, intents: [], view: null, lastUpdated: null, inFlight: true });
  expect(planPolls(switched, 200).poll).toBe(false);
  expect(reduce(switched, { type: "census", generation: 0, now: 201, result: projects() })).toBe(switched);
  expect(reduce(switched, { type: "settle", generation: 99, now: 201, result: progress() })).toBe(switched);
  expect(reduce(switched, { type: "settle", generation: 0, now: 202, result: progress() })).toMatchObject({ view: null, intent: null, inFlight: false, nextAt: 202 });
});

test("intent switch suppresses late results from the same project without unlocking the request", () => {
  const state = { ...good(), inFlight: true, requestGeneration: 0 };
  const changed = reduce(state, { type: "intent", intent: corpus.intents[1], now: 200 });
  expect(changed).toMatchObject({ inFlight: true, view: null, lastUpdated: null });
  const settled = reduce(changed, { type: "settle", generation: 0, now: 201, result: progress() });
  expect(settled.view).toBeNull(); expect(settled.intent).toEqual({ space: "design", id: "record-b" }); expect(settled.inFlight).toBe(false);
});

test("selection-required keeps the grouped census and refuses ineligible intent choices", () => {
  const state = reduce({ ...good(), inFlight: true, requestGeneration: 0 }, { type: "settle", generation: 0, now: 6000, result: decodeProgress(200, progress("selection-required")) });
  expect(state.view.selected).toBeUndefined(); expect(state.intents.map((i: { space: string }) => i.space)).toEqual(["main", "design", "main"]);
  expect(reduce(state, { type: "intent", intent: corpus.intents[2], now: 6001 })).toBe(state);
  const next = reduce(state, { type: "intent", intent: corpus.intents[1], now: 6001 });
  expect(next.view).toBeNull(); expect(next.intent).toEqual({ space: "design", id: "record-b" }); expect(planPolls(next, 6001).poll).toBe(true);
});

test("selected and project-level blockers never merge even with identical references", () => {
  const selected = structuredClone(corpus.selected); selected.unattributedBlockers[0].ref = selected.blockers[0].ref;
  const result = partitionBlockers(selected); expect(result.selected).toEqual(selected.blockers); expect(result.project).toEqual(selected.unattributedBlockers);
  result.project.pop(); expect(selected.unattributedBlockers).toHaveLength(1); expect(partitionBlockers(null)).toEqual({ selected: [], project: [] });
});

test("provider and recorded backend labels expose conflicts and Codex provenance without admission", () => {
  expect(combineLabels(corpus.selected.backend, corpus.provider)).toMatchObject({ recorded: "Backend as recorded: kiro (not live identity)", recordedSource: "project-binding", providerSource: "crew-session-map", conflict: true, codex: "Codex-associated (source: crew-session-map)" });
  expect(combineLabels({ asRecorded: "codex", conflict: false, codexAssociated: { source: "project-binding (recorded, not live)" } }, corpus.provider).codex)
    .toBe("Codex-associated (source: project-binding (recorded, not live); crew-session-map)");
  expect(combineLabels(null, null)).toMatchObject({ conflict: false, codex: null });
  expect(combineLabels({ asRecorded: "claude", conflict: false }, { label: "claude", conflict: false })).toMatchObject({ conflict: false, codex: null });
  expect(combineLabels({ asRecorded: "unknown", conflict: true }, null).conflict).toBe(false);
  expect(combineLabels({ asRecorded: "unknown", conflict: true }, { label: "unknown", conflict: false }).conflict).toBe(false);
  expect(combineLabels(null, { label: "unknown", conflict: true }).conflict).toBe(false);
  expect(combineLabels({ asRecorded: "kiro", conflict: false }, { label: "unknown", conflict: false }).conflict).toBe(false);
});

// Only the host React/SDK/timer boundaries are faked in an isolated subprocess.
// Production components, effects, transport serialization and reducers run intact.
function component(scenario: string) {
  const root = createTestProject(); const script = join(root, "page-host.test.ts");
  try {
    writeFileSync(script, `import {mock} from 'bun:test';import assert from 'node:assert/strict';
const corpus=${JSON.stringify(corpus)};const panelCorpus=${JSON.stringify(panelCorpus)};const projects=()=>(${JSON.stringify(projects())});const progress=()=>(${JSON.stringify(progress())});
const session=state=>structuredClone(({ok:${JSON.stringify(session())},census:${JSON.stringify(session("census"))},unbound:${JSON.stringify(session("unbound"))},unsupported:${JSON.stringify(session("unsupported"))}})[state??'ok']);
let active;let cursor=0;let clock=1000;let timerId=0;const timers=new Map();const listeners=new Set();const calls=[];
Object.defineProperty(globalThis,'window',{value:{},configurable:true});
Object.defineProperty(globalThis,'document',{value:{hidden:false,addEventListener:(_n,f)=>listeners.add(f),removeEventListener:(_n,f)=>listeners.delete(f)},configurable:true});
Date.now=()=>clock;globalThis.setTimeout=(f)=>{timers.set(++timerId,f);return timerId;};globalThis.clearTimeout=id=>timers.delete(id);
const react={Fragment:'fragment',createElement:(type,props,...children)=>typeof type==='function'?type({...props,children}):({type,props:props??{},children}),
useState:initial=>{const i=cursor++;const owner=active;if(!(i in owner.slots))owner.slots[i]=typeof initial==='function'?initial():initial;return [owner.slots[i],value=>owner.slots[i]=value];},
useRef:initial=>{const i=cursor++;return active.slots[i]??=({current:initial});},useEffect:(effect,deps)=>{const i=cursor++;if(!active.effects[i]||deps.some((dep,j)=>dep!==active.effects[i].deps[j]))active.pending.push({i,effect,deps});},useId:()=> 'progress'};
mock.module('react',()=>({...react,default:react}));
mock.module('@kirocrew/app-sdk',()=>({useAppApi:()=>active.api,useAppInfo:()=>({active:active.hostActive}),useTheme:()=>({mode:active.mode})}));
mock.module('lucide-react',()=>Object.fromEntries(['Check','Loader2','Clock','ArrowRight','AlertTriangle'].map(n=>[n,()=>null])));
const {default:Page,ATTRIBUTION,DISCLOSURE}=await import(${JSON.stringify(PAGE)});const {default:Panel}=await import(${JSON.stringify(PANEL)});
function render(owner){active=owner;cursor=0;owner.pending=[];return owner.Component();}
function commit(owner){for(const {i,effect,deps} of owner.pending){owner.effects[i]?.cleanup?.();owner.effects[i]={effect,deps,cleanup:effect()};}owner.pending=[];}
function mount(Component=Page,hostActive=true,mode='light'){const owner={Component,hostActive,mode,slots:[],effects:[],pending:[]};owner.api={get:(...args)=>new Promise((resolve,reject)=>calls.push({owner,args,path:args[0],resolve,reject}))};owner.stop=()=>{for(const e of owner.effects)e?.cleanup?.();};render(owner);commit(owner);return owner;}
function replay(owner){owner.stop();owner.effects=[];render(owner);commit(owner);}
function activity(owner,value){owner.hostActive=value;render(owner);commit(owner);}
function pump(){const ready=[...timers.values()];timers.clear();for(const f of ready)f();}
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.children)]:[];
const text=value=>Array.isArray(value)?value.map(text).join(' '):value&&typeof value==='object'?text(value.children):typeof value==='string'?value:'';
const announcements=tree=>nodes(tree).filter(n=>n.props['aria-live']==='polite'||n.props.role==='status').map(text);
const stale='Showing the last successful snapshot; it may be out of date.';
const noProgress='No progress is displayed.';
const accessRemedy='Access denied. Use an authenticated owner dashboard session and check that AI-DLC is enabled, then retry.';
const setupRemedy='Project setup needs attention. Rerun project setup and doctor, then retry.';
const persistentFailures=[
 {code:'FORBIDDEN',status:403,remedy:accessRemedy},
 {code:'HTTP_401',status:401,html:true,remedy:accessRemedy},
 {code:'HTTP_403',status:403,html:true,remedy:accessRemedy},
 {code:'INVALID_STAMP',status:409,remedy:setupRemedy},
 {code:'MATERIALIZATION_INVALID',status:503,remedy:setupRemedy},
 {code:'SDK_NOT_PERMITTED',sdk:true,remedy:setupRemedy},
 {code:'NEW_ERROR',status:502,remedy:'A different diagnostic.'},
];
function rejectRefresh(call,row){call.reject(new Error(row.sdk?'not permitted to access':
 'API '+row.status+': '+(row.html?'<html>Sign in</html>':JSON.stringify({error:{code:row.code,message:'A different diagnostic.'}}))));}
function select(owner,index,value){nodes(render(owner)).filter(n=>n.type==='select')[index].props.onChange({target:{value}});}
function retry(owner){nodes(render(owner)).find(n=>n.type==='button').props.onClick();}
${scenario}
assert.equal(listeners.size,0);assert.equal(timers.size,0);console.log('page behavior passed');`);
    const result = spawnSync(process.execPath, ["test", script], { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0); expect(result.stdout.split("\n")).toContain("page behavior passed");
  } finally { cleanupTestProject(root); }
}

test("rendered page disables invalid stamps and marks retained progress stale until retry succeeds", () => component(`
const owner=mount();assert.deepEqual(announcements(render(owner)),['']);await flush();assert.equal(calls.length,1);calls[0].resolve(projects());await flush();assert.equal(calls.length,2);calls[1].resolve(progress());await flush();
let tree=render(owner);assert(text(tree).includes(corpus.disclosure));assert(text(tree).includes('Stages completed 1/3'));assert(text(tree).includes('Labels are observations, not execution authorization'));
assert(nodes(tree).find(n=>n.type==='option'&&n.props.value===corpus.projects[1].id).props.disabled);
assert.deepEqual(announcements(tree),['Progress refreshed.']);assert(text(tree).includes('next refresh in 5 s'));
clock+=1000;pump();await flush();tree=render(owner);assert(text(tree).includes('next refresh in 4 s'));assert.deepEqual(announcements(tree),['Progress refreshed.']);
retry(owner);await flush();calls[2].reject(new Error('API 504: '+JSON.stringify({error:{code:'READER_TIMEOUT',message:'Reader timed out'}})));await flush();
tree=render(owner);assert(text(tree).includes(stale));assert(!text(tree).includes(noProgress));assert(text(tree).includes('Stages completed 1/3'));
assert.deepEqual(announcements(tree),['Progress could not be refreshed.']);
clock+=1000;pump();await flush();assert(text(render(owner)).includes('next refresh in 4 s'));assert.deepEqual(announcements(render(owner)),['Progress could not be refreshed.']);
retry(owner);assert.deepEqual(announcements(render(owner)),['Progress could not be refreshed.']);await flush();calls[3].resolve(projects());await flush();calls[4].resolve(progress());await flush();
tree=render(owner);assert(!text(tree).includes(stale));assert(!text(tree).includes(noProgress));assert.deepEqual(announcements(tree),['Progress refreshed.']);
retry(owner);assert.deepEqual(announcements(render(owner)),['Progress refreshed.']);await flush();calls[5].resolve(projects());await flush();
calls[6].resolve({...progress(),generatedAt:new Date(clock+1000).toISOString()});await flush();assert.deepEqual(announcements(render(owner)),['Progress refreshed.']);owner.stop();
`));

test("rendered page keeps persistent refusal codes visible with actionable remedies and no invented snapshot", () => component(`
for(const row of persistentFailures){const owner=mount();await flush();rejectRefresh(calls.at(-1),row);await flush();
 for(let attempt=0;attempt<2;attempt++){const tree=render(owner);assert(text(tree).includes(row.remedy));
  assert(nodes(tree).some(n=>n.props.className==='ap-mono'&&text(n)===row.code));assert(text(tree).includes(noProgress));assert(!text(tree).includes(stale));assert(!text(tree).includes('Stages completed'));
  assert(!text(tree).includes('<html>'));assert.deepEqual(announcements(tree),['Progress could not be refreshed.']);
  if(attempt===0){retry(owner);await flush();rejectRefresh(calls.at(-1),row);await flush();}}
 owner.stop();}
`));

test("rendered page explains empty bindings and invalid stamps without marking non-progress views stale", () => component(`
for(const kind of ['no-projects','invalid-stamps','empty','selection-required']){const owner=mount();await flush();const census=projects();
 if(kind==='no-projects')census.projects=[];
 if(kind==='invalid-stamps')census.projects=census.projects.map(p=>({...p,stampValid:false}));
 const before=calls.length;calls.at(-1).resolve(census);await flush();
 if(['empty','selection-required'].includes(kind)){const body=progress();body.state=kind;delete body.selected;calls.at(-1).resolve(body);await flush();}
 else assert.equal(calls.length,before);
 let tree=render(owner);assert(!text(tree).includes('Stages completed'));
 if(kind==='no-projects')assert(text(tree).includes('No bound projects. Select your configured project in a new dashboard chat and message aidlc-crew; its first status call binds the project.'));
 if(kind==='invalid-stamps'){assert(text(tree).includes(setupRemedy));for(const project of census.projects)assert(nodes(tree).find(n=>n.type==='option'&&n.props.value===project.id).props.disabled);}
 retry(owner);await flush();rejectRefresh(calls.at(-1),persistentFailures[0]);await flush();tree=render(owner);
 assert(text(tree).includes(noProgress));assert(!text(tree).includes(stale));assert(!text(tree).includes('last good snapshot'));assert(!text(tree).includes('Stages completed'));owner.stop();}
`));

test("effect replay serializes whole refreshes and removes listeners without publishing stale data", () => component(`
const owner=mount();await flush();assert.equal(calls.length,1);replay(owner);await flush();assert.equal(calls.length,1);
calls[0].resolve(projects());await flush();assert.equal(calls.length,1);pump();await flush();assert.equal(calls.length,2);assert.equal(calls[1].path,'/api/apps/aidlc/projects');assert(!text(render(owner)).includes('Stages completed'));
calls[1].resolve(projects());await flush();assert.equal(calls.length,3);document.hidden=true;for(const f of listeners)f();calls[2].resolve(progress());await flush();
assert(text(render(owner)).includes('refresh paused'));assert.equal(calls.length,3);document.hidden=false;for(const f of listeners)f();await flush();assert.equal(calls.length,4);
owner.stop();calls[3].resolve(projects());await flush();assert.equal(calls.length,4);
`));

test("explicit selection clears rendered data and refuses a mismatched selected response", () => component(`
const owner=mount();await flush();calls[0].resolve(projects());await flush();calls[1].resolve(progress());await flush();
select(owner,1,JSON.stringify(['design','record-b']));assert(!text(render(owner)).includes('Stages completed'));await flush();calls[2].resolve(projects());await flush();
assert(calls[3].path.endsWith('&space=design&intent=record-b'));calls[3].resolve(progress());await flush();assert(text(render(owner)).includes('SELECTION_MISMATCH'));assert(!text(render(owner)).includes('Stages completed'));
retry(owner);await flush();calls[4].resolve(projects());await flush();const matching=progress();matching.selected={...matching.selected,space:'design',id:'record-b'};calls[5].resolve(matching);await flush();assert(text(render(owner)).includes('Stages completed 1/3'));owner.stop();
`));

test("session decoder admits its union and preserves refusal diagnostics without publishing selected progress", () => {
  for (const state of ["ok", "census", "unbound", "unsupported"]) {
    const body = session(state); const decoded = decodeSessionProgress(200, body);
    expect(decoded.state).toBe(state); expect(decoded.disclosure).toBe(DISCLOSURE);
    expect(decoded.conversationRef).toBe(body.conversationRef);
    if (state === "ok") expect(decoded.selected).toEqual(body.selected);
    else expect(decoded.selected).toBeUndefined();
    if (state === "census") expect(decoded.census).toEqual(body.census);
    if (state === "unbound") expect(decoded.guidance).toBe(body.guidance);
    if (state === "unsupported") expect(decoded.reason).toBe(body.reason);
  }
  for (const row of panelCorpus.refusals) {
    const body = refusal(row); const decoded = decodeSessionProgress(row.status, body);
    expect(decoded).toMatchObject({ state: row.state, httpStatus: row.status, error: body.error,
      provider: body.provider, bindingRevision: body.bindingRevision, conversationRef: body.conversationRef });
    expect(decoded.selected).toBeUndefined();
    expect(decodeSdkError(new Error(`API ${row.status}: ${JSON.stringify(body)}`), decodeSessionProgress)).toEqual(decoded);
  }
});

test("malformed session success and non-ok selected injection fail closed while malformed references are discarded", () => {
  for (const body of [null, [], {}, "sign in",
    ...[{ schemaVersion: 2 }, { disclosure: "wrong" }, { generatedAt: "invalid" }, { state: "future" },
      { bindingRevision: undefined }, { bindingRevision: "not-a-revision" }, { project: { stampValid: false } }, { provider: null },
      { selected: { ...session().selected, space: null } }, { selected: { ...session().selected, phases: [null] } },
      { selected: { ...session().selected, totals: { completed: 4, total: 3, skipped: 0 } } }].map((patch) => ({ ...session(), ...patch })),
    { ...session("census"), census: [null] }, { ...session("unbound"), guidance: {} }, { ...session("unsupported"), reason: [] },
    ...["census", "unbound", "unsupported"].map((state) => ({ ...session(state), selected: session().selected }))]) {
    const result = decodeSessionProgress(200, body);
    expect(result.error.code).toBe("INVALID_RESPONSE"); expect(result.selected).toBeUndefined(); expect(result.conversationRef).toBeUndefined();
  }
  for (const [status, body] of [[200, session()], [503, refusal()]] as const) {
    for (const conversationRef of [undefined, null, 12345678, {}, [], "", "abcdefg0", "ABCDEF01", "abcdef0", "abcdef012", "abcdef01\n", "abcdef01\r", "abcdef01\u2028", "a".repeat(64)]) {
      expect(decodeSessionProgress(status, { ...body, conversationRef }).conversationRef).toBeUndefined();
    }
    expect(decodeSessionProgress(status, body).conversationRef).toBe(body.conversationRef);
  }
});

test("exact-session provider absence and unknown observations are not conflicts or execution authority", () => {
  for (const present of [false, true]) {
    const body = { ...session(), provider: { ...panelCorpus.provider, label: "unknown", present, conflict: true } };
    const decoded = decodeSessionProgress(200, body); expect(decoded.selected).toEqual(body.selected);
    expect(combineLabels({ asRecorded: "kiro", conflict: true }, decoded.provider)).toMatchObject({
      provider: "Crew provider (session map): not currently recorded", providerSource: "crew-session-map", conflict: false,
    });
  }
  for (const [recorded, conflict] of [["kiro", true], ["claude", true], ["codex", false], ["unknown", false], [null, false]] as const) {
    const labels = combineLabels({ asRecorded: recorded, conflict: true }, panelCorpus.provider);
    expect(labels.conflict).toBe(conflict); expect(labels.codex).toContain("crew-session-map");
  }
  expect(combineLabels({ asRecorded: "kiro" }, { ...panelCorpus.provider, present: false }).conflict).toBe(false);
  expect(combineLabels({ asRecorded: "codex" }, { label: "unknown", present: false }).codex).toContain("project-binding (recorded, not live)");
});

test("session revision changes and every non-ok result invalidate selection, including same-revision refusals", () => {
  const original = sessionGood(); const nextRevision = digest("changed binding\n").slice(0, 16);
  const settle = (result: unknown) => reduce({ ...original, intent: panelCorpus.intent, intents: [panelCorpus.intent], inFlight: true, requestGeneration: 0 },
    { type: "settle", generation: 0, now: 6000, result });
  for (const row of panelCorpus.refusals) {
    for (const bindingRevision of [undefined, original.bindingRevision, nextRevision]) {
      const result = decodeSessionProgress(row.status, { ...refusal(row), bindingRevision });
      expect(settle(result)).toMatchObject({ view: null, intent: null, intents: [], lastUpdated: null, error: result });
    }
  }
  for (const state of ["census", "unbound", "unsupported"]) {
    const result = settle(decodeSessionProgress(200, session(state)));
    expect(result.view.selected).toBeUndefined(); expect(result.intent).toBeNull(); expect(result.intents).toEqual([]);
  }
  const body = { ...session(), bindingRevision: nextRevision, selected: { ...session().selected, id: "new-record", blockers: [] } };
  const changed = settle(decodeSessionProgress(200, body)); expect(changed.view.selected).toEqual(body.selected);
  expect(changed.bindingRevision).toBe(nextRevision); expect(changed.intent).toBeNull(); expect(changed.intents).toEqual([]);
  const refused = settle(decodeSessionProgress(200, { ...refusal(), bindingRevision: nextRevision }));
  const recovered = reduce(reduce(refused, { type: "tick", now: refused.nextAt }),
    { type: "settle", generation: 0, now: refused.nextAt, result: decodeSessionProgress(200, body) });
  expect(recovered.error).toBeNull(); expect(recovered.view.selected).toEqual(body.selected);
});

test("conversation references belong only to the settled result and never survive SDK or no-reference failures", () => {
  expect(conversationReference(initialState(0, false, true, true))).toBeUndefined();
  const original = sessionGood(); expect(conversationReference(original)).toBe(session().conversationRef);
  expect(conversationReference({ ...original, inFlight: true })).toBeUndefined();
  const nextRef = digest("dashboard:other-example").slice(0, 8);
  for (const row of panelCorpus.refusals) {
    for (const conversationRef of [nextRef, undefined]) {
      const result = decodeSessionProgress(row.status, { ...refusal(row), conversationRef });
      const state = reduce({ ...original, inFlight: true, requestGeneration: 0 }, { type: "settle", generation: 0, now: 6000, result });
      expect(conversationReference(state)).toBe(conversationRef); expect(state.view).toBeNull();
    }
  }
  for (const [error, code] of [[new TypeError("Failed to fetch"), "REFRESH_FAILED"], [new Error("not permitted to access"), "SDK_NOT_PERMITTED"],
    [new Error("API 403: <html>private sign in</html>"), "HTTP_403"]] as const) {
    const result = decodeSdkError(error, decodeSessionProgress);
    const state = reduce({ ...original, inFlight: true, requestGeneration: 0 }, { type: "settle", generation: 0, now: 6000, result });
    expect(state.view).toBeNull(); expect(conversationReference(state)).toBeUndefined(); expect(result.error.code).toBe(code);
    expect(JSON.stringify(state)).not.toContain("private sign in");
  }
});

test("two production schedulers settle independent conversations without sharing a flight or attribution", async () => {
  let calls = 0;
  const responseA = Promise.withResolvers<unknown>(); const responseB = Promise.withResolvers<unknown>();
  const first = createPollScheduler(() => { calls++; return responseA.promise; }, { now: () => 0, session: true });
  const second = createPollScheduler(() => { calls++; return responseB.promise; }, { now: () => 0, session: true });
  const a = first.tick(); const b = second.tick(); expect(calls).toBe(2);
  expect(first.tick()).toBeUndefined(); expect(second.tick()).toBeUndefined();
  const other = { ...session(), conversationRef: digest("dashboard:second-example").slice(0, 8),
    bindingRevision: digest("second binding").slice(0, 16), selected: { ...session().selected, id: "second-intent" } };
  responseB.resolve(decodeSessionProgress(200, other)); await b;
  expect(first.getState().inFlight).toBe(true); expect(second.getState().view.selected.id).toBe("second-intent");
  expect(conversationReference(first.getState())).toBeUndefined(); expect(conversationReference(second.getState())).toBe(other.conversationRef);
  responseA.resolve(decodeSessionProgress(200, session())); await a;
  expect(first.getState().view.selected.id).toBe(panelCorpus.intent.id);
  expect(conversationReference(first.getState())).toBe(session().conversationRef); expect(conversationReference(second.getState())).toBe(other.conversationRef);
  expect(first.getState().view.project).toEqual(second.getState().view.project);
});

test("scheduler backoff and host pauses stay per instance and resume cannot unlock a pending flight", async () => {
  let now = 0; let otherCalls = 0;
  const first = createPollScheduler(() => decodeSessionProgress(503, refusal(panelCorpus.refusals[7])), { now: () => now, session: true });
  const second = createPollScheduler(() => { otherCalls++; return decodeSessionProgress(200, session()); }, { now: () => now, session: true });
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    await first.tick(); await second.tick();
    expect(first.getState().nextAt - now).toBe(delay); expect(second.getState().nextAt - now).toBe(5000);
    now = first.getState().nextAt;
  }
  first.send({ type: "activity", active: false }); expect(first.tick()).toBeUndefined();
  await second.tick(); expect(otherCalls).toBe(7);
  const response = Promise.withResolvers<unknown>(); let calls = 0;
  const pending = createPollScheduler(() => { calls++; return response.promise; }, { now: () => now, active: false, hidden: true, session: true });
  expect(pending.tick()).toBeUndefined(); pending.send({ type: "activity", active: true }); expect(pending.tick()).toBeUndefined();
  pending.send({ type: "visibility", hidden: false }); const flight = pending.tick(); expect(calls).toBe(1);
  pending.send({ type: "activity", active: false }); pending.send({ type: "activity", active: true }); pending.send({ type: "retry" });
  expect(pending.tick()).toBeUndefined(); expect(pending.getState().immediate).toBe(true);
  response.resolve(decodeSessionProgress(200, session())); await flight;
  expect(planPolls(pending.getState(), now).poll).toBe(true); expect(calls).toBe(1);
});

test("scheduler stop and restart invalidate publication but hold the request lock until settlement", async () => {
  let calls = 0; const published: unknown[] = []; const response = Promise.withResolvers<unknown>();
  const scheduler = createPollScheduler(() => { calls++; return response.promise; }, { now: () => 0, session: true });
  scheduler.start((state: unknown) => published.push(state)); const pending = scheduler.tick();
  scheduler.stop(); expect(scheduler.tick()).toBeUndefined(); scheduler.start((state: unknown) => published.push(state));
  expect(scheduler.tick()).toBeUndefined(); expect(calls).toBe(1);
  response.resolve(decodeSessionProgress(200, session())); await pending;
  expect(scheduler.getState()).toMatchObject({ view: null, inFlight: false, nextAt: 0 });
  expect(published.every((state) => !(state as { view: unknown }).view)).toBe(true);
  await scheduler.tick(); expect(calls).toBe(2); expect(scheduler.getState().view.selected.id).toBe(panelCorpus.intent.id);
});

test("rendered panel fills its block host while the page keeps its shared flex scroller", () => component(`
for(const Component of [Panel,Page]){const owner=mount(Component,false);const tree=render(owner);
 assert.equal(tree.type,'main');assert.equal(tree.props.className,'aidlc-progress');
 if(Component===Panel)assert.deepEqual(tree.props.style,{height:'100%',boxSizing:'border-box'});
 else{assert.equal(tree.props.style?.height,undefined);assert.equal(tree.props.style?.boxSizing,undefined);}
 const css=text(nodes(tree).find(n=>n.type==='style'));const declarations=css.slice(css.indexOf('{')+1,css.indexOf('}')).split(';').map(d=>d.trim());
 assert(declarations.includes('overflow:auto'));assert(declarations.includes('min-height:0'));assert(declarations.includes('flex:1'));
 assert(!declarations.some(d=>d.startsWith('height:')));owner.stop();}
`));

test("rendered panel uses one SDK GET, shared accessible rendering and only settled conversation references", () => component(`
const owner=mount(Panel,true,'dark');await flush();assert.deepEqual(calls[0].args,['/api/apps/aidlc/session-progress']);
assert.equal(nodes(render(owner)).find(n=>n.type==='h1').children[0],'Conversation progress');assert(!text(render(owner)).includes('Conversation '+session().conversationRef));
calls[0].resolve(session());await flush();let tree=render(owner);assert.equal(tree.props['data-mode'],'dark');
assert(text(tree).includes('Conversation '+session().conversationRef));assert(text(tree).includes(ATTRIBUTION));assert(text(tree).includes(DISCLOSURE));
assert(text(tree).includes('Stages completed 1/3'));assert(text(tree).includes('Selected-intent blockers'));assert(text(tree).includes('Project-level / unattributed'));
assert(text(tree).includes('Codex-associated'));assert(text(tree).includes('not execution authorization'));assert.equal(nodes(tree).filter(n=>n.type==='select'||n.type==='a').length,0);
const buttons=nodes(tree).filter(n=>n.type==='button');assert.equal(buttons.length,1);assert.equal(buttons[0].props.type,'button');assert(buttons[0].props['aria-label']);
assert(nodes(tree).some(n=>n.props['aria-live']==='polite'));retry(owner);assert(nodes(render(owner)).find(n=>n.type==='button').props.disabled);
assert(!text(render(owner)).includes('Conversation '+session().conversationRef));await flush();calls[1].reject(new TypeError('Failed to fetch'));await flush();
tree=render(owner);assert(text(tree).includes('REFRESH_FAILED'));assert(!text(tree).includes('Stages completed'));assert(!text(tree).includes('Conversation '+session().conversationRef));
assert(text(tree).includes(noProgress));assert(!text(tree).includes(stale));assert.deepEqual(announcements(tree),['Progress could not be refreshed.']);
retry(owner);await flush();calls[2].resolve(session());await flush();assert(text(render(owner)).includes('Conversation '+session().conversationRef));owner.stop();
`));

test("rendered panel shares refusal remedies and silent countdowns but clears progress instead of showing stale data", () => component(`
for(const row of persistentFailures){const owner=mount(Panel);await flush();rejectRefresh(calls.at(-1),row);await flush();
 let tree=render(owner);assert(text(tree).includes(noProgress));assert(!text(tree).includes(stale));assert(text(tree).includes(row.remedy));
 retry(owner);await flush();calls.at(-1).resolve(session());await flush();tree=render(owner);
 assert(text(tree).includes('Stages completed 1/3'));assert.deepEqual(announcements(tree),['Progress refreshed.']);assert(text(tree).includes('next refresh in 5 s'));
 clock+=1000;pump();await flush();tree=render(owner);assert(text(tree).includes('next refresh in 4 s'));assert.deepEqual(announcements(tree),['Progress refreshed.']);
 retry(owner);await flush();rejectRefresh(calls.at(-1),row);await flush();tree=render(owner);
 assert(text(tree).includes(row.remedy));assert(nodes(tree).some(n=>n.props.className==='ap-mono'&&text(n)===row.code));
 assert(text(tree).includes(noProgress));assert(!text(tree).includes(stale));assert(!text(tree).includes('Stages completed'));assert(text(tree).includes(ATTRIBUTION));assert(text(tree).includes(DISCLOSURE));
 assert.deepEqual(announcements(tree),['Progress could not be refreshed.']);clock+=1000;pump();await flush();assert.deepEqual(announcements(render(owner)),['Progress could not be refreshed.']);owner.stop();}
`));

test("rendered census, unbound and unsupported states never expose selection or retain earlier progress", () => component(`
const owner=mount(Panel);await flush();calls[0].resolve(session());await flush();
const census=session('census');census.census.push({space:'other',id:'done',displayName:'Done',eligible:false,reason:'completed'});
for(const body of [census,session('unbound'),session('unsupported')]){retry(owner);await flush();calls.at(-1).resolve(body);await flush();const tree=render(owner);
 assert(!text(tree).includes('Stages completed'));assert.equal(nodes(tree).filter(n=>n.type==='select').length,0);assert(text(tree).includes(ATTRIBUTION));
 if(body.state==='census'){assert.deepEqual(nodes(tree).filter(n=>n.type==='h3').map(n=>text(n)),['non-default','other']);assert(text(tree).includes('completed'));}
 if(body.state==='unbound'){assert(text(tree).includes(body.guidance));assert(!text(tree).includes('Labels and provenance'));}
 if(body.state==='unsupported'){assert(text(tree).includes(body.reason));assert(text(tree).includes('unsupported'));}}
retry(owner);await flush();calls.at(-1).resolve({...session(),state:'unavailable',error:{code:'BINDING_CHANGED',message:'Binding changed'}});await flush();
assert(text(render(owner)).includes('Conversation binding changed'));assert(!text(render(owner)).includes('Stages completed'));owner.stop();
`));

test("mounted panels poll independently of the page and of a sibling inactive or unfinished request", () => component(`
const first=mount(Panel);const second=mount(Panel,false);const page=mount();await flush();assert.equal(calls.length,2);
assert.deepEqual(calls.map(c=>c.path),['/api/apps/aidlc/session-progress','/api/apps/aidlc/projects']);
activity(second,true);await flush();assert.equal(calls.length,3);assert.equal(calls[2].owner,second);
const body=session();body.selected.id='second-intent';body.conversationRef='abcdef01';calls[2].resolve(body);await flush();
assert(text(render(second)).includes('second-intent'));assert(!text(render(first)).includes('second-intent'));
calls[1].resolve(projects());await flush();assert.equal(calls[3].owner,page);calls[3].resolve(progress());await flush();
activity(second,false);clock+=5000;pump();await flush();assert.equal(calls.length,5);assert.equal(calls[4].owner,page);
first.stop();second.stop();page.stop();calls[0].resolve(session());calls[4].resolve(projects());await flush();assert.equal(calls.length,5);
`));

test("page continuation checks latest visibility and host activity before its second GET even before effects commit", () => component(`
for(const pause of ['hidden','inactive']){document.hidden=false;const owner=mount();await flush();const before=calls.length;
 if(pause==='hidden')document.hidden=true;else{owner.hostActive=false;render(owner);}
 calls.at(-1).resolve(projects());await flush();assert.equal(calls.length,before);
 if(pause==='hidden'){document.hidden=false;for(const f of listeners)f();}else{commit(owner);activity(owner,true);}
 await flush();assert.equal(calls.length,before+1);calls.at(-1).resolve(projects());await flush();assert.equal(calls.length,before+2);
 calls.at(-1).resolve(progress());await flush();assert(text(render(owner)).includes('Stages completed'));owner.stop();}
`));
