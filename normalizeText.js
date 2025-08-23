export function normalizeText(s) {
  if (!s) return '';
  return s
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[。、．，・!！?？…—\-\(\)\[\]{}"'「」『』:：;；、｡､・〜~^]/g, '')
    .trim()
    .toLowerCase();
}
