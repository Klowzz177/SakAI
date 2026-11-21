/**
 * Manila clock helpers for SakAI. Manila is UTC+8 with no DST. Kept free of map and
 * geometry imports so the learning code stays light and easy to test.
 */

const MANILA_UTC_OFFSET_H = 8;

export function manilaParts(date: Date): { hour: number; weekend: boolean } {
  const shifted = new Date(date.getTime() + MANILA_UTC_OFFSET_H * 3600_000);
  const day = shifted.getUTCDay();
  return {
    hour: shifted.getUTCHours() + shifted.getUTCMinutes() / 60,
    weekend: day === 0 || day === 6,
  };
}

/**
 * Coarse time-of-day slot a learned correction applies to: weekday or weekend, plus the
 * morning rush, midday, evening rush or night.
 */
export function timeBucket(date: Date): string {
  const { hour, weekend } = manilaParts(date);
  const slot = hour >= 5 && hour < 10 ? 'am' : hour >= 10 && hour < 16 ? 'mid' : hour >= 16 && hour < 21 ? 'pm' : 'night';
  return `${weekend ? 'we' : 'wd'}-${slot}`;
}

/** "7:30 AM" for a decimal Manila hour such as 7.5. */
export function formatHour(hour: number): string {
  const total = Math.round(hour * 60) % (24 * 60);
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** "7:42 AM" in Manila time. */
export const formatManilaTime = (date: Date) => formatHour(manilaParts(date).hour);
