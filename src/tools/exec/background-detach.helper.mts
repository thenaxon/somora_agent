// Helper for background-jobs.test.mts — NOT a test itself.
//
// Spawns ONE local background job and exits immediately, simulating
// the MCP-child/tool-host process dying between turns (the 2026-07-27
// report scenario). The test then verifies from the OUTSIDE that the
// job survived and that probeLocalJob resolves its state correctly.
//
// Usage: SOMORA_HOME=<dir> npx tsx background-detach.helper.mts <agent> <command>
// Prints the job_id on stdout and exits without waiting.

const agent = process.argv[2];
const command = process.argv[3];
if (!agent || !command) {
  console.error('usage: background-detach.helper.mts <agent> <command>');
  process.exit(2);
}

// Dynamic import AFTER env is set by the caller — job-store reads
// SOMORA_HOME at module load.
const { localExecBackground } = await import('./local.ts');

const result = await localExecBackground({ agent, command });
console.log(result.job_id);
// Exit hard and immediately — do NOT wait for the job. unref() on the
// child means the event loop won't keep us alive anyway, but the
// explicit exit mirrors a killed tool-host most closely.
process.exit(0);
