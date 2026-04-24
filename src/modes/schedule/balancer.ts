export type ScheduleSpec =
  | { kind: "hourly" }
  | { kind: "daily" }
  | { kind: "weekly" }
  | { kind: "interval"; hours: number };

export function parseHumanSchedule(schedule: string): ScheduleSpec {
  const s = schedule.toLowerCase().trim();
  if (s === "hourly") return { kind: "hourly" };
  if (s === "daily") return { kind: "daily" };
  if (s === "weekly") return { kind: "weekly" };
  const m = s.match(/^every\s+(\d+)\s+hours?$/);
  if (m) {
    const hours = parseInt(m[1]);
    if (![2, 3, 4, 6, 8, 12].includes(hours)) {
      throw new Error(
        `Interval ${hours}h doesn't divide 24 evenly. Use: 2, 3, 4, 6, 8, or 12.`,
      );
    }
    return { kind: "interval", hours };
  }
  throw new Error(
    `Unknown schedule "${schedule}". Use: hourly, daily, weekly, every N hours (N must divide 24)`,
  );
}

/**
 * Parse a cron expression into the hours-of-day it fires.
 * Handles: "0 3 * * *", "0 0,3,6 * * *", "* * * * *", "30 * * * *"
 */
function cronToRunHours(cron: string): number[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return [];
  const hourPart = parts[1];
  if (!hourPart || hourPart === "*") return Array.from({ length: 24 }, (_, i) => i);
  if (hourPart.startsWith("*/")) {
    const step = parseInt(hourPart.slice(2));
    const hours: number[] = [];
    for (let h = 0; h < 24; h += step) hours.push(h);
    return hours;
  }
  return hourPart.split(",").map(Number).filter((h) => h >= 0 && h < 24);
}

function cronToRunDay(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const dayPart = parts[4];
  if (!dayPart || dayPart === "*") return null;
  const day = parseInt(dayPart);
  return isNaN(day) ? null : day;
}

/**
 * Build a 24-element array counting how many existing tasks fire at each hour.
 */
function buildHourLoad(existingCrons: string[]): number[] {
  const load = new Array(24).fill(0) as number[];
  for (const cron of existingCrons) {
    for (const h of cronToRunHours(cron)) {
      load[h] = (load[h] ?? 0) + 1;
    }
  }
  return load;
}

/**
 * Given a desired schedule and all existing cron expressions, return a balanced
 * cron expression that minimises concurrency with the existing ones.
 */
export function assignCronExpression(
  schedule: ScheduleSpec,
  existingCrons: string[],
): string {
  const hourLoad = buildHourLoad(existingCrons);

  switch (schedule.kind) {
    case "hourly": {
      // Spread across minute offsets (0-59) using prime step to distribute
      const hourlyCount = existingCrons.filter((c) =>
        c.trim().startsWith("*"),
      ).length;
      const minute = (hourlyCount * 7) % 60;
      return `${minute} * * * *`;
    }

    case "daily": {
      // Pick the hour of day with minimum existing load.
      // Prefer daytime (2–22) to avoid midnight thundering herd.
      let best = 2;
      let minLoad = Infinity;
      for (let h = 0; h < 24; h++) {
        const load = hourLoad[h] ?? 0;
        if (load < minLoad) {
          minLoad = load;
          best = h;
        }
      }
      return `0 ${best} * * *`;
    }

    case "interval": {
      const { hours } = schedule;
      // For every-N-hours, find the offset (0..N-1) that minimises total load
      // across all the hours it would fire.
      let bestOffset = 0;
      let minConflicts = Infinity;
      for (let offset = 0; offset < hours; offset++) {
        const runHours: number[] = [];
        for (let h = offset; h < 24; h += hours) runHours.push(h);
        const conflicts = runHours.reduce((s, h) => s + (hourLoad[h] ?? 0), 0);
        if (conflicts < minConflicts) {
          minConflicts = conflicts;
          bestOffset = offset;
        }
      }
      const runHours: number[] = [];
      for (let h = bestOffset; h < 24; h += hours) runHours.push(h);
      return `0 ${runHours.join(",")} * * *`;
    }

    case "weekly": {
      // 7x24 grid — find the day+hour pair with minimum load.
      // Build day-level load from existing weekly crons.
      const dayLoad = new Array(7).fill(0) as number[];
      for (const cron of existingCrons) {
        const day = cronToRunDay(cron);
        if (day !== null && day >= 0 && day < 7) {
          dayLoad[day] = (dayLoad[day] ?? 0) + 1;
        }
      }
      let bestDay = 1;
      let bestHour = 3;
      let minLoad = Infinity;
      for (let day = 0; day < 7; day++) {
        for (let h = 0; h < 24; h++) {
          const load = (dayLoad[day] ?? 0) + (hourLoad[h] ?? 0);
          if (load < minLoad) {
            minLoad = load;
            bestDay = day;
            bestHour = h;
          }
        }
      }
      return `0 ${bestHour} * * ${bestDay}`;
    }
  }
}
