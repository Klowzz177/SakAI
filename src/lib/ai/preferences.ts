import type { Priority } from '@/types';

import { FEATURE_KEYS, type Features } from './features';

/**
 * Learns what each commuter values. A trip's cost is a weighted sum of its features in
 * minute-equivalents ("₱10 is worth about 8 minutes to me"). Every time the commuter
 * picks one trip over the alternatives, the weights are nudged so the chosen trip would
 * have ranked higher: online logistic regression on pairwise choices (Bradley–Terry).
 */

export const PRIOR_WEIGHTS: Features = {
  time: 10,
  fare: 8,
  transfers: 5,
  walk: 4,
  unverified: 3,
  traffic: 6,
};

export interface PrefModel {
  weights: Features;
  /** Trips the commuter has chosen so far. */
  choices: number;
}

export function initialPrefs(): PrefModel {
  return { weights: { ...PRIOR_WEIGHTS }, choices: 0 };
}

/** Multipliers applied on top of the learned weights when the commuter asks for something specific. */
export const PRIORITY_BOOST: Record<Priority, Partial<Features>> = {
  balanced: {},
  fastest: { time: 2, traffic: 1.5, fare: 0.4 },
  cheapest: { fare: 3, time: 0.5 },
  fewest_transfers: { transfers: 3 },
  least_walking: { walk: 3 },
};

export function cost(weights: Features, f: Features): number {
  let c = 0;
  for (const k of FEATURE_KEYS) c += weights[k] * f[k];
  return c;
}

export function effectiveWeights(prefs: PrefModel, priority: Priority): Features {
  const boost = PRIORITY_BOOST[priority];
  const out = { ...prefs.weights };
  for (const k of FEATURE_KEYS) out[k] = out[k] * (boost[k] ?? 1);
  return out;
}

/** How sharply a cost gap (minutes) separates a sure choice from a coin flip. */
const TEMPERATURE_MIN = 5;
/** Weight change, in minute-equivalents, for a surprising choice. */
const STEP = 1.2;
/** Pull back toward the prior on every update, so a few odd taps can't dominate. */
const REGULARIZATION = 0.02;
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * One SGD step per rejected alternative. If the commuter's current weights already
 * rank the chosen trip well ahead, almost nothing changes; a surprising pick moves
 * the weights of the features that differ between the two trips.
 */
export function learnFromChoice(model: PrefModel, chosen: Features, rejected: Features[]): PrefModel {
  if (rejected.length === 0) return { ...model, choices: model.choices + 1 };
  const w = { ...model.weights };
  for (const r of rejected) {
    const gap = cost(w, r) - cost(w, chosen);
    const surprise = 1 - sigmoid(gap / TEMPERATURE_MIN);
    for (const k of FEATURE_KEYS) {
      w[k] += (STEP * surprise * (r[k] - chosen[k])) / rejected.length;
    }
  }
  for (const k of FEATURE_KEYS) {
    const prior = PRIOR_WEIGHTS[k];
    w[k] += REGULARIZATION * (prior - w[k]);
    w[k] = Math.min(prior * MAX_RATIO, Math.max(prior * MIN_RATIO, w[k]));
  }
  return { weights: w, choices: model.choices + 1 };
}

export type Leaning = 'balanced' | 'time' | 'fare' | 'transfers' | 'walk';

/** Choices needed before SakAI says anything about the commuter's style. */
export const MIN_CHOICES_FOR_PROFILE = 3;

/** A one-word read on what the commuter seems to care about, or null while still learning. */
export function profileOf(model: PrefModel): { choices: number; leaning: Leaning | null } {
  if (model.choices < MIN_CHOICES_FOR_PROFILE) return { choices: model.choices, leaning: null };
  const candidates = ['time', 'fare', 'transfers', 'walk'] as const;
  let best: (typeof candidates)[number] = 'time';
  let bestRatio = 0;
  for (const k of candidates) {
    const ratio = model.weights[k] / PRIOR_WEIGHTS[k];
    if (ratio > bestRatio) {
      best = k;
      bestRatio = ratio;
    }
  }
  return { choices: model.choices, leaning: bestRatio >= 1.25 ? best : 'balanced' };
}

/** Restores a saved model; anything malformed falls back to the prior. */
export function parsePrefs(raw: unknown): PrefModel {
  const fallback = initialPrefs();
  if (!raw || typeof raw !== 'object') return fallback;
  const { weights, choices } = raw as { weights?: Record<string, unknown>; choices?: unknown };
  if (!weights || typeof choices !== 'number' || !Number.isFinite(choices)) return fallback;
  const out = { ...PRIOR_WEIGHTS };
  for (const k of FEATURE_KEYS) {
    const v = weights[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
    out[k] = Math.min(PRIOR_WEIGHTS[k] * MAX_RATIO, Math.max(PRIOR_WEIGHTS[k] * MIN_RATIO, v));
  }
  return { weights: out, choices: Math.max(0, Math.floor(choices)) };
}
