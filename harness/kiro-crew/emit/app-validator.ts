import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { APP_ROOT, BUN, CREW_HOME } from "./launcher.ts";
import type { Emission } from "./types.ts";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const safePath = (path: string): boolean => !/[\\:\0%]/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

// Unknown MCPs are not read-only. Explicit binding writes routing state and
// therefore remains permission-gated, even though it is not an engine operation.
export const GUARDED_TOOLS = new Set([
  "fs_write", "write", "edit", "str_replace", "fs_append", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "execute_bash", "execute_pwsh", "shell", "bash", "Bash",
  "subagent", "delegate", "use_subagent", "Task", "spawn_run", "spawn_continue", "spawn_steer",
  "@aidlc:engine/aidlc_engine", "@aidlc:engine/aidlc_bind_session",
]);
export const NATIVE_DISPATCH = new Set(["subagent", "delegate", "use_subagent", "Task"]);
export const READ_ONLY_TOOLS = new Set(["fs_read", "thinking", "todo_list", "@aidlc:engine/aidlc_status"]);
export const isReviewer = (name: string): boolean =>
  /^aidlc-crew-(architecture-reviewer|product-lead)-agent$/.test(name);
export const isProvisionedTool = (tool: string, servers: ReadonlySet<string>): boolean =>
  !tool.startsWith("@") || servers.has(tool.slice(1).split("/")[0]);
export function isGuardedTool(tool: string): boolean {
  return GUARDED_TOOLS.has(tool) || /[*?[\]]/.test(tool) ||
    (tool.startsWith("@") && tool !== "@aidlc:engine/aidlc_status");
}
// Match emit.ts normalization, including exactly one final newline.
export const emissionBytes = (text: string): string => `${text.replace(/\r\n?/g, "\n").replace(/\n*$/, "")}\n`;
export const appSha256 = (text: string): string => createHash("sha256").update(emissionBytes(text)).digest("hex");
export const appJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export type AppInventory = {
  schemaVersion: 1;
  owner: "aidlc";
  selfHash: "sha256 of this JSON with app-inventory.json sha256 set to empty string; indent 2, final LF";
  files: { path: string; mode: number; sha256: string }[];
};
export function buildAppInventory(emissions: Emission[]): AppInventory {
  const inventory: AppInventory = {
    schemaVersion: 1,
    owner: "aidlc",
    selfHash: "sha256 of this JSON with app-inventory.json sha256 set to empty string; indent 2, final LF",
    files: emissions.filter(({ path }) => path !== "app-inventory.json")
      .map(({ path, content, mode }) => ({ path, mode: mode ?? 0o644, sha256: appSha256(content) })),
  };
  const self = { path: "app-inventory.json", mode: 0o644, sha256: "" };
  inventory.files.push(self);
  inventory.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  self.sha256 = appSha256(appJson(inventory));
  return inventory;
}

/** Validate the complete collector snapshot and generated project tree before
 * App Kit deletion/writes. Violations make collection throw; no build bypass.
 * Resources require lexical and realpath containment; globs require directory
 * prefixes. Prompts match retained Markdown, MCP grants name provisioned servers
 * and binding remains permission-gated. This checks build consistency, not live
 * hook delivery or containment. Operator auto-approval can bypass permission
 * requests; child-hook delivery is not guaranteed. */
