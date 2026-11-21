import type { Priority, Trip } from '@/types';

import { tripMinutes } from './ranker';
import { profileOf, type Leaning, type PrefModel } from './preferences';

/**
 * Why a trip ranks where it does, as structured facts. The UI words them per language
 * (i18n `ai.reasons`), so nothing here is English text.
 */
export type Reason =
  | { id: 'priority'; priority: Priority }
  | { id: 'profile'; leaning: Exclude<Leaning, 'balanced'> }
  /** a > 0: this many minutes faster than the reference; a < 0: slower. */
  | { id: 'time'; a: number }
  /** a > 0: this many pesos cheaper than the reference; a < 0: dearer. */
  | { id: 'fare'; a: number }
  /** a > 0: this many fewer transfers; a < 0: more. */
  | { id: 'transfers'; a: number }
  /** a > 0: this many metres less walking; a < 0: more. */
  | { id: 'walk'; a: number }
  /** SakAI's learned correction to the schedule time, in minutes (positive means slower than scheduled). */
  | { id: 'learned_time'; a: number }
  /** Share (percent) of riding time in heavy traffic. */
  | { id: 'traffic_heavy'; a: number }
  | { id: 'unverified' };

export interface Explanation {
  /** Compared against: the next-best trip for the top pick, otherwise the top pick. */
  versus: 'next' | 'top' | 'none';
  reasons: Reason[];
}

const MAX_REASONS = 4;

/** Facts on why `tripId` ranks where it does among `trips` (already ranked). */
export function explainTrip(trips: Trip[], tripId: string, priority: Priority, prefs: PrefModel): Explanation {
  const idx = trips.findIndex((t) => t.id === tripId);
  if (idx < 0) return { versus: 'none', reasons: [] };
  const trip = trips[idx];
  const reference = idx === 0 ? trips[1] : trips[0];
  const reasons: Reason[] = [];

  if (idx === 0 && priority !== 'balanced') reasons.push({ id: 'priority', priority });
  const { leaning } = profileOf(prefs);
  if (idx === 0 && leaning && leaning !== 'balanced') reasons.push({ id: 'profile', leaning });

  if (reference) {
    const dMin = Math.round(tripMinutes(reference) - tripMinutes(trip));
    if (Math.abs(dMin) >= 2) reasons.push({ id: 'time', a: dMin });
    const dFare = reference.totalFare - trip.totalFare;
    if (Math.abs(dFare) >= 0.5) reasons.push({ id: 'fare', a: Math.round(dFare * 4) / 4 });
    const dTransfers = reference.transfers - trip.transfers;
    if (dTransfers !== 0) reasons.push({ id: 'transfers', a: dTransfers });
    const dWalk = Math.round((reference.walkMeters - trip.walkMeters) / 50) * 50;
    if (Math.abs(dWalk) >= 100) reasons.push({ id: 'walk', a: dWalk });
  }

  if (trip.ai && trip.ai.confidence >= 0.3) {
    const shift = Math.round(trip.ai.adjustedMinutes - trip.totalMinutes);
    if (Math.abs(shift) >= 2) reasons.push({ id: 'learned_time', a: shift });
  }
  const rideMin = trip.legs.reduce((s, l) => (l.kind === 'ride' ? s + l.minutes : s), 0);
  const heavyMin = trip.legs.reduce(
    (s, l) => (l.kind === 'ride' && (l.trafficLevel === 'heavy' || l.trafficLevel === 'standstill') ? s + l.minutes : s),
    0
  );
  if (rideMin > 0 && heavyMin / rideMin >= 0.5) {
    reasons.push({ id: 'traffic_heavy', a: Math.round((heavyMin / rideMin) * 100) });
  }
  if (trip.legs.some((l) => (l.kind === 'ride' ? l.unverified : !!l.link?.unverified))) {
    reasons.push({ id: 'unverified' });
  }

  return {
    versus: reference ? (idx === 0 ? 'next' : 'top') : 'none',
    reasons: reasons.slice(0, MAX_REASONS),
  };
}
