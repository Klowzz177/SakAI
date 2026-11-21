import { type Intent, mergeIntents, parseIntentLocal, type PlaceOption } from './intent';
import { llmConfigured, llmIntent } from './llm';

export type IntentSource = 'ai' | 'local';

/**
 * Reads a commuter's request. With a login and a configured server it asks the language
 * model, then lets the on-device parser fill anything the model left blank. Without them,
 * or if the call fails, the on-device parser alone answers, so Ask SakAI always works.
 */
export async function interpretRequest(
  text: string,
  lang: 'en' | 'fil',
  places: PlaceOption[],
  signedIn: boolean
): Promise<{ intent: Intent; source: IntentSource }> {
  const local = parseIntentLocal(text, places);
  if (!llmConfigured || !signedIn) return { intent: local, source: 'local' };
  try {
    const remote = await llmIntent(text, lang, places);
    return { intent: mergeIntents(remote, local), source: 'ai' };
  } catch {
    return { intent: local, source: 'local' };
  }
}
