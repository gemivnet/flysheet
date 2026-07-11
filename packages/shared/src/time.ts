/**
 * G3X logs local date/time plus a UTC offset column. Convert to UTC at parse
 * time; everything downstream is UTC only.
 */

const OFFSET_RE = /^([+-]?)(\d{1,2}):(\d{2})$/;

/** Parse a G3X UTCOfst cell like "-05:00" or "+00:00" into minutes east of UTC. */
export function parseUtcOffsetMinutes(raw: string): number | null {
  const m = OFFSET_RE.exec(raw.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2]);
  const mins = Number(m[3]);
  if (hours > 14 || mins > 59) return null;
  return sign * (hours * 60 + mins);
}

/**
 * Combine "Lcl Date" (yyyy-mm-dd), "Lcl Time" (hh:mm:ss) and UTCOfst into a UTC Date.
 * local = UTC + offset, so UTC = local - offset. Returns null on malformed input.
 */
export function parseG3xTimestamp(
  lclDate: string,
  lclTime: string,
  utcOffset: string,
): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lclDate.trim());
  const tm = /^(\d{2}):(\d{2}):(\d{2})$/.exec(lclTime.trim());
  const offsetMin = parseUtcOffsetMinutes(utcOffset);
  if (!dm || !tm || offsetMin === null) return null;
  const asUtcMs = Date.UTC(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
    Number(tm[3]),
  );
  return new Date(asUtcMs - offsetMin * 60_000);
}

/** Format a UTC instant back into G3X local date/time cells for a given offset. */
export function formatG3xLocal(
  utc: Date,
  offsetMinutes: number,
): { lclDate: string; lclTime: string; utcOfst: string } {
  const local = new Date(utc.getTime() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const lclDate = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const lclTime = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const utcOfst = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return { lclDate, lclTime, utcOfst };
}
