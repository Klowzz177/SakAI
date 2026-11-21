import type { RideLeg, Trip } from '@/types';

/**
 * The things SakAI weighs when comparing trips. Each is scaled so that one unit is a
 * "noticeable" amount (10 min, ₱10, one transfer, 300 m of walking), which keeps the
 * learned weights comparable with each other.
 */
export const FEATURE_KEYS = ['time', 'fare', 'transfers', 'walk', 'unverified', 'traffic'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, number>;

export const FEATURE_SCALE: Record<FeatureKey, number> = {
  time: 10,
  fare: 10,
  transfers: 1,
  walk: 300,
  unverified: 1,
  traffic: 1,
};

const isRide = (l: Trip['legs'][number]): l is RideLeg => l.kind === 'ride';

/** Scaled features of a trip, using SakAI's adjusted travel time rather than the raw estimate. */
export function tripFeatures(trip: Trip, adjustedMinutes: number): Features {
  const rides = trip.legs.filter(isRide);
  const rideMin = rides.reduce((s, r) => s + r.minutes, 0);
  const heavyMin = rides
    .filter((r) => r.trafficLevel === 'heavy' || r.trafficLevel === 'standstill')
    .reduce((s, r) => s + r.minutes, 0);
  const unverified = trip.legs.filter((l) => (isRide(l) ? l.unverified : !!l.link?.unverified)).length;
  return {
    time: adjustedMinutes / FEATURE_SCALE.time,
    fare: trip.totalFare / FEATURE_SCALE.fare,
    transfers: trip.transfers / FEATURE_SCALE.transfers,
    walk: trip.walkMeters / FEATURE_SCALE.walk,
    unverified,
    // Share of riding time spent in heavy traffic: the part of an ETA most likely to slip.
    traffic: rideMin > 0 ? heavyMin / rideMin : 0,
  };
}
