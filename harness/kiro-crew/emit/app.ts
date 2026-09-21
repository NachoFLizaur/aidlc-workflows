/** Assemble the App Kit from project personas and explicit resources. Setup
 * owns registration and operator trust; collection never writes host state. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_VERSION } from "../../../core/tools/aidlc-version.ts";
import { CREW_ENGINE_TRANSPORT } from "../mcp/aidlc-mcp-bridge.ts";
import { appJson, buildAppInventory, emissionBytes, isProvisionedTool, isReviewer, NATIVE_DISPATCH, READ_ONLY_TOOLS, validateAppKit } from "./app-validator.ts";
import { collectHookEmissions } from "./hooks.ts";
import { collectLauncherEmissions, MCP_FRAGMENT } from "./launcher.ts";
import { collectSkillEmissions, type CrewSkillsManifest } from "./skills.ts";
import type { Collector, Emission } from "./types.ts";

type KiroAgent = {
  name: string;
  description: string;
  tools: string[];
  allowedTools: string[];
  toolsSettings: { execute_bash: { deniedCommands: string[] } };
  resources: string[];
};
export type CrewRoleMap = {
  schemaVersion: 1;
  promptResolution: "inline prompt bodies; no file:// prompt references";
  strippedMcpReferences: Record<string, string[]>;
  roles: Record<string, { dispatchName: string; reviewer: boolean }>;
};

/** Read authored Kiro grants and exact reviewer identities before emission.
 * Preserve shell deny regexes, remove legacy approval grants and require ASK
 * rules, including reviewer reads. Undeclared MCP references are removed and
 * recorded. Assembly rejects leaks before writing; no build bypass. Operator
 * auto-approval can bypass requests, and child-hook delivery is not guaranteed.
 * Explicit binding writes routing state and must not be auto-approved. */
function projectAgent(source: KiroAgent, resources: string[], prompt: string, provisionedServers: ReadonlySet<string>) {
  const conductor = source.name === "aidlc";
  const name = conductor ? "aidlc-crew" : source.name.replace(/^aidlc-/, "aidlc-crew-");
  const reviewer = isReviewer(name);
  return {
    name,
    description: conductor ? "AI-DLC conductor for the selected Kiro Crew project — message the aidlc-crew agent in plain text to start or resume a workflow" : source.description,
    prompt,
    tools: [...new Set([
      ...source.tools.filter((tool) => !NATIVE_DISPATCH.has(tool) && isProvisionedTool(tool, provisionedServers)),
      "@aidlc:engine/aidlc_status", "@aidlc:engine/aidlc_engine", "@aidlc:engine/aidlc_bind_session",
      // Managed core uses a bare reference; children never mount dispatch.
      ...(conductor ? ["@kirocrew-core"] : []),
    ])],
    allowedTools: source.allowedTools.filter((tool) => READ_ONLY_TOOLS.has(tool) && (!reviewer || tool === "thinking")),
    toolsSettings: { execute_bash: { deniedCommands: source.toolsSettings.execute_bash.deniedCommands } },
    permissions: {
      rules: ["fs_write", "shell", "mcp", "subagent", ...(reviewer ? ["fs_read"] : [])]
        .map((capability) => ({ capability, match: ["*"], effect: "ask" })),
    },
    resources: [...new Set([
      ...resources,
      // Persona is the prompt; repoint knowledge/scopes/memory to the project.
      ...source.resources.filter((uri) => !uri.startsWith("skill://") && !uri.startsWith("file://.kiro/agents/"))
        .map((uri) => uri === "file://AGENTS.md" || uri === "file://.kiro/steering/aidlc-onboarding.md"
          ? "file://.kiro-crew/AGENTS.md"
          : uri.replace("file://.kiro/", "file://.kiro-crew/")),
    ])],
    includeMcpJson: false,
  };
}

