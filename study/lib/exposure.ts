/**
 * Is it safe to put this Mattermost on a public tunnel? Pure, so the rules can be tested without a
 * server. Anything not proven closed counts as open: a missing setting, an unexpected answer, an error.
 */

export const SIGNUP_SETTINGS = ["EnableOpenServer", "EnableUserCreation", "EnableSignUpWithEmail"] as const;

/** Why the public config does not show signup off, or null if it does. Mattermost sends "true"/"false". */
export function configProblem(config: Record<string, unknown>): string | null {
  const notOff = SIGNUP_SETTINGS.filter((setting) => config[setting] !== "false");
  return notOff.length > 0 ? `not shown as off: ${notOff.join(", ")}` : null;
}

export type SignupAttempt = { status: number; id?: string };

/**
 * Whether a real attempt to sign up was refused because signup is off. A 400 can mean the attempt itself
 * was badly formed, which proves nothing, so a refusal only counts if Mattermost says that is why.
 */
export function attemptProblem(attempt: SignupAttempt): string | null {
  if (attempt.status >= 200 && attempt.status < 300) return `an anonymous signup succeeded (HTTP ${attempt.status})`;
  const refusedForSignup = /signup|sign_up|user_creation|open_server|disabled|no_open_server|not_enabled/i.test(attempt.id ?? "");
  if ((attempt.status === 403 || attempt.status === 501) && refusedForSignup) return null;
  return `the attempt was refused, but not clearly because signup is off (HTTP ${attempt.status}, ${attempt.id ?? "no reason given"})`;
}
