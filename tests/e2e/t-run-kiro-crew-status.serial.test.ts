import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject } from "../harness/fixtures.ts";
import { connect, createRegistration, initialize, registeredServer, requireLive } from "../harness/kiro-crew-live.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

const enabled = process.env.AIDLC_KIRO_CREW_LIVE === "1" && process.env.AIDLC_NO_LLM !== "1" && !process.argv.includes("--no-llm");
test.skipIf(!enabled)("registered Crew bridge binds a recorded conversation and reports no workflow", async () => {
  const f = createRegistration();
  let client: ReturnType<typeof connect> | undefined;
  try {
    expect(JSON.parse(readFileSync(join(f.home, "apps/aidlc/installed.json"), "utf8")).enabled).toBe(true);
    const key = "dashboard:registration-test";
    // Synthetic host identity exercises registration, not a model conversation.
    writeFileSync(join(f.home, "session_map.json"), JSON.stringify({ [key]: { cwd: f.project } }));
    const server = registeredServer(f);
    requireLive();
    client = connect(server, f.project, f.env);
    await initialize(client);
    expect((await client.request("tools/list")).result?.tools?.map(({ name }) => name).sort()).toEqual(["aidlc_bind_session", "aidlc_engine", "aidlc_status"]);
    const bound = await client.request("tools/call", { name: "aidlc_bind_session", arguments: { session_key: key } });
    expect(bound.result?.isError, JSON.stringify(bound)).toBe(false);
    const hash = createHash("sha256").update(key).digest("hex");
    expect(JSON.parse(bound.result!.content![0].text)).toMatchObject({ keyHash: hash, projectDir: f.project });
    const status = await client.request("tools/call", { name: "aidlc_status", arguments: {} });
    expect(status.result?.isError, JSON.stringify(status)).toBe(false);
    expect(status.result?.content?.[0].text).toContain("No active AI-DLC workflow found.");
    expect(JSON.parse(readFileSync(join(f.project, "aidlc/.aidlc-sessions", `crew-${hash}.binding.json`), "utf8")).intent).toBeNull();
    expect(existsSync(join(f.project, "aidlc/spaces/default/intents/intents.json"))).toBe(false);
  } finally { await client?.close(); cleanupTestProject(f.root); }
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
