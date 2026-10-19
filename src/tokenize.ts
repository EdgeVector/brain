// Keyword tokens for list pages and ask. Lower case, split on non-letters,
// drop English stop words and tokens shorter than two characters.

const STOPWORDS = new Set<string>([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "in", "on",
  "at", "to", "from", "for", "with", "by", "is", "are", "was", "were", "be",
  "been", "being", "do", "does", "did", "have", "has", "had", "as", "it",
  "its", "this", "that", "these", "those", "i", "you", "he", "she", "we",
  "they", "what", "which", "who", "whom", "how", "when", "where", "why",
  "not", "no", "so", "than", "into", "about", "over", "under", "between",
  "across", "through", "during", "before", "after", "above", "below", "out",
  "up", "down", "off", "on", "again", "here", "there", "all", "any", "each",
  "more", "most", "some", "such", "only", "own", "same", "very", "can", "will",
  "just", "should", "could", "would", "may", "might", "must", "shall",
]);

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const raw of lower.split(/[^a-z0-9]+/g)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}
