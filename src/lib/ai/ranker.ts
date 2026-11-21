import type { Priority, Trip, TripBadge } from '@/types';

import { adjustTrip, type EtaModel } from './eta-model';
import { tripFeatures } from './features';
import { cost, effectiveWeights, type PrefModel } from './preferences';

export interface RankContext {
  prefs: PrefModel;
  eta: EtaModel;
  priority: Priority;
  /** When the commuter travels; picks the traffic slot for learned corrections. */
  at: Date;
}

/** Minutes a trip takes after SakAI's corrections (falls back to the raw estimate). */
export const tripMinutes = (t: Trip) => t.ai?.adjustedMinutes ?? t.totalMinutes;

/**
 * Re-ranks the planner's candidate trips for this commuter: learned travel times,
 * learned preferences and any priority they asked for decide the order, and each trip
 * gets badges saying where it wins. The planner stays the source of candidates, so
 * every trip is still one that runs on routes in the data.
 */
export function rankTrips(trips: Trip[], ctx: RankContext): Trip[] {
  const weights = effectiveWeights(ctx.prefs, ctx.priority);
  const scored = trips.map((trip) => {
    const adj = adjustTrip(trip, ctx.eta, ctx.at);
    return { trip, adj, cost: cost(weights, tripFeatures(trip, adj.minutes)) };
  });
  scored.sort((a, b) => a.cost - b.cost || a.trip.totalFare - b.trip.totalFare);

  const winners = (metric: (i: number) => number): Set<number> => {
    const values = scored.map((_, i) => metric(i));
    const min = Math.min(...values);
    const max = Math.max(...values);
    // A badge that every trip shares says nothing.
    if (scored.length < 2 || max - min < 1e-6) return new Set();
    return new Set(values.flatMap((v, i) => (v - min < 1e-6 ? [i] : [])));
  };
  const fastest = winners((i) => scored[i].adj.minutes);
  const cheapest = winners((i) => scored[i].trip.totalFare);
  const direct = winners((i) => scored[i].trip.transfers);
  const lightWalk = winners((i) => scored[i].trip.walkMeters);

  return scored.map(({ trip, adj, cost: c }, i) => {
    const badges: TripBadge[] = [];
    if (i === 0 && scored.length > 1) badges.push('best_for_you');
    if (fastest.has(i)) badges.push('fastest');
    if (cheapest.has(i)) badges.push('cheapest');
    if (direct.has(i)) badges.push('fewest_transfers');
    if (lightWalk.has(i)) badges.push('least_walking');
    return {
      ...trip,
      ai: {
        adjustedMinutes: adj.minutes,
        minutesLow: adj.low,
        minutesHigh: adj.high,
        confidence: adj.confidence,
        cost: c,
        badges,
      },
    };
  });
}
