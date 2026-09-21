// Project-local engine projection, separate from the registered App Kit shell.
import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import emit from "./emit.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "kiro-crew",
  productName: "Kiro Crew",
  configNextStep: "complete App Kit registration and project setup, then start a dashboard workflow with the project explicitly selected",
  firstRunSteps: [
    "Check setup status with the Crew setup helper: see docs/guide/harnesses/kiro-crew.md#install-and-verify (set the project/runtime variables, then run step 5).",
    "Open a dashboard chat with this project selected; the AI-DLC conductor is the aidlc-crew agent.",
  ],
  harnessDir: ".kiro-crew",
  hostDirectories: ["kiro-crew-app"],
  orchestratorSkillPath: ".kiro-crew/skills/aidlc/SKILL.md",
  tierFlavor: "kiro-crew",
  rootIntegrations: [
    { path: ".gitignore", policy: "managed-block", marker: "gitignore", shared: "union" },
  ],
  // Core personas are explicit inline context, not host-registered agents.
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
    { src: "skills/aidlc-session-cost", dst: "skills/aidlc-session-cost" },
    { src: "skills/aidlc-replay", dst: "skills/aidlc-replay" },
    { src: "skills/aidlc-outcomes-pack", dst: "skills/aidlc-outcomes-pack" },
    { src: "skills/aidlc-knowledge", dst: "skills/aidlc-knowledge" },
  ],
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "skills/aidlc/delegation.md", dst: "skills/aidlc/delegation.md" },
    { src: "hooks/aidlc-kiro-crew-adapter.ts", dst: "hooks/aidlc-kiro-crew-adapter.ts" },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],
  // Explicitly read internal guidance; never root auto-loading.
  onboarding: { dst: "AGENTS.md", fills: onboardingFills },
  rulesRename: null,
  skipRunnerGen: false,
  emit,
  plugin: { manifestDir: ".kiro-crew-plugin", kind: "store" },
};

export default manifest;
