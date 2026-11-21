import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useLangStore, useT } from '@/i18n';
import { compareDepartures, type DepartureAdvice, leaveBy, type LeaveBy } from '@/lib/ai/departure';
import { explainTrip } from '@/lib/ai/explain';
import { llmConfigured, llmExplain } from '@/lib/ai/llm';
import { profileOf } from '@/lib/ai/preferences';
import { formatHour, formatManilaTime } from '@/lib/ai/time';
import { planRanked, trafficTime, useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import type { Trip, TripBadge } from '@/types';

const MIN = 60_000;

/** Small pills saying where a trip wins ("Best for you", "Cheapest"…). */
export function TripBadges({ trip }: { trip: Trip }) {
  const theme = useTheme();
  const t = useT();
  const badges = (trip.ai?.badges ?? []).slice(0, 3);
  if (badges.length === 0) return null;
  return (
    <View style={styles.badges}>
      {badges.map((b: TripBadge) => {
        const primary = b === 'best_for_you';
        return (
          <View
            key={b}
            style={[
              styles.badge,
              { borderColor: theme.accent },
              primary && { backgroundColor: theme.accent },
            ]}>
            <ThemedText type="small" style={{ color: primary ? theme.accentText : theme.accent, fontSize: 12 }}>
              {t.ai.trip.badges[b]}
            </ThemedText>
          </View>
        );
      })}
    </View>
  );
}

/**
 * SakAI's part of the selected trip: the likely time range, why it ranks here, picking it
 * (which teaches SakAI your preferences), reporting the real time (which tunes future
 * estimates) and when to leave.
 */
export function TripAi({ trip }: { trip: Trip }) {
  const theme = useTheme();
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const signedIn = useAuthStore((s) => s.status === 'signedIn');

  const trips = useAppStore((s) => s.trips);
  const priority = useAppStore((s) => s.priority);
  const aiPrefs = useAppStore((s) => s.aiPrefs);
  const activeTrip = useAppStore((s) => s.activeTrip);
  const arriveByHour = useAppStore((s) => s.arriveByHour);
  const commitTrip = useAppStore((s) => s.commitTrip);
  const logActualTime = useAppStore((s) => s.logActualTime);

  const explanation = useMemo(() => explainTrip(trips, trip.id, priority, aiPrefs), [trips, trip.id, priority, aiPrefs]);

  const [aiText, setAiText] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiFailed, setAiFailed] = useState(false);
  const [minutesText, setMinutesText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [thanks, setThanks] = useState(false);
  const [advice, setAdvice] = useState<{ compare: DepartureAdvice | null; leave: LeaveBy | null; deadline: number | null } | null>(null);

  // Anything said about another trip no longer applies.
  useEffect(() => {
    setAiText(null);
    setAiFailed(false);
    setAdvice(null);
    setThanks(false);
  }, [trip.id]);

  const explainWithAi = async () => {
    setAiBusy(true);
    setAiFailed(false);
    try {
      setAiText(await llmExplain(lang, trips, trip.id, priority, profileOf(aiPrefs).leaning));
    } catch {
      setAiFailed(true);
    } finally {
      setAiBusy(false);
    }
  };

  const saveTime = () => {
    const minutes = Number(minutesText);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 360) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    logActualTime(Math.round(minutes));
    setMinutesText('');
    setThanks(true);
  };

  const adviseDeparture = () => {
    const s = useAppStore.getState();
    const planAt = (at: Date) => planRanked(s, at);
    const now = trafficTime(s.simulatedHour);
    setAdvice({
      compare: compareDepartures(planAt, now),
      leave: s.arriveByHour !== null ? leaveBy(planAt, trafficTime(s.arriveByHour)) : null,
      deadline: s.arriveByHour,
    });
  };

  const taking = activeTrip?.tripId === trip.id;
  const ai = trip.ai;
  const arrive = (o: { at: Date; minutes: number }) => formatManilaTime(new Date(o.at.getTime() + o.minutes * MIN));

  return (
    <View style={[styles.wrap, { borderTopColor: theme.border }]}>
      {ai && (
        <View>
          <ThemedText type="small">
            {t.ai.trip.range(Math.round(ai.minutesLow), Math.round(ai.minutesHigh))}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {t.ai.trip.confidence(ai.confidence)}
          </ThemedText>
        </View>
      )}

      {explanation.reasons.length > 0 && (
        <View style={styles.block}>
          <ThemedText type="smallBold">{t.ai.trip.whyTitle}</ThemedText>
          {explanation.versus !== 'none' && (
            <ThemedText type="small" themeColor="textSecondary">
              {t.ai.trip.versus[explanation.versus]}
            </ThemedText>
          )}
          {explanation.reasons.map((r, i) => (
            <ThemedText key={i} type="small">
              • {t.ai.trip.reason(r, explanation.versus)}
            </ThemedText>
          ))}
        </View>
      )}

      {aiText && <ThemedText type="small">✨ {aiText}</ThemedText>}
      {aiFailed && (
        <ThemedText type="small" themeColor="textSecondary">
          {t.ai.trip.explainFailed}
        </ThemedText>
      )}
      {llmConfigured && signedIn && !aiText && (
        <Pressable onPress={explainWithAi} disabled={aiBusy} accessibilityRole="button" style={styles.link}>
          {aiBusy ? (
            <ActivityIndicator size="small" />
          ) : (
            <ThemedText type="small" style={{ color: theme.accent }}>
              ✨ {t.ai.trip.explainMore}
            </ThemedText>
          )}
        </Pressable>
      )}

      {!taking && (
        <Pressable
          onPress={() => {
            commitTrip(trip.id);
            setThanks(false);
          }}
          accessibilityRole="button"
          style={[styles.primary, { backgroundColor: theme.accent }]}>
          <ThemedText type="smallBold" style={{ color: theme.accentText }}>
            {t.ai.trip.take}
          </ThemedText>
        </Pressable>
      )}

      {taking && (
        <View style={styles.block}>
          <ThemedText type="small">{t.ai.trip.taking}</ThemedText>
          <ThemedText type="smallBold">{t.ai.trip.howLong}</ThemedText>
          <View style={styles.row}>
            <TextInput
              style={[styles.minutes, { color: theme.text, borderColor: invalid ? '#CF222E' : theme.border }]}
              value={minutesText}
              onChangeText={setMinutesText}
              keyboardType="number-pad"
              maxLength={3}
              placeholder="min"
              placeholderTextColor={theme.textSecondary}
              onSubmitEditing={saveTime}
              accessibilityLabel={t.ai.trip.howLong}
            />
            <Pressable onPress={saveTime} accessibilityRole="button" style={[styles.save, { backgroundColor: theme.accent }]}>
              <ThemedText type="smallBold" style={{ color: theme.accentText }}>
                {t.ai.trip.save}
              </ThemedText>
            </Pressable>
          </View>
          {invalid && (
            <ThemedText type="small" style={{ color: '#CF222E' }}>
              {t.ai.trip.invalidTime}
            </ThemedText>
          )}
        </View>
      )}
      {thanks && !taking && <ThemedText type="small">{t.ai.trip.thanksTime}</ThemedText>}

      <Pressable onPress={adviseDeparture} accessibilityRole="button" style={styles.link}>
        <ThemedText type="small" style={{ color: theme.accent }}>
          🕒 {t.ai.departure.button}
        </ThemedText>
      </Pressable>

      {advice?.leave && advice.deadline !== null && (
        <ThemedText type="small">
          {t.ai.departure.leaveBy(
            formatManilaTime(advice.leave.leaveAt),
            formatHour(advice.deadline),
            formatManilaTime(advice.leave.arriveAt),
            Math.round(advice.leave.bufferMin)
          )}
        </ThemedText>
      )}
      {advice && !advice.leave && advice.deadline !== null && (
        <ThemedText type="small">{t.ai.departure.leaveByNone(formatHour(advice.deadline))}</ThemedText>
      )}
      {advice?.compare && (
        <View style={styles.block}>
          <ThemedText type="smallBold">{t.ai.departure.title}</ThemedText>
          {advice.compare.options.map((o) => (
            <ThemedText key={o.offsetMin} type="small" themeColor="textSecondary">
              {t.ai.departure.option(o.offsetMin, formatManilaTime(o.at), Math.round(o.minutes), arrive(o))}
            </ThemedText>
          ))}
          <ThemedText type="small">
            {advice.compare.verdict === 'leave_now'
              ? t.ai.departure.verdict.leave_now
              : advice.compare.verdict === 'wait_arrive_earlier'
                ? t.ai.departure.verdict.wait_arrive_earlier(advice.compare.pick.offsetMin, Math.round(advice.compare.savedMin))
                : t.ai.departure.verdict.wait_shorter_ride(advice.compare.pick.offsetMin, Math.round(advice.compare.savedMin))}
          </ThemedText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.two, borderTopWidth: 1, paddingTop: Spacing.three },
  block: { gap: Spacing.half },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  badge: {
    borderWidth: 1,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
  },
  link: { alignSelf: 'flex-start', paddingVertical: Spacing.one },
  primary: { borderRadius: Spacing.two, paddingVertical: Spacing.two, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  minutes: {
    width: 80,
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    fontSize: 16,
  },
  save: { borderRadius: Spacing.two, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
});
