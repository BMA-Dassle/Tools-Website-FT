/**
 * Food-out time input helpers, ported verbatim from the portal's
 * EventMetadataPanel.tsx (parseTime + the quick-pick slot builder).
 */

/**
 * Forgiving time parser: "4:30pm", "430", "16:30", "3" (bare 1-6 assumed PM —
 * events run afternoons/evenings). Returns "h:mm AM/PM" or null when invalid.
 */
export function parseTime(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;

  let hours: number;
  let minutes: number;
  let isPM: boolean | null = null;

  if (s.endsWith("am") || s.endsWith("a.m.") || s.endsWith("a.m")) {
    isPM = false;
  } else if (s.endsWith("pm") || s.endsWith("p.m.") || s.endsWith("p.m")) {
    isPM = true;
  }

  const num = s.replace(/(a\.?m\.?|p\.?m\.?)$/i, "").trim();

  const colonMatch = num.match(/^(\d{1,2}):(\d{2})$/);
  if (colonMatch) {
    hours = parseInt(colonMatch[1], 10);
    minutes = parseInt(colonMatch[2], 10);
  } else if (/^\d{3,4}$/.test(num)) {
    const padded = num.padStart(4, "0");
    hours = parseInt(padded.substring(0, 2), 10);
    minutes = parseInt(padded.substring(2, 4), 10);
  } else if (/^\d{1,2}$/.test(num)) {
    hours = parseInt(num, 10);
    minutes = 0;
  } else {
    return null;
  }

  if (minutes < 0 || minutes > 59) return null;
  if (hours < 0 || hours > 23) return null;

  if (isPM === null) {
    if (hours === 0) {
      hours = 12;
      isPM = false;
    } else if (hours < 12) {
      isPM = false;
    } else if (hours === 12) {
      isPM = true;
    } else {
      hours -= 12;
      isPM = true;
    }
    if (hours >= 1 && hours <= 6 && isPM === false) {
      isPM = true;
    }
  } else {
    if (hours === 12) {
      hours = 12;
    } else if (hours > 12) return null;
    if (hours === 0) return null;
  }

  const suffix = isPM ? "PM" : "AM";
  const mm = minutes.toString().padStart(2, "0");
  return `${hours}:${mm} ${suffix}`;
}

/**
 * Nine half-hour quick-pick slots from the event start time (portal
 * timeSlots memo). Accepts an ISO string or an "h:mm AM/PM" string;
 * falls back to noon.
 */
export function buildTimeSlots(startTime: string): string[] {
  const slots: string[] = [];
  const d = new Date(startTime);
  let startHour: number;
  let startMin: number;

  if (!isNaN(d.getTime())) {
    startHour = d.getHours();
    startMin = d.getMinutes();
  } else {
    const match = startTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const pm = match[3].toUpperCase() === "PM";
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      startHour = h;
      startMin = m;
    } else {
      startHour = 12;
      startMin = 0;
    }
  }

  if (startMin > 0 && startMin < 30) startMin = 0;
  else if (startMin > 30) {
    startMin = 0;
    startHour++;
  } else if (startMin === 30) startMin = 30;

  for (let i = 0; i < 9; i++) {
    const h = startHour + Math.floor((startMin + i * 30) / 60);
    const m = (startMin + i * 30) % 60;
    if (h >= 24) break;
    const ampm = h >= 12 ? "PM" : "AM";
    const displayH = h > 12 ? h - 12 : h === 0 ? 12 : h;
    slots.push(`${displayH}:${m.toString().padStart(2, "0")} ${ampm}`);
  }

  return slots;
}
