// Нечёткий поиск (подпоследовательность) для быстрого перехода и автодополнения.

export interface FuzzyMatch {
  score: number;
  /** Индексы совпавших символов в строке. */
  indices: number[];
}

const isBoundary = (s: string, i: number) => i === 0 || /[\s/\-_.(\[]/.test(s[i - 1]);

/**
 * Совпадение запроса `q` со строкой `s` как подпоследовательности (без учёта
 * регистра). Больше очков — за подряд идущие символы, начала слов и раннее
 * начало совпадения. `null` — не совпадает.
 */
export function fuzzy(q: string, s: string): FuzzyMatch | null {
  const query = q.toLowerCase().replace(/\s+/g, " ").trim();
  if (!query) return { score: 0, indices: [] };
  const hay = s.toLowerCase();
  // Точное вхождение подстроки — лучший случай.
  const at = hay.indexOf(query);
  if (at >= 0) {
    const indices = Array.from({ length: query.length }, (_, k) => at + k);
    return { score: 1000 - at + (isBoundary(s, at) ? 200 : 0) - s.length * 0.1, indices };
  }
  const compact = query.replace(/ /g, "");
  const indices: number[] = [];
  let score = 0;
  let qi = 0;
  let prev = -2;
  for (let i = 0; i < hay.length && qi < compact.length; i++) {
    if (hay[i] !== compact[qi]) continue;
    indices.push(i);
    score += 10;
    if (i === prev + 1) score += 15;
    if (isBoundary(s, i)) score += 12;
    prev = i;
    qi++;
  }
  if (qi < compact.length) return null;
  score -= (indices[0] ?? 0) * 0.5 + s.length * 0.1;
  return { score, indices };
}
