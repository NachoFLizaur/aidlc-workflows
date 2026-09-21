import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseCrewSkillFrontmatter, validateCrewSkillFrontmatter } from "./skill-grammar.ts";
import type { Collector } from "./types.ts";

type SkillKind = "orchestrator" | "stage-runner" | "scope-runner" | "session" | "knowledge" | "init" | "compose";
export type CrewSkillsManifest = {
  schemaVersion: 1;
  skillsRoot: string;
  resources: string[];
  conductor: string;
  questionRendering: string;
  delegation: string;
  skills: { name: string; description: string; path: string; kind: SkillKind }[];
};
const SKILLS_ROOT = ".kiro-crew/skills";
const BASE_KINDS = new Map<string, SkillKind>([
  ["aidlc", "orchestrator"],
  ["aidlc-knowledge", "knowledge"],
  ["aidlc-outcomes-pack", "session"],
  ["aidlc-replay", "session"],
  ["aidlc-session-cost", "session"],
  ["aidlc-init", "init"],
  ["aidlc-compose", "compose"],
]);

function skillPaths(root: string, relative = ""): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...skillPaths(root, path));
    else if (entry.isFile() && entry.name === "SKILL.md") paths.push(`${SKILLS_ROOT}/${path}`);
  }
  return paths.sort();
}

/** Read generated skills, graph and scope names before App Kit writes. Missing
 * inputs, grammar violations or unknown kinds throw; no bypass. Registration
 * and live resource resolution remain separate host concerns. */
export const collectSkillEmissions: Collector = (ctx) => {
  const engineRoot = join(ctx.distRoot, ".kiro-crew");
  const paths = skillPaths(join(ctx.distRoot, SKILLS_ROOT));
  const texts = paths.map((path) => ({ path, text: readFileSync(join(ctx.distRoot, path), "utf-8") }));
  const violations = texts.flatMap(({ path, text }) => validateCrewSkillFrontmatter(text, path));
  if (violations.length) throw new Error(`kiro-crew skill grammar violations:\n${violations.join("\n")}`);
  const stages: { slug: string; phase: string; plugin?: string }[] = JSON.parse(
    readFileSync(join(engineRoot, "tools/data/stage-graph.json"), "utf-8"),
  );
  const stageNames = new Set(stages.filter((stage) => stage.phase !== "initialization")
    .map((stage) => stage.plugin ? stage.slug : `aidlc-${stage.slug}`));
  const scopeNames = new Set(readdirSync(join(engineRoot, "scopes"))
    .filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)));
  const skills = texts.map(({ path, text }) => {
    const fields = parseCrewSkillFrontmatter(text);
    const name = fields.get("name")!;
    const kind = BASE_KINDS.get(name) ?? (stageNames.has(name) ? "stage-runner" : scopeNames.has(name) ? "scope-runner" : undefined);
    if (!kind) throw new Error(`kiro-crew skill inventory: unknown kind for ${name} at ${path}`);
    return { name, description: fields.get("description")!, path, kind };
  });
  const conductorPath = `${SKILLS_ROOT}/aidlc/SKILL.md`;
  const questionPath = `${SKILLS_ROOT}/aidlc/question-rendering.md`;
  const delegationPath = `${SKILLS_ROOT}/aidlc/delegation.md`;
  if (!paths.includes(conductorPath) || ![questionPath, delegationPath].every((path) => statSync(join(ctx.distRoot, path)).isFile())) {
    throw new Error("kiro-crew skill inventory requires the conductor, question-rendering and delegation annexes");
  }
  const manifest: CrewSkillsManifest = {
    schemaVersion: 1,
    skillsRoot: SKILLS_ROOT,
    resources: paths.map((path) => `skill://${path}`),
    conductor: `skill://${conductorPath}`,
    questionRendering: `file://${questionPath}`,
    delegation: `file://${delegationPath}`,
    skills,
  };
  console.log(`kiro-crew: validated ${skills.length} SKILL.md files (0 grammar violations)`);
  return [{ path: "skills.manifest.json", content: `${JSON.stringify(manifest, null, 2)}\n` }];
};
