import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const suite = join(REPO_ROOT, "tests/unit/kiro-crew/test_routes.py");
const override = process.env.AIDLC_TEST_PYTHON312;
// An explicit interpreter is authoritative before any PATH discovery. Invalid
// overrides fail the test; only ordinary absence may skip. No bundle search.
function python312(candidate: string | null): string | undefined {
  if (!candidate || !isAbsolute(candidate)) return undefined;
  const result = spawnSync(candidate, ["-I", "-B", "-c", "import sys; print('.'.join(map(str, sys.version_info[:2])))"], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 5000, maxBuffer: 4096, killSignal: "SIGKILL",
  });
  return !result.error && result.status === 0 && result.stdout.trim() === "3.12" ? candidate : undefined;
}
const python = override !== undefined ? python312(override)
  : python312(Bun.which("python3.12")) ?? python312(Bun.which("python3"));
test.skipIf(override === undefined && !python)(python || override !== undefined
  ? "Python route admission, observation and subprocess lifecycle"
  : "Python 3.12 unavailable on PATH; set absolute AIDLC_TEST_PYTHON312 to run route tests", () => {
  expect(python, "AIDLC_TEST_PYTHON312 must be an executable absolute Python 3.12 interpreter").toBeDefined();
  const result = spawnSync(python!, ["-I", "-B", suite], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const names = [...readFileSync(suite, "utf8").matchAll(/^ {4}def (test_\w+)\(/gm)].map((match) => match[1]);
  expect(names.length).toBeGreaterThan(0);
  expect(result.stderr).toMatch(new RegExp(`Ran ${names.length} tests? in `));
  for (const name of names) expect(result.stderr).toMatch(new RegExp(`^${name} \\(.*\\) \\.\\.\\. (?:ok|skipped )`, "m"));
  expect(result.stderr).toMatch(/\nOK(?: \(skipped=\d+\))?\s*$/);
}, 135000);
