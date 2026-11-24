import type { Hmn } from "../hmn";
import { runDue } from "./run";

/** The mini runs due workers once a minute. A failed run does not stop the server. */
export function startWorkerLoop(hmn: Hmn): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runDue(hmn)
      .catch(() => {
        console.error("hmn worker run failed");
      })
      // Each calendar is read at most once in its interval. The method records a failure and does not throw.
      .then(() => hmn.mirrorCalendars())
      .catch(() => {
        console.error("hmn calendar mirror failed");
      })
      .then(() => {
        hmn.backupIfDue();
      })
      .catch(() => {
        console.error("hmn daily backup failed");
      })
      .finally(() => {
        running = false;
      });
  }, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
