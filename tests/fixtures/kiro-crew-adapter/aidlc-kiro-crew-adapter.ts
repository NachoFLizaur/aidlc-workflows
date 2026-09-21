// Dispatcher contract fixture, not a Crew hook implementation.
export function run(target: string, input: string, extraArgs: string[]): number {
  process.stdout.write(`${JSON.stringify({
    target,
    input,
    extraArgs,
    harnessName: process.env.AIDLC_HARNESS_NAME,
    harnessDir: process.env.AIDLC_HARNESS_DIR,
  })}\n`);
  return 0;
}
