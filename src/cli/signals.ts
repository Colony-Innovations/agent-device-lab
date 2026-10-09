const EXIT_CODES: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

let terminating = false;

/**
 * Call before a command exits by itself: when a termination signal is already being handled, wait for
 * its handler to finish and exit with the signal's code instead of the command's own.
 */
export async function holdIfTerminating(): Promise<void> {
  if (terminating) await new Promise<never>(() => undefined);
}

/**
 * Commands that run a Lab in this process (`run`, `scan --project`) own a browser and services. On the
 * first SIGINT, SIGTERM or SIGHUP, run `cleanup` (close the lab: stops what it started) and exit with the
 * conventional 128 + signal code. A second signal exits at once with 1 and says what may be left running.
 * Returns a function that removes the handlers.
 */
export function onTermination(cleanup: (signal: NodeJS.Signals) => Promise<void>, opts: { stateDir?: string } = {}): () => void {
  let received: NodeJS.Signals | undefined;
  const handler = (signal: NodeJS.Signals) => {
    if (received) {
      process.stderr.write(`agentlab: ${signal} again; exiting now. The browser and the services this run started may still be running; ` +
        `run \`agentlab clean\`${opts.stateDir ? ` (state: ${opts.stateDir})` : ''} to stop what is left.\n`);
      process.exit(1);
    }
    received = signal;
    terminating = true;
    process.stderr.write(`agentlab: ${signal} received; stopping what this run started (send it again to exit immediately)\n`);
    void cleanup(signal)
      .catch((err) => process.stderr.write(`agentlab: cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`))
      .finally(() => process.exit(EXIT_CODES[signal] ?? 1));
  };
  const signals = Object.keys(EXIT_CODES) as NodeJS.Signals[];
  for (const s of signals) process.on(s, handler);
  return () => { for (const s of signals) process.off(s, handler); };
}
