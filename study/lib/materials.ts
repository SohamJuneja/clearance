/**
 * Participant-facing text. BRIEFING, CONSENT and RECRUITMENT are verbatim from PLAN 11.6 and Appendix C,
 * and test/materials.test.ts holds them to the plan. The plan gives no verbatim debrief, only what it
 * must do (11.6 step 6), so that text is written here to do exactly that.
 */

export const BRIEFING =
  "You are the finance and engineering lead at a small company. AI agents send you requests to approve. Approve what is right and deny what is wrong. Scoring: +1 for each correct decision, −3 for approving a bad request, −1 for denying a good one. Work at a normal pace.";

export const CONSENT =
  "You will review 24 example requests from AI agents and approve or deny them. We record your decisions, how long each took, two confidence ratings, one short comment, your self-described role and how familiar you are with Slack-like tools. We do not record your name with your answers; you get an ID like p07. You can stop at any time. All requests and data are fictional. Raw results are deleted after the hackathon is judged; only totals are published. You must be 18 or older.";

/** The plan's consent ends with a checkbox line. The app draws this as a real checkbox. */
export const CONSENT_AGREE = "I agree.";

export const RECRUITMENT =
  "Hi! We're building Clearance for the Flip the Switch hackathon: it decides who should approve what an AI agent wants to do. We need 15 minutes of your time on Fri Nov 6 (21:00–23:30 IST) or Sat Nov 7 (09:30–12:30 IST). You'll approve or deny 24 short requests in a chat window in your browser. No install, no personal data, no real money. Pick a slot here: <form link>. Thank you!";

export const REPLICA_NOTICE =
  "These cards are replicas of real Switch approval cards, styled like a Mattermost thread. They are not live: no agent is waiting and nothing you choose will run.";

/** PLAN 11.4: a self-reported role, and familiarity with Slack-like tools from 1 to 5. */
export const ROLE_OPTIONS = ["student developer", "working developer", "other"] as const;
export const FAMILIARITY_QUESTION = "How familiar are you with Slack-like tools? (1 = not at all, 5 = use them daily)";

export const CONFIDENCE_QUESTION = "How confident are you in the decisions you just made? (1 = guessing, 5 = certain)";

/** Verbatim from PLAN 11.6 step 5. */
export const FREE_TEXT_QUESTION = "Which card helped you decide, and why?";
export const FREE_TEXT_HINT = "Please don't include your name or anyone else's.";

export const BREAK_SECONDS = 30;

export const DEBRIEF_THANKS = "That's the end of the study. Thank you for your time.";
export const DEBRIEF_MISSED_INTRO = "These were flawed requests that you approved:";
export const DEBRIEF_NONE_MISSED = "You didn't approve any of the flawed requests.";
export const DEBRIEF_ACKNOWLEDGE =
  "We don't record names here, so nobody is scored publicly. If you'd like to be thanked by name in the project's README, tell the person who sent you this link. Otherwise you won't be named.";
export const DEBRIEF_DATA = "Raw results are deleted after the hackathon is judged; only totals are published.";

export const STOPPED_MESSAGE = "You've stopped the study. Nothing else will be recorded. Thank you for your time.";
