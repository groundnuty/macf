/**
 * The banner printed before every prompt that waits for the operator, so the
 * wait is not lost at the bottom of a long plan. While the prompt waits it is
 * repeated every `REMINDER_INTERVAL_MS`, at most `MAX_REMINDERS` times.
 */

export const REMINDER_INTERVAL_MS = 60_000;
export const MAX_REMINDERS = 10;

/** One banner line. */
export function actionNeededBanner(what: string): string {
  return `▶ ACTION NEEDED: ${what}`;
}

/**
 * Writes a blank line and the banner, then starts the reminder timer.
 * Returns a function that stops the timer; call it when the prompt is answered.
 */
export function announceOperatorWait(
  what: string,
  write: (text: string) => void = (t) => void process.stderr.write(t),
  setTimer: typeof setInterval = setInterval,
  clearTimer: typeof clearInterval = clearInterval,
): () => void {
  const banner = actionNeededBanner(what);
  write(`\n${banner}\n`);
  let count = 0;
  const timer = setTimer(() => {
    count += 1;
    write(`\n${banner} (still waiting)\n`);
    if (count >= MAX_REMINDERS) clearTimer(timer);
  }, REMINDER_INTERVAL_MS);
  // Never keep the process alive for a reminder.
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimer(timer);
}
