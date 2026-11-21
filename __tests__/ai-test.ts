import { compareDepartures, leaveBy } from '@/lib/ai/departure';
import { adjustTrip, correctionFor, initialEta, observe, parseEta } from '@/lib/ai/eta-model';
import { explainTrip } from '@/lib/ai/explain';
import { tripFeatures } from '@/lib/ai/features';
import {
  buildPlaceCatalog,
  emptyIntent,
  isEmptyIntent,
  mergeIntents,
  normalize,
  parseIntentLocal,
} from '@/lib/ai/intent';
import {
  cost,
  effectiveWeights,
  initialPrefs,
  learnFromChoice,
  parsePrefs,
  PRIOR_WEIGHTS,
  profileOf,
} from '@/lib/ai/preferences';
import { rankTrips } from '@/lib/ai/ranker';
import { formatHour, timeBucket } from '@/lib/ai/time';
import { landmarks } from '@/lib/dataSource';
import type { Leg, RideLeg, TrafficLevel, TransitRoute, Trip, WalkLeg } from '@/types';

const noon = new Date('2026-10-21T04:00:00Z'); // Wednesday noon, Manila
const places = buildPlaceCatalog([], landmarks);

function ride(routeId: string, minutes: number, opts: { traffic?: TrafficLevel; unverified?: boolean } = {}): RideLeg {
  return {
    kind: 'ride',
    routeId,
    routeName: routeId,
    vehicle: 'jeep',
    signboard: routeId.toUpperCase(),
    color: '#000',
    board: [121, 14.6],
    alight: [121.01, 14.6],
    boardName: null,
    alightName: null,
    km: minutes / 3,
    minutes,
    fare: 0,
    path: [],
    trafficLevel: opts.traffic ?? 'free',
    unverified: opts.unverified ?? false,
  };
}

function walk(minutes: number): WalkLeg {
  return { kind: 'walk', from: [121, 14.6], to: [121.01, 14.6], meters: minutes * 75, minutes, toName: null };
}

function trip(id: string, legs: Leg[], fare: number): Trip {
  const rides = legs.filter((l) => l.kind === 'ride');
  const walks = legs.filter((l): l is WalkLeg => l.kind === 'walk');
  return {
    id,
    legs,
    totalMinutes: legs.reduce((s, l) => s + l.minutes, 0),
    totalFare: fare,
    transfers: Math.max(0, rides.length - 1),
    walkMeters: walks.reduce((s, w) => s + w.meters, 0),
  };
}

const fastPricey = () => trip('fast', [walk(2), ride('fast-jeep', 18)], 25);
const slowCheap = () => trip('cheap', [walk(2), ride('cheap-jeep', 28)], 13);

describe('preferences', () => {
  it('learns to favour cheaper trips when the commuter keeps choosing them', () => {
    let prefs = initialPrefs();
    const fast = tripFeatures(fastPricey(), 20);
    const cheap = tripFeatures(slowCheap(), 30);
    for (let i = 0; i < 6; i++) prefs = learnFromChoice(prefs, cheap, [fast]);
    expect(prefs.choices).toBe(6);
    expect(prefs.weights.fare).toBeGreaterThan(PRIOR_WEIGHTS.fare);
    expect(prefs.weights.time).toBeLessThan(PRIOR_WEIGHTS.time);
    expect(cost(prefs.weights, cheap)).toBeLessThan(cost(prefs.weights, fast));
    expect(profileOf(prefs).leaning).toBe('fare');
  });

  it('barely moves when the choice already matches the ranking', () => {
    const prefs = initialPrefs();
    const better = tripFeatures(trip('a', [ride('a', 10)], 13), 10);
    const worse = tripFeatures(trip('b', [ride('b', 40)], 30), 40);
    const next = learnFromChoice(prefs, better, [worse]);
    expect(Math.abs(next.weights.time - prefs.weights.time)).toBeLessThan(0.1);
    expect(Math.abs(next.weights.fare - prefs.weights.fare)).toBeLessThan(0.1);
  });

  it('keeps weights within sane bounds however many odd choices come in', () => {
    let prefs = initialPrefs();
    const slow = tripFeatures(trip('s', [ride('s', 90)], 13), 90);
    const quick = tripFeatures(trip('q', [ride('q', 5)], 60), 5);
    for (let i = 0; i < 300; i++) prefs = learnFromChoice(prefs, slow, [quick]);
    expect(prefs.weights.time).toBeGreaterThan(PRIOR_WEIGHTS.time * 0.25 - 1e-9);
    expect(prefs.weights.fare).toBeLessThan(PRIOR_WEIGHTS.fare * 4 + 1e-9);
  });

  it('says nothing about style until it has seen a few choices', () => {
    expect(profileOf(initialPrefs()).leaning).toBeNull();
  });

  it('boosts the weights a priority cares about', () => {
    const base = initialPrefs();
    expect(effectiveWeights(base, 'cheapest').fare).toBeGreaterThan(base.weights.fare);
    expect(effectiveWeights(base, 'balanced')).toEqual(base.weights);
  });

  it('falls back to the prior on malformed saved data', () => {
    expect(parsePrefs(null)).toEqual(initialPrefs());
    expect(parsePrefs({ weights: { time: 'x' }, choices: 2 })).toEqual(initialPrefs());
    expect(parsePrefs(JSON.parse(JSON.stringify(learnFromChoice(initialPrefs(), tripFeatures(slowCheap(), 30), [])))).choices).toBe(1);
  });
});

