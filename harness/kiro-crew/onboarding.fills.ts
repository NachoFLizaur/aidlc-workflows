// Explicit internal onboarding, not project-root auto-loading. Skill names and
// projected runtime commands use their separate template substitutions.
import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "aidlc",
  slots: {
    title_block: `# AI-DLC on Kiro Crew

This project uses AI-DLC with the **Kiro Crew dashboard host**. The project engine lives in \`.kiro-crew/\` and shared workflow records in \`aidlc/\`; the App Kit supplies registered agents, setup, hooks and the MCP bridge, not a second engine. Complete project setup, operator trust, app install/enable and hook registration, then explicitly select the project in a dashboard chat and message \`aidlc-crew\` in plain text: \`{{SKILL_INVOKE}} <description of what you want to build>\`. Shared \`/aidlc …\` notation means a plain-text message to that agent, not a native Crew slash command. Runtime diagnostics use \`{{INVOKE}} --doctor\`. Live registration/status checks are opt-in; static checks do not establish live host behavior.`,
    prereq_bullets: `- **Kiro Crew ≥0.6.0**: use an interactive dashboard session with the project explicitly selected. Complete project setup, operator-only trust, app registration and hooks before workflow work.
- **Runtime**: Bun on PATH is required for setup and TypeScript engine commands. MCP and script hooks require Bun even with native \`aidlc\`; registered commands use setup's pinned absolute Bun path. Crew provisions neither runtime.
- **Model/provider**: honor the operator's \`agent.acp_backend\` selection and separate \`agent.member_acp_backend\` member-DM selection; setup and doctor never switch them. The App Kit grants no provider entitlement and pins no model. Kiro needs an authenticated Kiro CLI available to Crew. Claude needs an authenticated Claude Code CLI, \`@agentclientprotocol/claude-agent-acp\` and Node ≥22 available to Crew; prerequisites alone do not establish backend compatibility.
- **Backend compatibility**: Kiro CLI is the default supported path. Claude has the limitations described in docs/guide/harnesses/kiro-crew.md §Claude backend. Codex is not supported as a Kiro Crew backend: Crew does not let AI-DLC intercept Codex tool permissions or identify the calling conversation. Stop without dispatch, artifact creation or a transport workaround. Choose Kiro CLI or Claude Code with its documented limits in Crew, then rerun setup and doctor. Version changes do not bypass this refusal. See docs/guide/harnesses/kiro-crew.md#codex-backend. The native Codex CLI harness is unaffected. KAS and Slack are not supported by this integration.
- **Claude isolation**: a dedicated \`KIROCREW_HOME\` isolates Crew state, not Claude credentials or ambient configuration. User-level \`~/.claude\` settings/plugins can load into sessions; a clean project does not isolate them. Setup/doctor refuse conflicting project \`.claude/\` or \`CLAUDE.md\` files without modifying them.`,
    hook_permissions_note: `- **Crew boundary**: the shared hook description is the core inventory, not Crew parity. Setup registers five events through the app-side entry. PostToolUse provides Kiro create/replace auditing and correlated Claude Bash ARTIFACT receipt auditing; Claude file-tool writes have no PostToolUse. Both are advisory detection, not prevention. Permission-request hooks can deny before host approval, but Claude pre-approved reads bypass permission requests and backend-start notifications cannot block. Child-hook delivery is not guaranteed. Copying scripts alone does not activate hooks.`,
    agents_note: `These Markdown files supply explicit inline persona context; the App Kit separately registers the conductor and 14 role agents. Resolve dispatch names through role-map.json and use spawn_run / spawn_continue with completion-envelope correlation and the dispatch ledger. Transport completion is never an engine receipt. Swarm is unsupported; missing bindings stop explicitly, never falling back to a backend-native tool.`,
    structure_extra: `### Crew context and host boundary

Native-include and automatic-hook descriptions describe the shared framework, not ambient inclusion or hook parity on Crew. The engine delivers active-space rules through \`load-steering\` / \`rules_content\`; App Kit agents declare project-relative skill/file resources and stage work requires persona reads. Skills are not Crew catalog entries: \`$aidlc-<stage>\` does not resolve; message \`aidlc-crew\` with \`{{SKILL_INVOKE}} --stage <slug> --single\` in plain text. Read this internal \`.kiro-crew/AGENTS.md\` explicitly. First \`aidlc_status\` binds the conversation, then doctor preflight holds work on Crew failures or unresolved warnings. Live registration/status checks are opt-in; static checks do not establish live host behavior.

**Method/rules on Kiro Crew:** engine-delivered context plus explicit \`file://aidlc/spaces/<space>/memory/**\` resources — no ambient host include or copy into \`{{HARNESS_DIR}}/\`.

See docs/guide/harnesses/kiro-crew.md for setup, consent, KIRO_HOME alignment, binding, backend limitations, hook behavior and troubleshooting.`,
    sections_before_resumption: `## Questions on Crew

Questions and gates use non-blocking cards and numbered prose with an \`[OPTIONS: ...]\` line. The next human message supplies the answer; the questions file and tool-recorded approval remain the source of truth. A displayed card or options list is not approval.`,
  },
};
export default fills;
