import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useLangStore, useT } from '@/i18n';
import { type IntentSource, interpretRequest } from '@/lib/ai/assistant';
import { buildPlaceCatalog, type Intent, isEmptyIntent } from '@/lib/ai/intent';
import { llmConfigured } from '@/lib/ai/llm';
import { profileOf } from '@/lib/ai/preferences';
import { formatHour } from '@/lib/ai/time';
import { landmarks } from '@/lib/dataSource';
import { useAllRoutes, useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import type { Priority } from '@/types';

const PRIORITIES: Priority[] = ['balanced', 'fastest', 'cheapest', 'fewest_transfers', 'least_walking'];

/**
 * "Ask SakAI": type a trip in your own words (English, Filipino or Taglish). The request is
 * read by a language model when the SakAI API has one and you're logged in, otherwise by
 * the on-device parser, then fills in the trip and what to optimise for.
 */
export function SakAIAssistant() {
  const theme = useTheme();
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const routes = useAllRoutes();
  const places = useMemo(() => buildPlaceCatalog(routes, landmarks), [routes]);
  const signedIn = useAuthStore((s) => s.status === 'signedIn');

  const origin = useAppStore((s) => s.origin);
  const destination = useAppStore((s) => s.destination);
  const priority = useAppStore((s) => s.priority);
  const setPriority = useAppStore((s) => s.setPriority);
  const applyIntent = useAppStore((s) => s.applyIntent);
  const aiPrefs = useAppStore((s) => s.aiPrefs);
  const reports = useAppStore((s) => s.aiEta.reports);
  const resetAiLearning = useAppStore((s) => s.resetAiLearning);

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ intent: Intent; source: IntentSource } | null>(null);

  const ask = async () => {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    try {
      const r = await interpretRequest(question, lang, places, signedIn);
      setResult(r);
      if (!isEmptyIntent(r.intent)) applyIntent(r.intent);
    } finally {
      setBusy(false);
    }
  };

  const profile = profileOf(aiPrefs);
  const intent = result?.intent;
  const understood = intent
    ? [
        intent.origin && intent.destination ? `${intent.origin.name} → ${intent.destination.name}` : null,
        intent.origin && !intent.destination ? `${t.search.from}: ${intent.origin.name}` : null,
        !intent.origin && intent.destination ? `${t.search.to}: ${intent.destination.name}` : null,
        intent.priority !== 'balanced' ? t.ai.assistant.priorities[intent.priority] : null,
        intent.discount ? t.fares.discounts[intent.discount] : null,
        intent.departHour !== null ? t.ai.assistant.leaveAt(formatHour(intent.departHour)) : null,
        intent.arriveByHour !== null ? t.ai.assistant.arriveBy(formatHour(intent.arriveByHour)) : null,
      ].filter((x): x is string => x !== null)
    : [];

  return (
    <ThemedView style={[styles.card, { borderColor: theme.border }]}>
      <ThemedText type="smallBold">✨ {t.ai.assistant.title}</ThemedText>
      <View style={[styles.inputRow, { borderColor: theme.border }]}>
        <TextInput
          style={[styles.input, { color: theme.text }]}
          placeholder={t.ai.assistant.placeholder}
          placeholderTextColor={theme.textSecondary}
          value={text}
          onChangeText={setText}
          onSubmitEditing={ask}
          returnKeyType="send"
          maxLength={300}
          accessibilityLabel={t.ai.assistant.title}
        />
        <Pressable
          onPress={ask}
          disabled={busy || !text.trim()}
          accessibilityRole="button"
          accessibilityLabel={t.ai.assistant.ask}
          style={[styles.askButton, { backgroundColor: theme.accent }, (busy || !text.trim()) && styles.disabled]}>
          {busy ? (
            <ActivityIndicator size="small" color={theme.accentText} />
          ) : (
            <ThemedText type="smallBold" style={{ color: theme.accentText }}>
              {t.ai.assistant.ask}
            </ThemedText>
          )}
        </Pressable>
      </View>

      {llmConfigured && !signedIn && (
        <ThemedText type="small" themeColor="textSecondary">
          {t.ai.assistant.loginHint}
        </ThemedText>
      )}

      {result && (
        <View style={styles.result}>
          {understood.length > 0 ? (
            <>
              <ThemedText type="small">
                <ThemedText type="smallBold">{t.ai.assistant.understood}: </ThemedText>
                {understood.join(' · ')}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {result.source === 'ai' ? t.ai.assistant.sourceAi : t.ai.assistant.sourceLocal}
              </ThemedText>
              {!origin && <ThemedText type="small">{t.ai.assistant.needOrigin}</ThemedText>}
              {!destination && <ThemedText type="small">{t.ai.assistant.needDestination}</ThemedText>}
            </>
          ) : (
            <ThemedText type="small" themeColor="textSecondary">
              {t.ai.assistant.nothing}
            </ThemedText>
          )}
        </View>
      )}

      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={t.ai.assistant.priorityLabel}>
        <ThemedText type="small" themeColor="textSecondary">
          {t.ai.assistant.priorityLabel}:
        </ThemedText>
        {PRIORITIES.map((p) => {
          const active = p === priority;
          return (
            <Pressable
              key={p}
              onPress={() => setPriority(p)}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              style={[
                styles.chip,
                { borderColor: active ? theme.accent : theme.border },
                active && { backgroundColor: theme.accent },
              ]}>
              <ThemedText type="small" style={{ color: active ? theme.accentText : theme.text }}>
                {t.ai.assistant.priorities[p]}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.profile}>
        <ThemedText type="small" themeColor="textSecondary">
          {profile.leaning ? t.ai.profile.leanings[profile.leaning] : t.ai.profile.learning(profile.choices)}
          {reports > 0 ? ` ${t.ai.profile.reports(reports)}` : ''}
        </ThemedText>
        {(profile.choices > 0 || reports > 0) && (
          <Pressable onPress={resetAiLearning} accessibilityRole="button">
            <ThemedText type="small" style={{ color: theme.accent }}>
              {t.ai.profile.reset}
            </ThemedText>
          </Pressable>
        )}
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: Spacing.three, borderWidth: 1, padding: Spacing.three, gap: Spacing.two },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingLeft: Spacing.two,
    gap: Spacing.two,
  },
  input: { flex: 1, paddingVertical: Spacing.two, fontSize: 16, minWidth: 0 },
  askButton: {
    margin: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    minWidth: 64,
    alignItems: 'center',
  },
  disabled: { opacity: 0.5 },
  result: { gap: Spacing.half },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Spacing.one },
  chip: {
    borderWidth: 1,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  profile: { gap: Spacing.one },
});
