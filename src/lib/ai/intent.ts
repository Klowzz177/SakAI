import type { DiscountType, Landmark, LngLat, Priority, TransitRoute } from '@/types';

/**
 * What a commuter asked for in their own words ("cubao to quiapo, cheapest, student,
 * arrive by 9am"). The on-device parser below handles English and Filipino without a
 * network; when the SakAI API has a language model configured, that reads the same
 * request and this parser fills any gaps (see assistant.ts).
 */

export interface PlaceOption {
  id: string;
  name: string;
  aliases?: string[];
  coord: LngLat;
}

export interface Intent {
  origin: PlaceOption | null;
  destination: PlaceOption | null;
  priority: Priority;
  discount: DiscountType | null;
  /** Manila hour (7.5 = 7:30 AM) the commuter plans to set out. */
  departHour: number | null;
  /** Manila hour the commuter needs to be there by. */
  arriveByHour: number | null;
}

export const emptyIntent = (): Intent => ({
  origin: null,
  destination: null,
  priority: 'balanced',
  discount: null,
  departHour: null,
  arriveByHour: null,
});

export function isEmptyIntent(i: Intent): boolean {
  return (
    !i.origin &&
    !i.destination &&
    i.priority === 'balanced' &&
    !i.discount &&
    i.departHour === null &&
    i.arriveByHour === null
  );
}

const MAX_PLACES = 200;

/**
 * Everything a commuter might name: the landmarks, plus every loading point on every
 * route in the data. Routes are added by hand, so their loading points (including ones
 * commuters add) keep widening what SakAI understands.
 */
export function buildPlaceCatalog(routes: TransitRoute[], landmarks: Landmark[]): PlaceOption[] {
  const seen = new Set<string>();
  const out: PlaceOption[] = [];
  const add = (place: PlaceOption) => {
    const key = normalize(place.name);
    if (!key || seen.has(key) || out.length >= MAX_PLACES) return;
    seen.add(key);
    out.push(place);
  };
  for (const l of landmarks) add({ id: l.id, name: l.name, aliases: l.aliases, coord: l.coord });
  for (const r of routes) {
    r.properties.loadingPoints.forEach((lp, i) =>
      add({ id: `lp:${r.properties.id}:${i}`, name: lp.name, coord: lp.coord })
    );
  }
  return out;
}

/** Lowercase, accents and punctuation removed, single spaces. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The phrases a place can be called: its name, each part of the name, and its aliases. */
function phrasesOf(place: PlaceOption): string[] {
  const parts = place.name.split(/[()/–—-]|\bvia\b/i);
  const all = [place.name, ...parts, ...(place.aliases ?? [])].map(normalize);
  return [...new Set(all)].filter((p) => p.length >= 2);
}

const FILLER = new Set(['sa', 'the', 'ang', 'ng', 'na', 'nasa', 'kay', 'at', 'in']);
const ORIGIN_CUES = new Set(['from', 'mula', 'galing', 'starting', 'start', 'leaving']);
const DEST_CUES = new Set([
  'to',
  'papunta',
  'papuntang',
  'punta',
  'pupunta',
  'patungong',
  'going',
  'hanggang',
  'towards',
  'toward',
  'until',
  'till',
]);

interface Match {
  place: PlaceOption;
  start: number;
  end: number;
  chars: number;
  cue: 'origin' | 'destination' | null;
}

function cueBefore(tokens: string[], start: number): 'origin' | 'destination' | null {
  let j = start - 1;
  while (j >= 0 && FILLER.has(tokens[j]) && start - j <= 2) j--;
  if (j < 0) return null;
  if (ORIGIN_CUES.has(tokens[j])) return 'origin';
  if (DEST_CUES.has(tokens[j])) return 'destination';
  return null;
}

function findPlaces(tokens: string[], places: PlaceOption[]): Match[] {
  const found: Match[] = [];
  for (const place of places) {
    for (const phrase of phrasesOf(place)) {
      const words = phrase.split(' ');
      for (let s = 0; s + words.length <= tokens.length; s++) {
        if (!words.every((w, k) => tokens[s + k] === w)) continue;
        const cue = cueBefore(tokens, s);
        // "up" or "as" alone are too easy to hit by accident; they need "from"/"to" in front.
        if (words.length === 1 && phrase.length <= 2 && !cue) continue;
        found.push({ place, start: s, end: s + words.length, chars: phrase.length, cue });
      }
    }
  }
  // Longest phrase wins where matches overlap ("up diliman" beats "up").
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || b.chars - a.chars || a.start - b.start);
  const taken: Match[] = [];
  for (const m of found) {
    if (taken.some((t) => m.start < t.end && t.start < m.end)) continue;
    taken.push(m);
  }
  return taken.sort((a, b) => a.start - b.start);
}

const hasAny = (padded: string, phrases: string[]) => phrases.some((p) => padded.includes(` ${p} `));

