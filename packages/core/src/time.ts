/** Everything about wall-clock time in a named zone, used by business hours, rotas and card copy. */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function zonedParts(ms: number, tz: string): { day: number; minutes: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(read("hour"));
  const minute = Number(read("minute"));
  return {
    day: DAY_NAMES.indexOf(read("weekday")),
    minutes: hour * 60 + minute,
    hhmm: `${read("hour").padStart(2, "0")}:${read("minute").padStart(2, "0")}`,
  };
}

function hhmmToMinutes(text: string): number {
  const [hour, minute] = text.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

export type Schedule = { days?: string | undefined; hours?: string | undefined; tz?: string | undefined };

/** "Mon-Fri" or "Mon,Wed,Fri". No `days` means every day. */
function dayMatches(days: string | undefined, day: number): boolean {
  if (!days) return true;
  return days.split(",").some((part) => {
    const [from, to] = part.trim().split("-");
    const start = DAY_NAMES.indexOf(from ?? "");
    if (to === undefined) return start === day;
    const end = DAY_NAMES.indexOf(to);
    return start <= end ? day >= start && day <= end : day >= start || day <= end;
  });
}

/** "09:00-19:00" in `tz`. No `hours` means all day. */
export function withinSchedule(schedule: Schedule, ms: number, defaultTz: string): boolean {
  const { day, minutes } = zonedParts(ms, schedule.tz ?? defaultTz);
  if (!dayMatches(schedule.days, day)) return false;
  if (!schedule.hours) return true;
  const [from, to] = schedule.hours.split("-");
  return minutes >= hhmmToMinutes(from ?? "00:00") && minutes < hhmmToMinutes(to ?? "24:00");
}

export function isFridayAfter(hhmm: string, ms: number, tz: string): boolean {
  const { day, minutes } = zonedParts(ms, tz);
  return day === 5 && minutes >= hhmmToMinutes(hhmm);
}

const ZONE_LABELS: Record<string, string> = { "Asia/Kolkata": "IST", UTC: "UTC" };

export function formatClock(ms: number, tz: string): string {
  return zonedParts(ms, tz).hhmm;
}

/** "15:42 IST" */
export function formatClockWithZone(ms: number, tz: string): string {
  return `${formatClock(ms, tz)} ${ZONE_LABELS[tz] ?? tz}`;
}

/** "4 minutes ago", "3 hours ago", "12 days ago". */
export function formatAgeHours(hours: number): string {
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  if (hours < 48) {
    const whole = Math.round(hours);
    return `${whole} ${whole === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** "3 minutes" from a policy duration in milliseconds. */
export function formatPolicyMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
