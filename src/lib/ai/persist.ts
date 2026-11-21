import { getItem, setItem } from '@/lib/storage';

/**
 * Saves SakAI's learned models on the device. Secure storage values are small, so the JSON
 * is split into chunks under `<key>.<n>`, with the chunk count under `<key>.n`.
 */

const CHUNK = 1500;

export async function saveJson(key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  const chunks = Math.ceil(text.length / CHUNK);
  const previous = Number(await getItem(`${key}.n`)) || 0;
  for (let i = 0; i < chunks; i++) await setItem(`${key}.${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK));
  await setItem(`${key}.n`, String(chunks));
  for (let i = chunks; i < previous; i++) await setItem(`${key}.${i}`, null);
}

export async function loadJson(key: string): Promise<unknown> {
  const count = Number(await getItem(`${key}.n`)) || 0;
  if (count <= 0 || count > 200) return null;
  let text = '';
  for (let i = 0; i < count; i++) {
    const part = await getItem(`${key}.${i}`);
    if (part === null) return null;
    text += part;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function clearJson(key: string): Promise<void> {
  const count = Number(await getItem(`${key}.n`)) || 0;
  for (let i = 0; i < count; i++) await setItem(`${key}.${i}`, null);
  await setItem(`${key}.n`, null);
}
