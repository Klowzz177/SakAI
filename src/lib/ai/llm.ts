import { API_URL, request } from '@/lib/api';
import type { DiscountType, Priority, Trip } from '@/types';

import { type Intent, type PlaceOption } from './intent';
import { tripMinutes } from './ranker';

/**
 * Calls to the SakAI API's language-model endpoints (server/src/ai.ts). They need a login
 * and a server with ANTHROPIC_API_KEY set; everything here is optional, and callers fall
 * back to the on-device parser and explanations when it fails.
 */

export const llmConfigured = API_URL !== null;

interface IntentResponse {
  intent: {
    originId: string | null;
    destinationId: string | null;
    priority: Priority;
    discount: DiscountType | null;
    departHour: number | null;
    arriveByHour: number | null;
  };
}

export async function llmIntent(text: string, lang: 'en' | 'fil', places: PlaceOption[]): Promise<Intent> {
  const res = await request<IntentResponse>('/ai/intent', {
    method: 'POST',
    body: JSON.stringify({ text, lang, places: places.map((p) => ({ id: p.id, name: p.name })) }),
  });
  const byId = new Map(places.map((p) => [p.id, p]));
  const i = res.intent;
  return {
    origin: (i.originId && byId.get(i.originId)) || null,
    destination: (i.destinationId && byId.get(i.destinationId)) || null,
    priority: i.priority,
    discount: i.discount,
    departHour: i.departHour,
    arriveByHour: i.arriveByHour,
  };
}

/** Free text in route data comes from commuters; keep what we forward short and plain. */
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 40);

export async function llmExplain(
  lang: 'en' | 'fil',
  trips: Trip[],
  selectedId: string,
  priority: Priority,
  leaning: string | null
): Promise<string> {
  const shown = trips.slice(0, 4);
  const selected = Math.max(0, shown.findIndex((t) => t.id === selectedId));
  const res = await request<{ text: string }>('/ai/explain', {
    method: 'POST',
    body: JSON.stringify({
      lang,
      priority,
      leaning,
      selected,
      trips: shown.map((t) => ({
        minutes: Math.round(tripMinutes(t)),
        minutesLow: Math.round(t.ai?.minutesLow ?? tripMinutes(t)),
        minutesHigh: Math.round(t.ai?.minutesHigh ?? tripMinutes(t)),
        scheduleMinutes: Math.round(t.totalMinutes),
        fare: t.totalFare,
        transfers: t.transfers,
        walkMeters: Math.round(t.walkMeters),
        badges: t.ai?.badges ?? [],
        rides: t.legs.flatMap((l) =>
          l.kind === 'ride'
            ? [
                {
                  vehicle: l.vehicle,
                  signboard: clean(l.signboard),
                  km: Math.round(l.km * 10) / 10,
                  minutes: Math.round(l.minutes),
                  traffic: l.trafficLevel,
                  unverified: l.unverified,
                },
              ]
            : []
        ),
      })),
    }),
  });
  return res.text;
}
