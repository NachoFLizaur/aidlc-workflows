import { CREW_HOOK_INVOKE } from "./launcher.ts";
import type { Collector } from "./types.ts";

// An empty matcher covers all tools. Missing PostToolUse input is not inferred.
export const collectHookEmissions: Collector = (ctx) => [{
  path: "hooks.fragment.json",
  content: JSON.stringify({
    hooks: ["AgentSpawn", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].map((event) => ({
      id: `aidlc-${event.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`,
      name: `AIDLC ${event}`,
      event,
      matcher: "",
      matcher_mode: "glob",
      command: ctx.substituteToken(`${CREW_HOOK_INVOKE} ${event}`),
      timeout: 30,
      enabled: true,
    })),
  }, null, 2),
}];