describe('eta model', () => {
  it('trusts the schedule until commuters report otherwise', () => {
    const c = correctionFor(initialEta(), 'r1', timeBucket(noon));
    expect(c.factor).toBe(1);
    expect(c.confidence).toBe(0);
  });

  it('slows an estimate that commuters keep reporting as slower', () => {
    let eta = initialEta();
    for (let i = 0; i < 10; i++) {
      eta = observe(eta, { rides: [{ routeId: 'r1', minutes: 20 }], walkMinutes: 0, actualMinutes: 30, at: noon });
    }
    const c = correctionFor(eta, 'r1', timeBucket(noon));
    expect(c.factor).toBeGreaterThan(1.3);
    expect(c.factor).toBeLessThan(1.5);
    expect(c.confidence).toBeGreaterThan(0.7);
    expect(eta.reports).toBe(10);
  });

  it('moves only part of the way after a single report', () => {
    const eta = observe(initialEta(), { rides: [{ routeId: 'r1', minutes: 20 }], walkMinutes: 0, actualMinutes: 40, at: noon });
    const { factor } = correctionFor(eta, 'r1', timeBucket(noon));
    expect(factor).toBeGreaterThan(1);
    expect(factor).toBeLessThan(1.4);
  });

  it('keeps time-of-day slots apart', () => {
    const weekendNight = new Date('2026-10-24T15:00:00Z'); // Saturday 11 PM, Manila
    let eta = initialEta();
    for (let i = 0; i < 5; i++) {
      eta = observe(eta, { rides: [{ routeId: 'r1', minutes: 20 }], walkMinutes: 0, actualMinutes: 35, at: noon });
    }
    expect(correctionFor(eta, 'r1', timeBucket(weekendNight)).factor).toBe(1);
    expect(timeBucket(noon)).toBe('wd-mid');
    expect(timeBucket(weekendNight)).toBe('we-night');
  });

  it('ignores implausible reports', () => {
    const eta = initialEta();
    const base = { rides: [{ routeId: 'r1', minutes: 20 }], walkMinutes: 0, at: noon };
    expect(observe(eta, { ...base, actualMinutes: 0 })).toBe(eta);
    expect(observe(eta, { ...base, actualMinutes: 5000 })).toBe(eta);
    expect(observe(eta, { ...base, actualMinutes: NaN })).toBe(eta);
    expect(observe(eta, { ...base, rides: [], actualMinutes: 20 })).toBe(eta);
  });

  it('adjusts only the riding part and gives a range', () => {
    let eta = initialEta();
    for (let i = 0; i < 10; i++) {
      eta = observe(eta, { rides: [{ routeId: 'r1', minutes: 20 }], walkMinutes: 4, actualMinutes: 34, at: noon });
    }
    const t = trip('t', [walk(4), ride('r1', 20)], 13);
    const adj = adjustTrip(t, eta, noon);
    expect(adj.minutes).toBeGreaterThan(t.totalMinutes + 4);
    expect(adj.low).toBeLessThan(adj.minutes);
    expect(adj.high).toBeGreaterThan(adj.minutes);
    expect(adjustTrip(t, initialEta(), noon).minutes).toBeCloseTo(24, 5);
  });

  it('is more doubtful about unconfirmed community routes', () => {
    const sure = adjustTrip(trip('a', [ride('r1', 20)], 13), initialEta(), noon);
    const unsure = adjustTrip(trip('b', [ride('r1', 20, { unverified: true })], 13), initialEta(), noon);
    expect(unsure.high - unsure.low).toBeGreaterThan(sure.high - sure.low);
  });

  it('survives a save and restore, and drops malformed entries', () => {
    let eta = initialEta();
    eta = observe(eta, { rides: [{ routeId: 'r1', minutes: 20 }], walkMinutes: 0, actualMinutes: 30, at: noon });
    const restored = parseEta(JSON.parse(JSON.stringify(eta)));
    expect(restored.reports).toBe(1);
    expect(correctionFor(restored, 'r1', timeBucket(noon)).factor).toBeCloseTo(correctionFor(eta, 'r1', timeBucket(noon)).factor, 10);
    expect(parseEta({ stats: { bad: { n: 'x' }, worse: null }, reports: 'many' })).toEqual(initialEta());
  });
});