export function validateAppKit(
  emissions: Emission[],
  projectRoot = join(import.meta.dir, "../../../dist/kiro-crew"),
): string[] {
  const errors: string[] = [];
  const files = new Map<string, Emission>();
  for (const emission of emissions) {
    if (!safePath(emission.path) || files.has(emission.path)) errors.push(`invalid or duplicate emission path: ${emission.path}`);
    files.set(emission.path, emission);
    if (![0o644, 0o755].includes(emission.mode ?? -1)) errors.push(`${emission.path}: missing/invalid mode`);
    if (emission.content.includes("{{")) errors.push(`${emission.path}: unresolved placeholder`);
  }
  const parse = (path: string): JsonObject => {
    try {
      const source = files.get(path)?.content ?? "";
      const value: unknown = JSON.parse(source);
      /** Raw-key guard: JSON.parse is the grammar oracle, then scan whole raw
       * string tokens before trusting the parsed fields. Read from the collector
       * snapshot before emission writes; violations make assembly throw, always
       * on with no bypass. Reject ambiguous app.json keys and sessionApproval at
       * every JSON site, even in overwritten objects or with escaped spelling.
       * This is build validation, not runtime authorization or a signature check.
       */
      const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}:]/g) ?? [];
      const fields: Set<string>[] = [];
      tokens.forEach((token, index) => {
        if (token === "{") fields.push(new Set());
        else if (token === "}") fields.pop();
        else if (token.startsWith('"') && tokens[index + 1] === ":") {
          const key = JSON.parse(token) as string;
          const seen = fields.at(-1)!;
          if (path === "app.json" && seen.has(key)) errors.push(`${path}: duplicate JSON key ${key}`);
          if (key === "sessionApproval") errors.push(`${path}: forbidden sessionApproval`);
          seen.add(key);
        }
      });
      if (object(value)) return value;
    } catch { /* Malformed inputs become violations. */ }
    errors.push(`${path}: missing or invalid JSON object`);
    return {};
  };
  const list = (value: unknown, label: string): string[] => {
    if (strings(value)) return value;
    errors.push(`${label}: expected string array`);
    return [];
  };
  /** Check every hook and both MCP maps before emission. Only shared path
   * markers in their exact positions or absolute paths pass. Hook commands are
   * literal POSIX words, MCP fields raw argv. Violations abort assembly; no
   * bypass. Installed executable identity remains setup's responsibility. */
  const commandText = (value: string, label: string): void => {
    for (const forbidden of ["${", "$@", "exec "]) {
      if (value.includes(forbidden)) errors.push(`${label}: forbidden shell syntax ${forbidden}`);
    }
  };
  type CommandPosition = "interpreter" | "script" | "home" | "argument";
  const commandArg = (value: unknown, label: string, position: CommandPosition): void => {
    if (typeof value !== "string" || !value) {
      errors.push(`${label}: expected non-empty command/argument string`);
      return;
    }
    commandText(value, label);
    if (value === "/bin/sh" || value === "sh") errors.push(`${label}: shell interpreter is forbidden`);
    if (value === "-c") errors.push(`${label}: shell -c argument is forbidden`);
    const portable = position === "interpreter" ? value === BUN
      : position === "home" ? value === CREW_HOME
      : position === "script" && value.startsWith(`${APP_ROOT}/`) &&
        safePath(value.slice(APP_ROOT.length + 1)) && !value.slice(APP_ROOT.length).includes("__AIDLC");
    if (value.includes("__AIDLC") && !portable) {
      errors.push(`${label}: unknown, malformed or misplaced portable path marker`);
    }
    if (position !== "argument" && !portable && !value.startsWith("/")) {
      errors.push(`${label}: ${position === "interpreter" ? "PATH-relative interpreter" : "relative path"} is forbidden`);
    }
  };
  const hookCommand = (value: unknown, label: string): void => {
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${label}: expected non-empty hook command`);
      return;
    }
    commandText(value, label);
    const args: string[] = [];
    let word = "";
    let quoted = false;
    let started = false;
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (char === "'") { quoted = !quoted; started = true; }
      else if (quoted) word += char;
      else if (char === "\\" && value[index + 1] === "'") { word += "'"; index++; started = true; }
      else if (char === " " || char === "\t") {
        if (started) { args.push(word); word = ""; started = false; }
      } else if (/[a-zA-Z0-9_./:@%+=,-]/.test(char)) { word += char; started = true; }
      else { errors.push(`${label}: expected literal POSIX argv, not shell syntax`); return; }
    }
    if (quoted) { errors.push(`${label}: unterminated POSIX quote`); return; }
    if (started) args.push(word);
    args.forEach((arg, index) => {
      commandArg(arg, label, index === 0 ? "interpreter" : index === 1 ? "script" : "argument");
    });
  };
  const mcpCommands = (servers: unknown, path: string): void => {
    if (!object(servers)) { errors.push(`${path}: mcpServers must be an object`); return; }
    for (const [name, server] of Object.entries(servers)) {
      const label = `${path}: mcpServers.${name}`;
      if (!object(server)) { errors.push(`${label}: expected stdio server object`); continue; }
      commandArg(server.command, `${label}.command`, "interpreter");
      if (!Array.isArray(server.args)) { errors.push(`${label}.args: expected string array`); continue; }
      server.args.forEach((arg, index, args) => {
        commandArg(arg, `${label}.args[${index}]`,
          index === 0 ? "script" : args[index - 1] === "--crew-home" ? "home" : "argument");
      });
    }
  };
  const resource = (uri: string, label: string): void => {
    const match = /^(skill|file):\/\/(.+)$/.exec(uri);
    const path = match?.[2] ?? "";
    if (!safePath(path) || !/^(\.kiro-crew|aidlc)\//.test(path)) {
      errors.push(`${label}: resource must be project-relative and contained: ${uri}`);
      return;
    }
    const parts = path.split("/");
    const glob = parts.findIndex((part) => /[*?[\]{}]/.test(part));
    const prefix = glob < 0 ? path : parts.slice(0, glob).join("/");
    try {
      const root = realpathSync(projectRoot);
      const target = realpathSync(join(root, prefix));
      const rel = relative(root, target);
      if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel) ||
        !(glob < 0 ? statSync(target).isFile() : statSync(target).isDirectory())) throw new Error("invalid target");
    } catch { errors.push(`${label}: dangling or escaping resource: ${uri}`); }
  };
  // Inspect every JSON approval surface, not only allowedTools.
  const approvalSurfaces = (value: unknown, label: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) approvalSurfaces(item, label);
      return;
    }
    if (!object(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (["allowedCommands", "allowedPaths", "autoApprove", "trustedAgents"].includes(key) &&
        (!Array.isArray(item) || item.length > 0)) errors.push(`${label}: auto-approval surface ${key}`);
      if (key === "autoAllowReadonly" && item !== false) errors.push(`${label}: auto-approval surface ${key}`);
      if (key === "effect" && item === "allow") errors.push(`${label}: capability auto-approval rule`);
      approvalSurfaces(item, label);
    }
  };
  for (const { path } of emissions) if (path.endsWith(".json")) approvalSurfaces(parse(path), path);
  const app = parse("app.json");
  if (app.name !== "aidlc") errors.push("app.json: name must be aidlc (launcher binding)");
  for (const key of ["version", "minKiroCrewVersion"]) {
    if (typeof app[key] !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(app[key])) errors.push(`app.json: invalid ${key}`);
  }
  if (app.minKiroCrewVersion !== "0.7.1") errors.push("app.json: minKiroCrewVersion must be 0.7.1");
  for (const key of ["displayName", "description"]) {
    if (typeof app[key] !== "string" || !app[key].trim()) errors.push(`app.json: missing ${key}`);
  }
  if (!strings(app.skills) || app.skills.length) errors.push("app.json: skills must remain project-side (empty skills array)");
  // Client-side SDK prefix grant, not a server authorization boundary.
  // Checked in the complete snapshot before emission writes; no bypass.
  const ui = object(app.ui) ? app.ui : {};
  if (typeof ui.entry !== "string" || !safePath(ui.entry) || !files.has(`ui/${ui.entry}`)) {
    errors.push("app.json: ui.entry must resolve to an emitted file under ui/");
  }
  const page = Array.isArray(ui.pages) && ui.pages.length === 1 && object(ui.pages[0]) ? ui.pages[0] : {};
  if (page.route !== "/apps/aidlc" || typeof page.label !== "string" || !page.label.trim() || typeof page.icon !== "string" || !page.icon.trim()) {
    errors.push("app.json: expected one /apps/aidlc page with non-empty label and icon");
  }
  /** Contribution oracle: Crew's panel schema, narrowed to one read-only tab.
   * Check the complete snapshot before emission writes; lexical containment plus
   * emitted-file membership uses the same safePath oracle as ui.entry. Entries
   * are relative to ui/, never prefixed with ui/ themselves. Labels use JS length
   * (UTF-16 units, matching the host). Violations make assembly throw before
   * mutation, always on, no bypass. SDK grants remain client-side only; runtime
   * owner checks are separate.
   */
  const contributes = object(app.contributes) ? app.contributes : {};
  if (!object(app.contributes) || Object.keys(contributes).join() !== "panelTabs") {
    errors.push("app.json: contributes must contain only panelTabs");
  }
  const tabs = contributes.panelTabs;
  if (!Array.isArray(tabs) || tabs.length !== 1 || !object(tabs[0])) {
    errors.push("app.json: contributes.panelTabs must contain exactly one tab object");
  } else {
    const tab = tabs[0];
    const label = "app.json: contributes.panelTabs[0]";
    for (const key of Object.keys(tab)) {
      if (!["id", "title", "menuLabel", "menuDescription", "entry", "icon"].includes(key)) errors.push(`${label}: unknown tab field ${key}`);
    }
    if (typeof tab.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(tab.id) || tab.id !== "progress") {
      errors.push(`${label}: id must be progress and match ^[a-z][a-z0-9_-]{0,63}$`);
    }
    for (const key of ["title", "menuLabel", "menuDescription"]) {
      const value = tab[key];
      if (typeof value !== "string" || !value.trim() || value.length > 120) errors.push(`${label}: ${key} must be non-empty and at most 120 UTF-16 units`);
    }
    if (typeof tab.entry !== "string" || !safePath(tab.entry) || tab.entry.startsWith("ui/") || !files.has(`ui/${tab.entry}`)) {
      errors.push(`${label}: entry must resolve to an emitted file under ui/ without a ui/ prefix`);
    }
    if ("icon" in tab && (typeof tab.icon !== "string" || !tab.icon.trim())) errors.push(`${label}: icon must be a non-empty Lucide name`);
  }
  const backendHooks = object(app.backend) && object(app.backend.hooks) ? app.backend.hooks : {};
  if (typeof backendHooks.routes !== "string" || !/^backend\.routes:register_routes$/.test(backendHooks.routes) || !files.has("backend/routes.py")) {
    errors.push("app.json: backend.hooks.routes must name emitted backend.routes:register_routes");
  }
  if (!object(app.permissions) || Object.keys(app.permissions).join() !== "api" ||
    !strings(app.permissions.api) || app.permissions.api.length !== 1 || app.permissions.api[0] !== "/api/apps/aidlc") {
    errors.push("app.json: permissions must be exactly the own-namespace api grant");
  }
  const mcp = object(app.mcpServers) ? app.mcpServers : {};
  const provisionedServers = new Set(["kirocrew-core", ...Object.keys(mcp).map((server) => `${app.name}:${server}`)]);
  const agentPaths = list(app.agents, "app.json agents");
  if (agentPaths.length !== 15 || new Set(agentPaths).size !== 15) errors.push("app.json: expected 15 distinct agent paths");
  const skills = parse("skills.manifest.json");
  const requiredResources = [...list(skills.resources, "skills manifest resources"), String(skills.questionRendering), String(skills.delegation)];
  if (skills.delegation !== "file://.kiro-crew/skills/aidlc/delegation.md") errors.push("skills manifest: delegation annex missing or invalid");
  if (!requiredResources.includes(String(skills.conductor))) errors.push("skills manifest: conductor missing from resources");
  const names = new Set<string>();
  for (const path of agentPaths) {
    if (!safePath(path) || !/^agents\/[^/]+\.json$/.test(path)) errors.push(`invalid agent path: ${path}`);
    const agent = parse(path);
    const name = typeof agent.name === "string" ? agent.name : "";
    if (names.has(name)) errors.push(`${path}: duplicate agent name ${name}`);
    names.add(name);
    if (name === "aidlc" || (/^aidlc-.+-agent$/.test(name) && !name.startsWith("aidlc-crew-"))) {
      errors.push(`${path}: kiro harness name collision ${name}`);
    }
    if (!/^aidlc-crew(?:-[a-z]+(?:-[a-z]+)*-agent)?$/.test(name)) errors.push(`${path}: invalid Crew dispatch name`);
    for (const key of ["hooks", "disallowedTools", "model"]) if (key in agent) errors.push(`${path}: forbidden ${key}`);
    if (agent.includeMcpJson !== false) errors.push(`${path}: includeMcpJson must be false`);
    if (typeof agent.prompt !== "string" || !agent.prompt.trim() || agent.prompt.trimStart().startsWith("file://")) {
      errors.push(`${path}: prompt must be non-empty inline text (file:// is not supported)`);
    } else {
      const promptFile = files.get(path.replace(/^agents\//, "agents/prompts/").replace(/\.json$/, ".md"));
      if (!promptFile || agent.prompt !== emissionBytes(promptFile.content)) errors.push(`${path}: inline prompt differs from emitted Markdown`);
    }
    const tools = list(agent.tools, `${path} tools`);
    for (const tool of tools) if (!isProvisionedTool(tool, provisionedServers)) errors.push(`${path}: undeclared MCP reference ${tool}`);
    if (tools.includes("@aidlc:engine/aidlc_engine") && !tools.includes("@aidlc:engine/aidlc_bind_session")) {
      errors.push(`${path}: engine tool requires aidlc_bind_session grant`);
    }
    if (tools.some((tool) => NATIVE_DISPATCH.has(tool) || tool === "*" || tool === "@builtin")) errors.push(`${path}: native dispatch in tools`);
    if (name !== "aidlc-crew" && tools.some((tool) => tool === "@kirocrew-core" || /(?:^|\/)spawn_/.test(tool))) {
      errors.push(`${path}: nested Crew dispatch in role tools`);
    }
    for (const tool of list(agent.allowedTools, `${path} allowedTools`)) {
      if (!isProvisionedTool(tool, provisionedServers)) errors.push(`${path}: undeclared MCP reference ${tool}`);
      if (isGuardedTool(tool) || !READ_ONLY_TOOLS.has(tool) || (isReviewer(name) && tool !== "thinking")) {
        errors.push(`${path}: guarded or unverified allowedTool ${tool}`);
      }
    }
    const rules = object(agent.permissions) && Array.isArray(agent.permissions.rules) ? agent.permissions.rules : [];
    for (const capability of ["fs_write", "shell", "mcp", "subagent", ...(isReviewer(name) ? ["fs_read"] : [])]) {
      if (!rules.some((rule) => object(rule) && rule.capability === capability && rule.effect === "ask" &&
        strings(rule.match) && rule.match.includes("*") && !("exclude" in rule))) errors.push(`${path}: missing permission gate for ${capability}`);
    }
    const resources = list(agent.resources, `${path} resources`);
    for (const required of requiredResources) if (!resources.includes(required)) errors.push(`${path}: missing skill/annex resource ${required}`);
    for (const uri of resources) resource(uri, path);
  }
  const engine = object(mcp.engine) ? mcp.engine : {};
  if (typeof engine.command !== "string" || !engine.command || !strings(engine.args) || !engine.args.length) {
    errors.push("app.json: engine stdio command/args required");
  }
  const fragmentMcp = parse("mcp.fragment.json").mcpServers;
  mcpCommands(app.mcpServers, "app.json");
  mcpCommands(fragmentMcp, "mcp.fragment.json");
  if (JSON.stringify(mcp) !== JSON.stringify(fragmentMcp)) errors.push("app.json: MCP fragment mismatch");
  const hooks = parse("hooks.fragment.json").hooks;
  if (Array.isArray(hooks)) hooks.forEach((hook, index) => {
    const label = `hooks.fragment.json: ${object(hook) && typeof hook.id === "string" ? hook.id : `hooks[${index}]`}.command`;
    hookCommand(object(hook) ? hook.command : undefined, label);
  });
  const events = ["AgentSpawn", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
  if (!Array.isArray(hooks) || hooks.length !== 5 || events.some((event) =>
    hooks.filter((hook) => object(hook) && hook.event === event && hook.matcher_mode === "glob" &&
      hook.enabled === true && typeof hook.command === "string" && hook.command.includes("engine adapter kiro-crew")).length !== 1
  )) errors.push("hooks.fragment.json: expected five live engine adapter kiro-crew events");
  const roleMap = parse("role-map.json");
  const roles = object(roleMap.roles) ? roleMap.roles : {};
  if (Object.keys(roles).length !== 15) errors.push("role-map.json: expected conductor + 14 engine roles");
  for (const [role, entry] of Object.entries(roles)) {
    const expected = role === "aidlc" ? "aidlc-crew" : role.replace(/^aidlc-/, "aidlc-crew-");
    if (!object(entry) || entry.dispatchName !== expected || !names.has(expected) || entry.reviewer !== isReviewer(expected)) {
      errors.push(`role-map.json: invalid mapping for ${role}`);
    }
  }
  const inventory = parse("app-inventory.json");
  if (JSON.stringify(inventory) !== JSON.stringify(buildAppInventory(emissions))) errors.push("app-inventory.json: ownership/mode/hash mismatch");
  return errors;
}
