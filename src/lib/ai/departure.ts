import type { Trip } from '@/types';

import { tripMinutes } from './ranker';

/**
 * Departure-time advice. `planAt` plans and ranks trips for a given moment (the store
 * supplies it, so traffic, learned corrections and the commuter's preferences all apply).
 * SakAI looks at the commuter's best trip at several moments and compares them.
 */
export type PlanAt = (at: Date) => Trip[];

const MIN = 60_000;

export interface DepartureOption {
  /** Minutes from now. */
  offsetMin: number;
  at: Date;
  minutes: number;
  /** Upper end of the likely range. */
  high: number;
  fare: number;
}

export type DepartureVerdict = 'leave_now' | 'wait_arrive_earlier' | 'wait_shorter_ride';

export interface DepartureAdvice {
  options: DepartureOption[];
  verdict: DepartureVerdict;
  /** The option the verdict points at. */
  pick: DepartureOption;
  /** Minutes saved: arriving earlier, or riding less, depending on the verdict. */
  savedMin: number;
}

const DEFAULT_OFFSETS = [0, 15, 30, 60, 90];
/** A shorter ride is only worth waiting for if it saves this much. */
const WORTH_WAITING_MIN = 8;

function optionAt(planAt: PlanAt, now: Date, offsetMin: number): DepartureOption | null {
  const at = new Date(now.getTime() + offsetMin * MIN);
  const best = planAt(at)[0];
  if (!best) return null;
  return {
    offsetMin,
    at,
    minutes: tripMinutes(best),
    high: best.ai?.minutesHigh ?? tripMinutes(best),
    fare: best.totalFare,
  };
}

/** Leave now, or later? Compares the commuter's best trip at a few departure times. */
export function compareDepartures(planAt: PlanAt, now: Date, offsets: number[] = DEFAULT_OFFSETS): DepartureAdvice | null {
  const options = offsets.flatMap((o) => optionAt(planAt, now, o) ?? []);
  const nowOption = options.find((o) => o.offsetMin === 0);
  if (!nowOption) return null;

  const arrival = (o: DepartureOption) => o.offsetMin + o.minutes;
  const earliest = options.reduce((a, b) => (arrival(b) < arrival(a) - 1e-6 ? b : a), nowOption);
  if (earliest.offsetMin > 0 && arrival(nowOption) - arrival(earliest) >= 2) {
    return {
      options,
      verdict: 'wait_arrive_earlier',
      pick: earliest,
      savedMin: arrival(nowOption) - arrival(earliest),
    };
  }
  const shortest = options.reduce((a, b) => (b.minutes < a.minutes - 1e-6 ? b : a), nowOption);
  if (shortest.offsetMin > 0 && nowOption.minutes - shortest.minutes >= WORTH_WAITING_MIN) {
    return {
      options,
      verdict: 'wait_shorter_ride',
      pick: shortest,
      savedMin: nowOption.minutes - shortest.minutes,
    };
  }
  return { options, verdict: 'leave_now', pick: nowOption, savedMin: 0 };
}

export interface LeaveBy {
  /** Latest time to set out and still arrive on time, allowing for the likely range. */
  leaveAt: Date;
  /** Expected travel time when leaving then. */
  minutes: number;
  /** Expected arrival if all goes as estimated. */
  arriveAt: Date;
  /** Cushion between the expected arrival and the deadline. */
  bufferMin: number;
}

const LEAVE_BY_STEP_MIN = 10;
const LEAVE_BY_LOOKBACK_MIN = 180;

/**
 * Latest departure that still arrives by `deadline`, using the high end of the time range so a
 * slow day doesn't make the commuter late. Steps back from the deadline; traffic at each
 * candidate departure time decides how long the trip takes. Null if nothing in the last
 * three hours makes it.
 */
export function leaveBy(planAt: PlanAt, deadline: Date): LeaveBy | null {
  for (let lead = LEAVE_BY_STEP_MIN; lead <= LEAVE_BY_LOOKBACK_MIN; lead += LEAVE_BY_STEP_MIN) {
    const leaveAt = new Date(deadline.getTime() - lead * MIN);
    const best = planAt(leaveAt)[0];
    if (!best) return null;
    const high = best.ai?.minutesHigh ?? tripMinutes(best);
    // `lead` is how long before the deadline we leave; this is the latest lead that is still enough.
    if (high <= lead) {
      const minutes = tripMinutes(best);
      return {
        leaveAt,
        minutes,
        arriveAt: new Date(leaveAt.getTime() + minutes * MIN),
        bufferMin: lead - minutes,
      };
    }
  }
  return null;
}