describe('rankTrips', () => {
  const ctx = (over = {}) => ({ prefs: initialPrefs(), eta: initialEta(), priority: 'balanced' as const, at: noon, ...over });

  it('puts the faster trip first at default settings and badges the winners', () => {
    const ranked = rankTrips([slowCheap(), fastPricey()], ctx());
    expect(ranked.map((t) => t.id)).toEqual(['fast', 'cheap']);
    expect(ranked[0].ai?.badges).toContain('best_for_you');
    expect(ranked[0].ai?.badges).toContain('fastest');
    expect(ranked[1].ai?.badges).toContain('cheapest');
    expect(ranked[1].ai?.badges).not.toContain('best_for_you');
  });

  it('flips the order when the commuter asks for the cheapest', () => {
    const ranked = rankTrips([fastPricey(), slowCheap()], ctx({ priority: 'cheapest' }));
    expect(ranked[0].id).toBe('cheap');
  });

  it('demotes a route that commuters report running slow', () => {
    let eta = initialEta();
    for (let i = 0; i < 8; i++) {
      eta = observe(eta, { rides: [{ routeId: 'fast-jeep', minutes: 18 }], walkMinutes: 2, actualMinutes: 50, at: noon });
    }
    const ranked = rankTrips([fastPricey(), slowCheap()], ctx({ eta }));
    expect(ranked[0].id).toBe('cheap');
    expect(ranked[1].ai?.adjustedMinutes).toBeGreaterThan(ranked[0].ai?.adjustedMinutes ?? 0);
  });

  it('follows learned preferences', () => {
    let prefs = initialPrefs();
    const fast = tripFeatures(fastPricey(), 20);
    const cheap = tripFeatures(slowCheap(), 30);
    for (let i = 0; i < 8; i++) prefs = learnFromChoice(prefs, cheap, [fast]);
    expect(rankTrips([fastPricey(), slowCheap()], ctx({ prefs }))[0].id).toBe('cheap');
  });

  it('gives no comparative badges when trips tie, and none to a lone trip', () => {
    const twin = (id: string) => trip(id, [walk(2), ride('same', 18)], 13);
    const tied = rankTrips([twin('a'), twin('b')], ctx());
    expect(tied[0].ai?.badges).not.toContain('fastest');
    expect(tied[0].ai?.badges).not.toContain('cheapest');
    expect(rankTrips([twin('a')], ctx())[0].ai?.badges).toEqual([]);
  });

  it('keeps the planner’s own numbers intact', () => {
    const [first] = rankTrips([fastPricey()], ctx());
    expect(first.totalMinutes).toBe(20);
    expect(first.totalFare).toBe(25);
  });
});

