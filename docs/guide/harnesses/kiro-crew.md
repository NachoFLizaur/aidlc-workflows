# AI-DLC on Kiro Crew

Kiro Crew runs AI-DLC through a dashboard conversation. The App Kit supplies
the `aidlc-crew` conductor, role agents, hooks, and an MCP bridge. The selected
project holds the same deterministic engine and workflow records used by the
other harnesses; the App Kit is not a second engine.

Message **aidlc-crew** in plain text. Shared `/aidlc …` examples mean messages
to that agent, not native Crew slash commands. Project setup, app trust,
registration, and hook activation are separate steps.

## Backends

**Kiro CLI is the supported backend for this integration.** Crew is the host;
Kiro CLI supplies the model session. Configure and authenticate that backend
through Crew. Setup does not select a backend or grant model access, and the
App Kit does not pin a model. Other backends and Slack are not supported here.

This is separate from running [AI-DLC directly on Kiro CLI](kiro-cli.md).
Use the Crew instructions below for a dashboard workflow, not the direct-CLI
agent installation instructions.

## Prerequisites

- **Kiro Crew ≥0.6.0**, with `kirocrew` available on PATH and an interactive
  dashboard session in which you can select a project and agent.
- **Bun on PATH** for setup. Setup pins its absolute Bun executable into the
  registered hooks and MCP command. The bridge and hook entry still require
  Bun when the native `aidlc` executable is installed.
- **An authenticated Kiro CLI backend** with access to your chosen model.
  Keep the same Crew and Kiro homes for installation and dashboard use.
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
| `$KIROCREW_HOME/apps/aidlc/` | Registered App Kit: agents, resource manifests, setup, hook entry, launcher, and MCP bridge |
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
  notification-path decisions are advisory. Write auditing detects conductor
  create/replace outputs only; it is not write prevention or duplicate-proof.
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

## Other harnesses

- [Harness family index](README.md) — choose a direct CLI or IDE integration.
- [Your First Workflow](../02-your-first-workflow.md) — the shared methodology.
- [Hooks and Tools](../../reference/06-hooks-and-tools.md#kiro-crew-hook-contract) — event and receipt boundaries.
- [Testing](../../reference/09-testing.md#kiro-crew-tests) — deterministic checks and the opt-in status journey.
