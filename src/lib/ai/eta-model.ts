import type { RideLeg, Trip } from '@/types';

import { timeBucket } from './time';

/**
 * Learns how long rides really take. The schedule model (distance, vehicle speed and the
 * demo traffic feed) is only a first guess, so SakAI keeps, per route and time-of-day slot,
 * the running mean and spread of log(actual / predicted) from trips commuters report.
 * Estimates are shrunk toward "the model is right" until enough reports back them.
 */

export interface RatioStat {
  /** Weighted number of observations. */
  n: number;
  /** Mean of ln(actual / predicted). */
  mean: number;
  /** Weighted sum of squared deviations (for the variance). */
  m2: number;
}

export interface EtaModel {
  stats: Record<string, RatioStat>;
  /** Trip reports the model has learned from. */
  reports: number;
}

/** Pseudo-observations of "the model is right" that new data has to outweigh. */
const SHRINK_K = 3;
/** Spread of ln(actual / predicted) assumed before any data: about ±15%. */
const PRIOR_SD = 0.15;
/** Extra uncertainty on community routes nobody has confirmed. */
const UNVERIFIED_SD = 0.1;
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 2.5;
const MAX_KEYS = 200;

export const initialEta = (): EtaModel => ({ stats: {}, reports: 0 });

const keyOf = (routeId: string, bucket: string) => `${routeId}|${bucket}`;

export interface Correction {
  /** Multiplier for the model's ride minutes. */
  factor: number;
  /** Relative spread (standard deviation of the log ratio). */
  sd: number;
  /** 0..1, how far the data outweighs the prior. */
  confidence: number;
}

export function correctionFor(model: EtaModel, routeId: string, bucket: string): Correction {
  const s = model.stats[keyOf(routeId, bucket)];
  if (!s || s.n <= 0) return { factor: 1, sd: PRIOR_SD, confidence: 0 };
  const shrink = s.n / (s.n + SHRINK_K);
  return {
    factor: Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, Math.exp(s.mean * shrink))),
    sd: Math.sqrt((s.m2 + SHRINK_K * PRIOR_SD ** 2) / (s.n + SHRINK_K)),
    confidence: shrink,
  };
}

export interface AdjustedTime {
  minutes: number;
  low: number;
  high: number;
  confidence: number;
}

/** A trip's time with learned per-route corrections, plus a likely range and how much data backs it. */
export function adjustTrip(trip: Trip, model: EtaModel, at: Date): AdjustedTime {
  const bucket = timeBucket(at);
  let minutes = 0;
  let varianceMin2 = 0;
  let rideMin = 0;
  let confWeighted = 0;
  for (const leg of trip.legs) {
    if (leg.kind === 'walk') {
      minutes += leg.minutes;
      continue;
    }
    const c = correctionFor(model, leg.routeId, bucket);
    const adjusted = leg.minutes * c.factor;
    const sd = Math.sqrt(c.sd ** 2 + (leg.unverified ? UNVERIFIED_SD ** 2 : 0));
    minutes += adjusted;
    varianceMin2 += (adjusted * sd) ** 2;
    rideMin += leg.minutes;
    confWeighted += leg.minutes * c.confidence;
  }
  const spread = Math.sqrt(varianceMin2);
  return {
    minutes,
    low: Math.max(1, minutes - spread),
    high: minutes + spread,
    confidence: rideMin > 0 ? confWeighted / rideMin : 0,
  };
}

export interface ReportedTrip {
  rides: Pick<RideLeg, 'routeId' | 'minutes'>[];
  /** Minutes of walking in the plan; assumed to be predicted well. */
  walkMinutes: number;
  /** Minutes the commuter says the whole trip really took. */
  actualMinutes: number;
  at: Date;
}

/** Folds one reported trip into the model. Returns the model unchanged for implausible reports. */
export function observe(model: EtaModel, report: ReportedTrip): EtaModel {
  const { rides, walkMinutes, actualMinutes, at } = report;
  const predictedRide = rides.reduce((s, r) => s + r.minutes, 0);
  if (!Number.isFinite(actualMinutes) || actualMinutes < 1 || actualMinutes > 360) return model;
  if (predictedRide <= 0) return model;
  const actualRide = Math.max(actualMinutes - walkMinutes, actualMinutes * 0.2);
  const x = Math.log(Math.min(4, Math.max(0.3, actualRide / predictedRide)));

  const bucket = timeBucket(at);
  const stats = { ...model.stats };
  for (const ride of rides) {
    // A leg gets credit for the report in proportion to how much of the ride it was.
    const w = ride.minutes / predictedRide;
    const key = keyOf(ride.routeId, bucket);
    const prev = stats[key] ?? { n: 0, mean: 0, m2: 0 };
    const n = prev.n + w;
    const delta = x - prev.mean;
    const mean = prev.mean + (delta * w) / n;
    stats[key] = { n, mean, m2: prev.m2 + w * delta * (x - mean) };
  }
  return { stats: prune(stats), reports: model.reports + 1 };
}

/** Keeps the best-supported entries so the saved model stays small. */
function prune(stats: Record<string, RatioStat>): Record<string, RatioStat> {
  const keys = Object.keys(stats);
  if (keys.length <= MAX_KEYS) return stats;
  keys.sort((a, b) => stats[b].n - stats[a].n);
  return Object.fromEntries(keys.slice(0, MAX_KEYS).map((k) => [k, stats[k]]));
}

/** Restores a saved model; malformed entries are dropped. */
export function parseEta(raw: unknown): EtaModel {
  if (!raw || typeof raw !== 'object') return initialEta();
  const { stats, reports } = raw as { stats?: Record<string, unknown>; reports?: unknown };
  const out: Record<string, RatioStat> = {};
  for (const [k, v] of Object.entries(stats ?? {})) {
    const s = v as Partial<RatioStat> | null;
    if (
      s &&
      [s.n, s.mean, s.m2].every((x) => typeof x === 'number' && Number.isFinite(x)) &&
      (s.n as number) > 0 &&
      (s.m2 as number) >= 0
    ) {
      out[k] = { n: s.n as number, mean: s.mean as number, m2: s.m2 as number };
    }
  }
  return {
    stats: prune(out),
    reports: typeof reports === 'number' && Number.isFinite(reports) ? Math.max(0, Math.floor(reports)) : 0,
  };
}
