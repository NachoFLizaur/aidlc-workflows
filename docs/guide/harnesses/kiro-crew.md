# AI-DLC on Kiro Crew

Kiro Crew runs AI-DLC through a dashboard conversation. The App Kit supplies
the `aidlc-crew` conductor, role agents, hooks, and an MCP bridge. The selected
project holds the same deterministic engine and workflow records used by the
other harnesses; the App Kit is not a second engine.

Message **aidlc-crew** in plain text. Shared `/aidlc …` examples mean messages
to that agent, not native Crew slash commands. Project setup, app trust,
registration, and hook activation are separate steps.

## Backends

**Kiro CLI is the default supported backend.** Crew is the host; the backend
supplies the model session. **Claude Code has limited support** for conductor
and distinct-directory child sessions; read [its operating limits](#claude-code-backend)
before starting. **[Codex is not supported as a Crew backend](#codex-backend)**;
the native Codex CLI harness is unaffected. Other backends and Slack are not supported here.

Configure and authenticate the backend through Crew. `agent.acp_backend`
selects the global backend; `agent.member_acp_backend` is a separate member-DM
setting, not child selection. Setup and doctor never switch either setting,
grant model access, or pin a model. Configuration alone does not verify a child.

This is separate from running [AI-DLC directly on Kiro CLI](kiro-cli.md).
Use the Crew instructions below for a dashboard workflow, not the direct-CLI
agent installation instructions.

## Prerequisites

- **Kiro Crew ≥0.6.0**, with `kirocrew` available on PATH and an interactive
  dashboard session in which you can select a project and agent.
- **Bun on PATH** for setup. Setup pins its absolute Bun executable into the
  registered hooks and MCP command. The bridge and hook entry still require
  Bun when the native `aidlc` executable is installed.
- **An authenticated backend** with access to your chosen model: Kiro CLI, or
  Claude Code CLI with `@agentclientprotocol/claude-agent-acp` and **Node ≥22**
  available to Crew. The adapter uses `CLAUDE_AGENT_ACP_BIN` or PATH.
  Keep the same Crew and Kiro homes for installation and dashboard use.
  A dedicated `KIROCREW_HOME` isolates Crew state, not Claude's login or
  ambient `~/.claude` settings, plugins, MCP configuration, and session state.
  A clean project does not isolate those user-level settings.
- **An existing project** and the complete `runtime/kiro-crew/` distribution
  from a versioned release. Keep the extracted package at a stable path.
  Framework developers may use a generated `dist/kiro-crew/` instead.
- **Permission to review and trust the local App Kit.** Only the operator
  grants trust; neither setup nor the conductor grants it on your behalf.

On a managed machine, hooks and the bridge launch interpreter processes under
Crew. If endpoint security interrupts them, inspect its diagnostics with your
administrator. Do not disable protection to make the integration run.

## Layout: App Kit and project

The default Crew home is `~/.kiro/crew`; `KIROCREW_HOME` selects another home.
The engine and the host shell have different owners:

| Location | Contents |
| --- | --- |
| `$KIROCREW_HOME/apps/aidlc/` | Registered App Kit: agents, resources, setup, hooks, launcher, MCP bridge, progress page, and gateway routes |
| `your-project/.kiro-crew/` | Engine, adapter, personas, protocols, skills, tools, and install metadata |
| `your-project/.kiro-crew/AGENTS.md` | Internal onboarding, explicitly read by the conductor; not a root instruction file |
| `your-project/aidlc/` | Shared spaces, intents, memory, and workflow records |
| `$KIROCREW_HOME/apps/aidlc/data/bindings/` | Local conversation-to-project routing |

Crew registers the conductor as `aidlc-crew`. The App Kit's `role-map.json`
maps engine persona names to `aidlc-crew-<role>-agent` dispatch names. Installed
agent filenames such as `aidlc--aidlc-crew.json` are not dispatch names.

Keep routing files private to trusted local writers. A binding selects a
project; it does not grant app trust or permission to work in that directory.

## Install and verify

Download and extract the release's copy runtime as described in
[Install and Lifecycle](../18-install-and-lifecycle.md#copy-channel).
Set these variables to your existing project and extracted runtime:

```bash
PROJECT="$HOME/projects/my-project"
RUNTIME="$HOME/aidlc-runtime/runtime/kiro-crew"
export KIROCREW_HOME="${KIROCREW_HOME:-$HOME/.kiro/crew}"
export KIRO_HOME="$KIROCREW_HOME/kiro"
CREW_HOME="$KIROCREW_HOME"
SETUP="$RUNTIME/kiro-crew-app/setup/aidlc-kiro-crew-setup.ts"
```

For a source build, set `RUNTIME` to the generated `dist/kiro-crew/` directory.
For a native install, use the matching installed runtime's App Kit and the
`--native` alternative in step 1. Keep App Kit and project versions aligned.

### 1. Configure the project

```bash
bun "$SETUP" project --project-dir "$PROJECT" \
  --runtime-root "$RUNTIME" --crew-home "$CREW_HOME"
```

This runs ordinary `config --harness kiro-crew --mcp none`, installs the project
engine and workspace shell, and appends the canonical project to Crew's
`agent.subagent_cwd_allowed_roots`. It preserves unrelated configuration.
Refreshes must wait until workflows are complete.

With Claude selected on either backend setting, setup checks for conflicting
project Claude files before project configuration or terminal binding writes.
It never changes those files; resolve [collisions](#claude-code-backend) first.

If `config.local.json` overrides that roots list, follow the printed remedy
or rerun with `--apply-local`. Local lists replace base lists; they do not
merge automatically. Stop other configuration writers before applying changes.

With the native runtime installed, replace `--runtime-root "$RUNTIME"` with
`--native`. This does not remove the Bun requirement for setup, hooks, or MCP.

### 2. Grant app trust

Review the App Kit, then grant **aidlc** trust yourself in Crew's
**Settings → Security → Trusted Apps**. Both effective `agent.apps_trusted`
and `agent.apps_trusted_local` must include `aidlc`.

```bash
bun "$SETUP" trust --crew-home "$CREW_HOME"
```

This command **prints instructions and checks trust; it does not grant it**.
If Crew cannot show an uninstalled local app, stop Crew and other config
writers, then review and run the operator-only configuration snippet printed
by this command. It preserves other grants and handles overriding local lists,
but rewrites JSON formatting. Never blanket-trust apps or set
`apps_allow_third_party` for this setup.

Rerun the command and continue only when effective trust is **ok**.
Missing trust stops `app --apply` before staging or registration. Keep other
writers stopped: the trust check is a snapshot, not a configuration lock.

### 3. Install and enable the App Kit

```bash
bun "$SETUP" app --apply --crew-home "$CREW_HOME"
```

Run this from the **current source package**, not the installed copy under
`apps/aidlc/`. Setup resolves portable command placeholders before calling
Crew's install and enable commands, then verifies the registered MCP entries.
Do not install the portable App Kit directly with `kirocrew app install`.

An installed matching payload is rematerialized and re-enabled. A mismatch
stops for [source-based replacement](#update-and-removal); matching version
numbers alone are not enough. Partial installations are left for inspection.
Setup without `--apply` prints instructions rather than registering the app.

Use the exported `KIROCREW_HOME` and `KIRO_HOME` when starting Crew too.
Authentication in another Kiro home does not establish access in this one.

### 4. Register hooks with Crew stopped

Stop the gateway, dashboard sidecars, and other hook/configuration writers:

```bash
bun "$SETUP" hooks --apply --gateway-stopped --crew-home "$CREW_HOME"
```

Setup merges five AI-DLC entries into `$CREW_HOME/hooks.json`, preserving
foreign entries. It refuses live or unknown gateway PID markers immediately
before writing. `--gateway-stopped` is your acknowledgement, not a lock;
missing markers cannot prove that every writer has stopped.

Do not paste `hooks.fragment.json` into the Hooks UI: it is a portable
template, not runnable registration. Start Crew after the merge so it loads
the updated store. A matching disk file does not prove live hook delivery.

### 5. Check readiness and open a conversation

```bash
bun "$SETUP" status --project-dir "$PROJECT" --crew-home "$CREW_HOME"
cd "$PROJECT"
bun .kiro-crew/tools/aidlc.ts --doctor --verbose
# Native alternative from the same project:
aidlc --doctor --verbose
```

Setup status lists outstanding steps. **Pending** means not configured yet,
not permission to start work. Doctor checks runtime, project configuration,
cwd authorization, hooks, installed/enabled app, pinned bridge runtime,
trust, conversation binding, and dispatch-ledger health.
It also reports backend/version observations, Claude project collisions, and
Crew composition. Version observations do not establish backend compatibility.
Setup/doctor may run `kirocrew --version` and, with Claude selected on either
setting, `claude --version` and `node --version`. Adapter versions come from
package metadata; the adapter is not launched to discover its version.

Now open a new dashboard chat, explicitly select the configured project, and
choose **aidlc-crew**. Do not select Crew's gateway workspace as the project.
Send a plain-text message such as:

```text
aidlc express Add a health endpoint
```

The conductor calls `aidlc_status` first to bind the conversation, then runs
doctor before work, including on resume. A not-bound warning before that first
call is expected. Missing Crew rows, failures, and unresolved Crew warnings
hold startup even when doctor exits zero. Repair or reconcile them and rerun.
Doctor checks local consistency, not freshness against a newer source package.

If `aidlc_status` is unavailable, the conductor stops without searching files
or using a shell substitute. Check setup and doctor from your terminal, then
start a new chat with the correct project selected.

## Daily use

Use the usual workflow requests in the selected project's `aidlc-crew` chat:

```text
aidlc --status
aidlc --resume
aidlc --stage domain-design --single
```

The conductor translates engine operations into `aidlc_engine` raw argument
arrays, not shell commands. Public `aidlc config` changes are handed back to
you for terminal execution. A denied action must stop; switching tools or
falling back to the backend's native delegation is not a recovery path.

- **Rules and personas are explicit context.** The engine delivers active-space
  rules and agents read project resources. There is no ambient Crew include of
  the root `AGENTS.md`. Stage runners are resources, not Crew catalog commands.
- **Questions end the turn.** Cards and numbered prose present the choices;
  your next human message supplies the answer. Displaying a card, receiving a
  child completion, or an automatic continuation does not grant approval.
- **Delegation is asynchronous and flat.** The conductor uses `spawn_run`,
  records accepted children in the dispatch ledger, and ends its turn. Final
  delivery and the required engine receipts must both exist before dependents
  run. A successful host result is not a completed stage or approved review.
- **Rework keeps the conversation.** `spawn_continue` uses the saved
  conversation and same role. Expired or uncertain work stops for an explicit
  recovery decision; it is not silently respawned or replaced by inline work.
- **Model selection belongs to Crew.** App Kit agents omit model pins and
  AI-DLC tier settings do not select a Crew backend or child model.
- **Hooks have limits.** Inspectable permission requests can be denied, while
  notification-path decisions are advisory. Write auditing detects Kiro conductor
  create/replace outputs or correlated Claude conductor Bash receipts; it is
  not write prevention or duplicate-proof. Claude file-tool writes lack a success Post.
  Child-hook delivery is not guaranteed.
- **No automatic sensor dispatch, graph rebuild, or state sync hooks.** Use
  the engine operations required by the workflow; copying core hooks does not
  register them. There is no session-end, compaction, usage, or statusline hook.
- **Swarm is unsupported.** The conductor stops rather than substituting
  another transport. External MCP integrations are operator-managed; arbitrary
  MCP writes do not have the same inspection guarantees as native file tools.

Before resuming after a restart, inspect unresolved dispatches. Neither a new
conversation nor an empty host task list proves old work finished. Do not
hand-edit bindings or clear outstanding children to silence a warning.
Automatic hook instructions to run the engine still use `aidlc_engine` argv,
never Bash; a continuation is not a human answer or approval.

## Claude Code backend

After `aidlc_status`, the conductor runs doctor before work and on resume.
Claude's Backend and Crew composition rows warn by design. The conductor must
list unresolved Crew warnings, explain expected limitations, and end its turn
for your explicit acknowledgement in that conversation. This cannot waive a
failure or mixed, conflicting, or unverified composition; repair and rerun first.

**Use a project without conflicting Claude configuration.** Setup refuses
existing `.claude/settings.local.json` (except an availableModels-only seed),
`CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/settings.json`, nonempty `.claude/`
hooks/agents/skills directories, an existing Claude AI-DLC engine, or unsafe inspection.
Move or remove conflicting files yourself, or choose a clean project. A seed
only warns: close the live session and recheck; its shape is not ownership proof.
These setup checks are not continuous protection around live MCP or hook writes.

**Launch one child in a distinct, explicitly authorized directory.** Sharing
the conductor's cwd can withhold the child's engine MCP, even if the conductor
is idle. Before any engine call, the child binds the parent's absolute project:
`aidlc_bind_session {"project_dir":"<parent-project>"}`. It uses its own
Crew-recorded identity, omits `session_key`, and never borrows the parent's key.
The bridge checks the subagent identity, project stamp, and effective cwd roots
before binding; a conflicting binding refuses without an automatic project switch.
Binding does not fill in missing backend records or prove child-hook delivery.
Do not submit a multi-task `spawn_run` batch: Crew applies one cwd to all tasks.
Stop for a recovery plan with separately authorized child directories; do not
silently serialize, inline the work, create directories to bypass refusal, or
relax the required end-of-turn boundary.

**Carry context in the brief.** Claude children receive neither registered
prompts nor automatic resources. Every initial and continued task must carry,
in order, role, absolute persona-first read, engine path, protocol/rules reads,
task, parent-project bind/engine argv instructions, and a fresh `ACK-<token>`.
Keep the rendered task within 5,000 characters, including paths: plan 3,000 for
bootstrap and 2,000 for task/return instructions; never truncate mandatory text.
Before accepting output, require the exact first-line ACK and current-run,
host-observed persona Read. A child's claim to have read it is not evidence.

**Do not use `spawn_steer` on Claude.** Wait for the child to finish, then use
`spawn_continue` with the same explicit agent, a fresh brief/token, and new-run
delivery verification. Tool success text does not prove steering delivery.
Expired or uncertain conversations stop; no interrupt-and-respawn or native fallback.

**Produce stage artifacts through guarded conductor Bash receipts.** After an
authorized write, print `ARTIFACT <absolute path>` as the last body line of the
single `console` fence Crew forwards. The permission request must contain literal
`ARTIFACT` followed by a space and a literal in-boundary absolute path outside heredoc bodies.
The adapter requires a prior request plus a fresh regular, non-symlink file in
the active record/CodeKB boundary. Engine commands still use `aidlc_engine`, not
Bash. Receipts detect writes; they never replace approval or review receipts.

**Do not rely on native delegation or read containment.** Crew does not enforce
App Kit native Task/Agent restrictions on Claude's notification paths, and
pre-approved reads bypass permission checks, including reviewer read scope.
Write/Edit can be diff-only and have no success PostToolUse. Keep reviewer
context restricted and inspect changes; after-the-fact integrity checks are not
prevention. See the [receipt contract](../../reference/06-hooks-and-tools.md#kiro-crew-hook-contract)
for expiry, capacity, duplicate-delivery, and misattribution limits.

## Codex backend

**Codex is not supported as a Crew backend.** Through Crew, AI-DLC cannot
intercept Codex tool permissions or identify the calling conversation.

With `agent.acp_backend=codex`, setup refuses every command except diagnostic
`status` before setup writes; status and doctor report a backend failure.
A member-DM-only Codex selection warns instead. When Codex is observed for a
conversation, MCP calls refuse before binding or engine execution, participating
`PreToolUse` hooks refuse, and `PostToolUse` emits a diagnostic without an audit row.
Version checks do not lift the refusal.

Stop work. Choose Kiro CLI or [Claude Code with its limits](#claude-code-backend)
in Crew yourself, then rerun setup and doctor. Do not bypass a refusal through
another tool or transport. The [native Codex CLI harness](codex-cli.md) remains
supported and is unaffected; use its own setup to run Codex outside Crew.

## Progress page

Open **AI-DLC** in Crew's dashboard navigation (`/apps/aidlc`) after installing
and enabling the trusted App Kit. Use the owner's dashboard session. The page
reads projects already bound by conversations; if none appear, open an
`aidlc-crew` chat on the project and let `aidlc_status` bind it first.

The **Project** picker starts with the most recently bound valid project and
keeps your explicit choice on refresh. Missing or invalid installation stamps
leave projects listed but disabled. The **Intent** picker groups records by
space: one eligible intent opens automatically; several require your choice.
Archived, completed, orphan, registry-only, and unsupported-status records are
listed but cannot be selected. Selection here does not change workflow bindings.

**No eligible intents** means there is nothing to display, not zero completion.
**Choose an intent** means selection is required. **Progress unavailable** or
**Progress could not be refreshed** reports a read or access failure with its
code; neither is a progress result. The footer says **Showing the last successful
snapshot; it may be out of date.** only when progress is retained, otherwise
**No progress is displayed.** Access and setup failures keep their diagnostic
codes alongside **Access denied. Use an authenticated owner dashboard session and
check that AI-DLC is enabled, then retry.** or **Project setup needs attention.
Rerun project setup and doctor, then retry.** An empty project list says **No bound
projects. Select your configured project in a new dashboard chat and message
aidlc-crew; its first status call binds the project.** The live region announces
**Progress refreshed.** or **Progress could not be refreshed.** on outcome changes,
not each countdown tick.
Stage labels reflect records: **Remaining** is pending, **in progress** is active
work, **awaiting approval** needs a gate answer, and **revising** needs rework;
**completed** and **skipped** are separate counts. Counts cover the effective
stage plan, not individual Unit or Bolt trees. Gate age is shown only when known.

Selected-intent blockers stay separate from project-level/unattributed work.
Recorded backend and Crew provider labels are observations, not live identity
or execution permission; a Codex label never admits the blocked backend.
Refresh runs five seconds after success, pauses new requests while hidden, and
resumes immediately when visible. Failures back off through 5, 10, 20, 40, then
60 seconds. **Retry** requests a refresh; it is disabled during a live request.
Switching project or intent clears old progress and ignores late responses.

**Trust and privacy:** this is observe-only, with no workflow actions. It reads
project registries, selected state/audit records, session bindings, and dispatch
ledgers. The route runs unsandboxed inside Crew under local-app trust, not an OS
sandbox; project paths and record details can reach the owner's dashboard.
It never writes AI-DLC state, but Crew may write logs or Python bytecode caches.
Setup/doctor require **CPython 3.12** to verify installed caches. Discovery uses
absolute `KIROCREW_PYTHON` first (invalid means refusal), then `python3.12` beside
the resolved Crew launcher, then the Kiro Crew app's bundled Python at its
standard macOS location. Candidates must verify as 3.12; there is no runtime
PATH Python lookup. Normal installs need no extra interpreter setup; otherwise
set `KIROCREW_PYTHON` to a trusted absolute executable.
No cache means no interpreter lookup.
See the [route contract](../../reference/06-hooks-and-tools.md#kiro-crew-progress-routes) for bounds and errors.

## Update and removal

Update between workflows with Crew and other writers stopped. Obtain the new
runtime at a stable path, update `RUNTIME`/`SETUP`, and repeat project setup.
Run `app --apply` from that source to compare it with the installed payload.
`aidlc update` alone does not refresh the registered App Kit or project.

If setup reports an outdated or unverified payload, back up local app data,
then use the same Crew/Kiro homes for replacement:

```bash
kirocrew app uninstall aidlc
```

**Never add `--purge-data` when replacing the app. Uninstall revokes trust:**
repeat step 2, then repeat app installation, hook registration, and verification.
A data-only app directory can be reinstalled; other partial states need inspection.
Do not edit inventory hashes or registered commands to approve altered bytes.

For removal, app uninstall and project engine removal are separate. Review
remaining AI-DLC hooks, cwd grants, and bindings in Crew before removing them;
stop writers before file edits. Preserve project `aidlc/` workflow history.
See [lifecycle ownership](../18-install-and-lifecycle.md#root-integrations-and-ownership).

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `TRUST_REQUIRED_STOP` | Grant local app trust as the operator; check both effective lists, including local overrides |
| MCP bridge missing | Check homes, app enablement, and the pinned Bun path; rerun setup and open a new chat |
| Project selection conflict | Select the intended project and explicitly rebind using the exact Crew-recorded session key; never invent a key or substitute a native CLI UUID |
| Stale or corrupt engine binding | Preserve it for inspection; use the engine's supported intent navigation, not hand edits or cursor fallback |
| Hooks edit refused | Stop every gateway/config writer; inspect live or unknown PID markers rather than deleting them to bypass the check |
| Outstanding or uncertain children | Reconcile saved runs and results; do not auto-clear the ledger or dispatch replacement work |
| Claude project collision | Resolve the named project files yourself or use a clean project; setup never repairs Claude configuration |
| Missing Claude artifact audit row | Check the prior permission request, receipt grammar, freshness, and ledger limits; do not fabricate evidence |
| Claude child MCP or delivery unavailable | Stop; check distinct authorized cwd, own-key parent-project bind, and fresh ACK/persona Read rather than using shell fallback |
| Codex backend refused | Stop and follow [Codex backend alternatives](#codex-backend); setup never switches backends for you |
| Progress/cache failure | See [progress remedies](../15-troubleshooting.md#kiro-crew-setup-and-startup); never edit stamps or records to bypass a read refusal |

## Other harnesses

- [Harness family index](README.md) — choose a direct CLI or IDE integration.
- [Your First Workflow](../02-your-first-workflow.md) — the shared methodology.
- [Hooks and Tools](../../reference/06-hooks-and-tools.md#kiro-crew-hook-contract) — event and receipt boundaries.
- [Testing](../../reference/09-testing.md#kiro-crew-tests) — deterministic checks and the opt-in status journey.