describe('explainTrip', () => {
  const ranked = () =>
    rankTrips([slowCheap(), fastPricey()], { prefs: initialPrefs(), eta: initialEta(), priority: 'balanced', at: noon });

  it('says how the top pick beats the next best', () => {
    const e = explainTrip(ranked(), 'fast', 'balanced', initialPrefs());
    expect(e.versus).toBe('next');
    expect(e.reasons).toContainEqual({ id: 'time', a: 10 });
    expect(e.reasons).toContainEqual({ id: 'fare', a: -12 });
  });

  it('explains a lower-ranked trip against the top pick', () => {
    const e = explainTrip(ranked(), 'cheap', 'balanced', initialPrefs());
    expect(e.versus).toBe('top');
    expect(e.reasons).toContainEqual({ id: 'time', a: -10 });
    expect(e.reasons).toContainEqual({ id: 'fare', a: 12 });
  });

  it('mentions an asked-for priority and heavy traffic', () => {
    const heavy = trip('h', [ride('h', 20, { traffic: 'heavy' })], 13);
    const ranking = rankTrips([heavy], { prefs: initialPrefs(), eta: initialEta(), priority: 'cheapest', at: noon });
    const e = explainTrip(ranking, 'h', 'cheapest', initialPrefs());
    expect(e.versus).toBe('none');
    expect(e.reasons[0]).toEqual({ id: 'priority', priority: 'cheapest' });
    expect(e.reasons).toContainEqual({ id: 'traffic_heavy', a: 100 });
  });

  it('returns nothing for an unknown trip', () => {
    expect(explainTrip(ranked(), 'nope', 'balanced', initialPrefs()).reasons).toEqual([]);
  });
});

describe('departure advice', () => {
  const MIN = 60_000;
  /** A planner stub: the best trip takes `minutesAt(offsetMin)` minutes. */
  const planner = (now: Date, minutesAt: (offset: number) => number, spread = 1.2) => (at: Date): Trip[] => {
    const m = minutesAt(Math.round((at.getTime() - now.getTime()) / MIN));
    const t = trip('t', [ride('r', m)], 13);
    return [{ ...t, ai: { adjustedMinutes: m, minutesLow: m / spread, minutesHigh: m * spread, confidence: 0, cost: m, badges: [] } }];
  };

  it('says leave now when traffic does not ease', () => {
    const advice = compareDepartures(planner(noon, () => 30), noon);
    expect(advice?.verdict).toBe('leave_now');
    expect(advice?.options).toHaveLength(5);
  });

  it('suggests waiting when traffic eases enough to arrive sooner', () => {
    const advice = compareDepartures(planner(noon, (o) => ({ 0: 50, 15: 30, 30: 25, 60: 20, 90: 20 })[o] ?? 50), noon);
    expect(advice?.verdict).toBe('wait_arrive_earlier');
    expect(advice?.pick.offsetMin).toBe(15);
    expect(advice?.savedMin).toBe(5);
  });

  it('flags a much shorter ride later, even if arrival is later', () => {
    const advice = compareDepartures(planner(noon, (o) => ({ 0: 45, 15: 44, 30: 40, 60: 30, 90: 30 })[o] ?? 45), noon);
    expect(advice?.verdict).toBe('wait_shorter_ride');
    expect(advice?.pick.offsetMin).toBe(60);
  });

  it('finds the latest departure that still makes the deadline, with a cushion', () => {
    const deadline = new Date(noon.getTime() + 3 * 60 * MIN);
    const plan = (at: Date): Trip[] => planner(at, () => 30)(at);
    const result = leaveBy(plan, deadline);
    expect(result).not.toBeNull();
    // Needs 36 min at the high end, so the first 10-minute step that covers it is 40.
    expect((deadline.getTime() - result!.leaveAt.getTime()) / MIN).toBe(40);
    expect(result!.bufferMin).toBe(10);
    expect(result!.arriveAt.getTime()).toBeLessThan(deadline.getTime());
  });

  it('gives up when no trip can make it, or none exists', () => {
    const deadline = new Date(noon.getTime() + 3 * 60 * MIN);
    expect(leaveBy((at) => planner(at, () => 400)(at), deadline)).toBeNull();
    expect(leaveBy(() => [], deadline)).toBeNull();
    expect(compareDepartures(() => [], noon)).toBeNull();
  });
});