export const collectAppEmissions: Collector = (ctx) => {
  const skillEmissions = collectSkillEmissions(ctx);
  const skills = JSON.parse(skillEmissions.find(({ path }) => path === "skills.manifest.json")!.content) as CrewSkillsManifest;
  const predecessors = [...collectLauncherEmissions(ctx), ...skillEmissions, ...collectHookEmissions(ctx)]
    .map((emission) => ({ ...emission, mode: emission.mode ?? 0o644 as const }));
  const roleIds = readdirSync(join(ctx.coreRoot, "agents"))
    .filter((file) => /^aidlc-.+-agent\.md$/.test(file)).map((file) => file.slice(0, -3)).sort();
  if (roleIds.length !== 14) throw new Error(`kiro-crew App Kit expects 14 engine roles, found ${roleIds.length}`);
  const roles: CrewRoleMap["roles"] = {};
  const strippedMcpReferences: CrewRoleMap["strippedMcpReferences"] = {};
  const provisionedServers = new Set(["kirocrew-core", ...Object.keys(MCP_FRAGMENT.mcpServers).map((server) => `aidlc:${server}`)]);
  const agents: string[] = [];
  const emissions: Emission[] = [];
  for (const role of ["aidlc", ...roleIds]) {
    const source = JSON.parse(readFileSync(join(ctx.repoRoot, "harness/kiro/agents", `${role}.json`), "utf-8")) as KiroAgent;
    if (source.name !== role) throw new Error(`kiro agent identity mismatch for ${role}`);
    let prompt: string;
    if (role === "aidlc") {
      const command = ctx.substituteToken("{{TOOL_PREFIX}}").startsWith("bun ") ? "bun .kiro-crew/tools/aidlc.ts" : "aidlc";
      prompt = `You are the AI-DLC conductor for the selected Kiro Crew project. If \`@aidlc:engine/aidlc_status\` is not among your available tools, stop before any tool call or file read and tell the user "AIDLC MCP bridge is not running for this session". Ask them to check the Crew home the App Kit was installed into, run the project doctor from a terminal in the selected project's root (\`${command} doctor\` with \`KIROCREW_HOME\` set to that home) or rerun project setup, then start a new dashboard session with the project selected. Do not run \`ls\`, \`find\`, or any filesystem search; do not read framework or engine source to investigate, use a shell workaround or backend-native fallback, or try doctor through a tool you do not have.
Load the orchestrator skill \`${skills.conductor}\` and follow \`.kiro-crew/skills/aidlc/delegation.md\` for all delegation. Your first call each conversation is \`aidlc_status\` to bind this conversation to the project. On any tool error beginning \`Cannot bind Crew session:\` or \`Cannot select Crew project\`, relay the message verbatim and STOP. Never invent, guess or construct a \`session_key\` (no dashboard-slot guesses or UUIDs), read Crew files or shell around the failure, or proceed to workflow work. Call \`aidlc_bind_session\` only with a key the tool result names or the operator supplies in chat.
**Guard denial is terminal.** Never redo a denied action through shell, another tool or another path. Stop and report the denial and required next step; wait for explicit resolution. This overrides shared refusal-retry allowances: two refusals do not authorize retry. Malformed arguments may be corrected; a hook/guard DENIAL naming a hook, guard, blocked, denied or Cannot refusal may not. Check every tool result before further mutation; no ceremony bypass.
${CREW_ENGINE_TRANSPORT}
After the first \`aidlc_status\` of each conversation, run \`aidlc_engine {"args":["doctor","--verbose"]}\` before any next, dispatch or artifact work, including resume. Require all nine \`Crew integration —\` rows: Runtime, Project configured, Project authorized as cwd root, Hooks registered, App installed+enabled, Bridge runtime pinned, Trust granted, Conversation bound, Dispatch ledger health. Missing rows mean incomplete or wrong-context output, never clearance. Any Crew fail or unrepaired/unreconciled Crew warn holds startup; other doctor advisories do not block preflight. Show the fixes, never self-grant trust or settle children automatically, and rerun after operator repair. If setup or a required resource/tool is missing, stop and report; never fall back to native subagent delegation.
`;
    } else {
      const persona = readFileSync(join(ctx.distRoot, ".kiro-crew/agents", `${role}.md`), "utf-8");
      const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(persona);
      if (!header) throw new Error(`missing projected persona frontmatter for ${role}`);
      const fields = header[1].split(/\r?\n/).filter((line) => !/^(disallowedTools|model):/.test(line));
      prompt = `---\n${fields.join("\n")}\n---\n${persona.slice(header[0].length)}`;
      if (emissionBytes(prompt.slice(prompt.indexOf("\n---\n") + 5)) !== emissionBytes(persona.slice(header[0].length))) {
        throw new Error(`persona body changed for ${role}`);
      }
    }
    prompt = emissionBytes(prompt);
    const agent = projectAgent(source, [...skills.resources, skills.questionRendering, skills.delegation], prompt, provisionedServers);
    const path = `agents/${role}.json`;
    agents.push(path);
    roles[role] = { dispatchName: agent.name, reviewer: isReviewer(agent.name) };
    strippedMcpReferences[role] = source.tools.filter((tool) => !isProvisionedTool(tool, provisionedServers));
    emissions.push({ path, content: appJson(agent), mode: 0o644 });
    emissions.push({ path: `agents/prompts/${role}.md`, content: prompt, mode: 0o644 });
  }
  emissions.push({
    path: "app.json", mode: 0o644,
    content: appJson({
      name: "aidlc", version: AIDLC_VERSION, displayName: "AI-DLC",
      description: "AI-DLC workflows with a project-local engine and Crew conductor and role agents.",
      minKiroCrewVersion: "0.6.0", agents, skills: [],
      mcpServers: MCP_FRAGMENT.mcpServers,
      permissions: {},
    }),
  }, {
    path: "role-map.json", mode: 0o644,
    content: appJson({ schemaVersion: 1, promptResolution: "inline prompt bodies; no file:// prompt references", strippedMcpReferences, roles } satisfies CrewRoleMap),
  });
  emissions.push({ path: "app-inventory.json", mode: 0o644, content: appJson(buildAppInventory([...predecessors, ...emissions])) });
  const violations = validateAppKit([...predecessors, ...emissions], ctx.distRoot);
  if (violations.length) throw new Error(`kiro-crew App Kit violations:\n${violations.join("\n")}`);
  console.log(`kiro-crew: validated ${agents.length} agents, ${skills.resources.length} skills per agent, project resources, ${predecessors.length + emissions.length} owned files (0 App Kit violations; inline prompt bodies; no file:// prompt references)`);
  return emissions;
};