const CHEAPEST = ['cheapest', 'cheap', 'cheaper', 'budget', 'save money', 'tipid', 'mura', 'pinakamura', 'mas mura', 'least expensive', 'low cost'];
const FASTEST = ['fastest', 'fast', 'faster', 'quickest', 'quick', 'asap', 'hurry', 'in a hurry', 'running late', 'late na', 'mabilis', 'pinakamabilis', 'mas mabilis', 'nagmamadali'];
const FEWEST_TRANSFERS = ['no transfer', 'no transfers', 'without transfer', 'avoid transfer', 'avoid transfers', 'fewest transfers', 'least transfers', 'direct', 'one ride', 'walang transfer', 'walang lipat', 'isang sakay', 'isang sakay lang', 'diretso', 'ayaw ng transfer', 'ayaw ng lipat'];
const LEAST_WALKING = ['less walking', 'least walking', 'minimal walking', 'no walking', 'avoid walking', 'ayaw maglakad', 'ayoko maglakad', 'konting lakad', 'kaunting lakad', 'walang lakad'];
const STUDENT = ['student', 'students', 'estudyante'];
const SENIOR = ['senior', 'senior citizen', 'matanda', 'lolo', 'lola'];
const PWD = ['pwd', 'disabled'];

function parsePriority(padded: string): Priority {
  if (hasAny(padded, FEWEST_TRANSFERS)) return 'fewest_transfers';
  if (hasAny(padded, LEAST_WALKING)) return 'least_walking';
  const cheap = hasAny(padded, CHEAPEST);
  const fast = hasAny(padded, FASTEST);
  if (cheap && fast) return 'balanced';
  if (cheap) return 'cheapest';
  if (fast) return 'fastest';
  return 'balanced';
}

function parseDiscount(padded: string): DiscountType | null {
  if (hasAny(padded, PWD)) return 'pwd';
  if (hasAny(padded, SENIOR)) return 'senior';
  if (hasAny(padded, STUDENT)) return 'student';
  return null;
}

const ARRIVE_CUE = /(?:\bby|\bbefore|\bbago|\barrive|\barriving|\bdumating|\bmakarating|\bhanggang)\s*(?:at\s*|ng\s*|ang\s*|mga\s*|alas[\s-]*)?$/;

function to24(h: number, meridiem: 'am' | 'pm'): number {
  return meridiem === 'am' ? h % 12 : (h % 12) + 12;
}

/** Times in the request: "8am", "6:30 pm", "alas-7 ng umaga", "rush hour". */
function parseTimes(raw: string): { depart: number | null; arriveBy: number | null } {
  const text = raw.toLowerCase();
  const found: { hour: number; at: number }[] = [];

  for (const m of text.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g)) {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || min > 59) continue;
    found.push({ hour: to24(h, m[3].startsWith('a') ? 'am' : 'pm') + min / 60, at: m.index });
  }
  for (const m of text.matchAll(/alas[\s-]*(\d{1,2})(?::(\d{2}))?\s*(?:ng\s*)?(umaga|tanghali|hapon|gabi|madaling araw)/g)) {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || min > 59) continue;
    const part = m[3];
    const hour =
      part === 'tanghali' ? 12 : part === 'umaga' || part === 'madaling araw' ? h % 12 : part === 'hapon' ? to24(h, 'pm') : h === 12 ? 0 : to24(h, 'pm');
    found.push({ hour: hour + min / 60, at: m.index });
  }
  const words: [RegExp, number][] = [
    [/morning rush|umaga rush/, 8],
    [/evening rush|rush hour|gabi rush/, 18],
    [/\bnoon\b|\btanghali\b/, 12],
  ];
  for (const [re, hour] of words) {
    const m = re.exec(text);
    if (m && !found.some((f) => Math.abs(f.at - m.index) < 12)) found.push({ hour, at: m.index });
  }

  let depart: number | null = null;
  let arriveBy: number | null = null;
  for (const f of found.sort((a, b) => a.at - b.at)) {
    const before = text.slice(Math.max(0, f.at - 18), f.at);
    if (ARRIVE_CUE.test(before)) arriveBy ??= f.hour;
    else depart ??= f.hour;
  }
  return { depart, arriveBy };
}

/** Reads a request without a network. Unrecognised words are ignored. */
export function parseIntentLocal(text: string, places: PlaceOption[]): Intent {
  const norm = normalize(text);
  const tokens = norm ? norm.split(' ') : [];
  const padded = ` ${norm} `;
  const intent = emptyIntent();

  const matches = findPlaces(tokens, places);
  let origin: Match | null = null;
  let destination: Match | null = null;
  const loose: Match[] = [];
  for (const m of matches) {
    if (m.cue === 'origin' && !origin) origin = m;
    else if (m.cue === 'destination' && !destination) destination = m;
    else loose.push(m);
  }
  for (const m of loose) {
    if (!origin && (destination || loose.length > 1)) origin = m;
    else if (!destination) destination = m;
  }
  // One place with no cue, e.g. "how do I get to quiapo": that's where they're going.
  intent.origin = origin?.place ?? null;
  intent.destination = destination?.place ?? null;
  if (intent.origin && intent.origin === intent.destination) intent.origin = null;

  intent.priority = parsePriority(padded);
  intent.discount = parseDiscount(padded);
  const times = parseTimes(text);
  intent.departHour = times.depart;
  intent.arriveByHour = times.arriveBy;
  return intent;
}

/** `primary` wins where it has an answer; `fallback` fills what it left blank. */
export function mergeIntents(primary: Intent, fallback: Intent): Intent {
  return {
    origin: primary.origin ?? fallback.origin,
    destination: primary.destination ?? fallback.destination,
    priority: primary.priority !== 'balanced' ? primary.priority : fallback.priority,
    discount: primary.discount ?? fallback.discount,
    departHour: primary.departHour ?? fallback.departHour,
    arriveByHour: primary.arriveByHour ?? fallback.arriveByHour,
  };
}