describe('Ask SakAI parser', () => {
  const parse = (text: string) => parseIntentLocal(text, places);
  const ids = (text: string) => {
    const i = parse(text);
    return [i.origin?.id ?? null, i.destination?.id ?? null];
  };

  it('reads "A to B"', () => {
    expect(ids('Cubao to Quiapo')).toEqual(['cubao', 'quiapo']);
  });

  it('reads cues, aliases, priority and discount', () => {
    const i = parse('from UP to Cubao, cheapest, I am a student');
    expect([i.origin?.id, i.destination?.id]).toEqual(['up-as', 'cubao']);
    expect(i.priority).toBe('cheapest');
    expect(i.discount).toBe('student');
  });

  it('reads Filipino', () => {
    const i = parse('papuntang Quiapo mula sa Cubao, pinakamabilis');
    expect([i.origin?.id, i.destination?.id]).toEqual(['cubao', 'quiapo']);
    expect(i.priority).toBe('fastest');
    expect(parse('walang transfer').priority).toBe('fewest_transfers');
    expect(parse('estudyante po ako').discount).toBe('student');
  });

  it('treats a lone place as the destination', () => {
    expect(ids('how do I get to quiapo')).toEqual([null, 'quiapo']);
    expect(ids('Quiapo')).toEqual([null, 'quiapo']);
  });

  it('prefers the longest name over a short alias', () => {
    expect(ids('up diliman to cubao')).toEqual(['up-as', 'cubao']);
  });

  it('does not mistake common words for places', () => {
    expect(isEmptyIntent(parse('pick up the kids'))).toBe(true);
    expect(isEmptyIntent(parse('hello there'))).toBe(true);
  });

  it('reads departure and arrival times', () => {
    expect(parse('cubao to quiapo at 8am').departHour).toBe(8);
    expect(parse('cubao to quiapo leaving 6:30 pm').departHour).toBeCloseTo(18.5, 5);
    const by = parse('cubao to quiapo, arrive by 9 am');
    expect(by.arriveByHour).toBe(9);
    expect(by.departHour).toBeNull();
    expect(parse('kailangan nasa Quiapo bago alas-7 ng umaga').arriveByHour).toBe(7);
    expect(parse('alas-7 ng gabi').departHour).toBe(19);
    expect(parse('evening rush hour').departHour).toBe(18);
  });

  it('balances competing priorities', () => {
    expect(parse('cheapest and fastest').priority).toBe('balanced');
  });

  it('normalizes accents and punctuation', () => {
    expect(normalize('UST (España)!')).toBe('ust espana');
    expect(ids('ust to cubao')).toEqual(['ust', 'cubao']);
  });

  it('merges a model’s reading with the on-device one', () => {
    const llm = { ...emptyIntent(), destination: places.find((p) => p.id === 'quiapo') ?? null, priority: 'cheapest' as const };
    const local = parse('from cubao, student, at 8am');
    const merged = mergeIntents(llm, local);
    expect([merged.origin?.id, merged.destination?.id]).toEqual(['cubao', 'quiapo']);
    expect(merged.priority).toBe('cheapest');
    expect(merged.discount).toBe('student');
    expect(merged.departHour).toBe(8);
  });
});

describe('place catalog', () => {
  it('includes loading points of routes added by hand, once each', () => {
    const route = (id: string, names: string[]): TransitRoute => ({
      type: 'Feature',
      properties: {
        id,
        name: id,
        type: 'jeep',
        signboard: 'X',
        direction: 'both',
        operatingHours: '',
        loadingPoints: names.map((name, i) => ({ name, coord: [121 + i / 100, 14.6] as [number, number] })),
        color: '#000',
        lastVerified: '2026-01-01',
        source: 'community',
      },
      geometry: { type: 'LineString', coordinates: [[121, 14.6], [121.02, 14.6]] },
    });
    const catalog = buildPlaceCatalog([route('a', ['Kamuning', 'Cubao (Gateway / Araneta)']), route('b', ['kamuning'])], landmarks);
    expect(catalog.filter((p) => normalize(p.name) === 'kamuning')).toHaveLength(1);
    const i = parseIntentLocal('kamuning to quiapo', catalog);
    expect(i.origin?.name).toBe('Kamuning');
    expect(i.destination?.id).toBe('quiapo');
  });
});

describe('time helpers', () => {
  it('formats Manila hours', () => {
    expect(formatHour(7.5)).toBe('7:30 AM');
    expect(formatHour(0)).toBe('12:00 AM');
    expect(formatHour(12)).toBe('12:00 PM');
    expect(formatHour(18.75)).toBe('6:45 PM');
  });
});
