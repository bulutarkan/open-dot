import "server-only";
import { db } from "./db";
import * as repo from "./repo";
import type { Memory } from "@/lib/types";

type Row = Record<string, unknown>;

export type MemoryEpisode = {
  conversationId: string;
  title: string;
  at: number;
  lines: { role: "user" | "dot"; text: string }[];
};

export type MemorySearch = {
  query: string;
  terms: string[];
  memories: Memory[];
  episodes: MemoryEpisode[];
  usedFallback: boolean;
};

const DAY = 86_400_000;
const STOP = new Set([
  // English
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does", "for", "from", "had", "has", "have",
  "he", "her", "here", "him", "his", "how", "i", "if", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "she", "so", "that",
  "the", "their", "them", "there", "they", "this", "to", "us", "was", "we", "were", "what", "when", "where", "which", "who", "why", "with",
  "would", "you", "your",
  // Turkish
  "acaba", "ama", "bana", "ben", "benim", "bile", "bir", "biz", "bu", "bunu", "da", "daha", "de", "diye", "en", "gibi", "hangi", "hani",
  "hakkinda", "hakkında", "icin", "için", "ile", "ise", "mi", "mı", "mu", "mü", "nasil", "nasıl", "ne", "neler", "nerede", "olan", "olarak",
  "onu", "o", "sen", "sana", "sence", "sey", "şey", "su", "şu", "ve", "veya", "ya",
]);

function toMemory(row: Row): Memory {
  return {
    id: String(row.id),
    dotId: String(row.dot_id),
    text: String(row.text),
    importance: Number(row.importance ?? 0.65),
    accessCount: Number(row.access_count ?? 0),
    lastAccessedAt: row.last_accessed_at == null ? null : Number(row.last_accessed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at ?? row.created_at),
  };
}

export function memorySearchTerms(query: string, max = 12): string[] {
  const seen = new Set<string>();
  const tokens = query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length < 2 || STOP.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

function ftsExpression(terms: string[]): string | null {
  if (!terms.length) return null;
  // Tokens contain only unicode letters/numbers, so quoting is enough to keep FTS syntax inert.
  return terms.map((term) => `"${term}"*`).join(" OR ");
}

function recency(updatedAt: number, halfLifeDays = 120): number {
  const ageDays = Math.max(0, Date.now() - updatedAt) / DAY;
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

function rankedMemories(dotId: string, expr: string, limit: number): Memory[] {
  const rows = db()
    .prepare(
      `SELECT m.*, bm25(memory_fts) AS lexical_rank
       FROM memory_fts JOIN memories m ON m.id = memory_fts.id
       WHERE memory_fts MATCH ? AND memory_fts.dot_id = ?
       ORDER BY lexical_rank ASC LIMIT ?`,
    )
    .all(expr, dotId, Math.max(limit * 3, 12)) as Row[];

  return rows
    .map((row, index) => {
      const memory = toMemory(row);
      const lexical = 1 / (1 + index);
      const accessed = Math.min(1, Math.log2(memory.accessCount + 1) / 6);
      const score = lexical * 0.65 + memory.importance * 0.2 + recency(memory.updatedAt) * 0.1 + accessed * 0.05;
      return { memory, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.memory);
}

function fallbackMemories(dotId: string, limit: number): Memory[] {
  return (db()
    .prepare(
      `SELECT * FROM memories WHERE dot_id = ?
       ORDER BY importance DESC, COALESCE(last_accessed_at, updated_at, created_at) DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(dotId, limit) as Row[]).map(toMemory);
}

function episodeAround(message: Row): MemoryEpisode | null {
  const conversationId = String(message.conversation_id ?? "");
  if (!conversationId) return null;
  const at = Number(message.created_at);
  const nearest = db()
    .prepare(
      `SELECT role, text, created_at FROM messages
       WHERE conversation_id = ? AND role IN ('user', 'dot') AND length(trim(text)) > 0
       ORDER BY abs(created_at - ?) ASC LIMIT 5`,
    )
    .all(conversationId, at) as Row[];
  nearest.sort((a, b) => Number(a.created_at) - Number(b.created_at));
  const conv = db().prepare("SELECT title FROM conversations WHERE id = ?").get(conversationId) as Row | undefined;
  const lines = nearest
    .map((row) => ({ role: String(row.role) as "user" | "dot", text: String(row.text).slice(0, 700) }))
    .filter((line) => line.text);
  if (!lines.length) return null;
  return { conversationId, title: String(conv?.title ?? "Past chat"), at, lines };
}

function rankedEpisodes(dotId: string, expr: string, currentConversationId: string | null, limit: number): MemoryEpisode[] {
  const params: (string | number)[] = [expr, dotId];
  let exclude = "";
  if (currentConversationId) {
    exclude = " AND (msg.conversation_id IS NULL OR msg.conversation_id <> ?)";
    params.push(currentConversationId);
  }
  params.push(Math.max(limit * 4, 12));
  const rows = db()
    .prepare(
      `SELECT msg.id, msg.conversation_id, msg.created_at, msg.text, msg.role, bm25(message_fts) AS lexical_rank
       FROM message_fts JOIN messages msg ON msg.id = message_fts.id
       WHERE message_fts MATCH ? AND message_fts.dot_id = ?${exclude}
       ORDER BY lexical_rank ASC, msg.created_at DESC LIMIT ?`,
    )
    .all(...params) as Row[];

  const episodes: MemoryEpisode[] = [];
  for (const row of rows) {
    const conversationId = String(row.conversation_id ?? "");
    const at = Number(row.created_at);
    if (!conversationId) continue;
    // Several FTS hits from the same moment should become one excerpt, not duplicate context.
    if (episodes.some((ep) => ep.conversationId === conversationId && Math.abs(ep.at - at) < 15 * 60_000)) continue;
    const episode = episodeAround(row);
    if (episode) episodes.push(episode);
    if (episodes.length >= limit) break;
  }
  return episodes;
}

/**
 * Retrieve the small slice of long-term context relevant to this turn.
 * Durable memories are ranked by FTS relevance + importance + recency + reuse.
 * Prior chats are searched as episodic memory and expanded around the matching turn.
 */
export function searchMemory(
  dotId: string,
  query: string,
  options: { currentConversationId?: string | null; memoryLimit?: number; episodeLimit?: number; fallback?: boolean } = {},
): MemorySearch {
  const terms = memorySearchTerms(query);
  const expr = ftsExpression(terms);
  const memoryLimit = options.memoryLimit ?? 6;
  const episodeLimit = options.episodeLimit ?? 3;
  let memories = expr ? rankedMemories(dotId, expr, memoryLimit) : [];
  const episodes = expr ? rankedEpisodes(dotId, expr, options.currentConversationId ?? null, episodeLimit) : [];
  let usedFallback = false;

  if (!memories.length && options.fallback !== false) {
    memories = fallbackMemories(dotId, Math.min(memoryLimit, 4));
    usedFallback = memories.length > 0;
  }
  // Only a lexical hit counts as a real access signal. General fallback context should not
  // slowly become self-reinforcing just because it is shown often.
  if (!usedFallback) repo.touchMemories(memories.map((memory) => memory.id));
  return { query, terms, memories, episodes, usedFallback };
}

export function formatMemorySearch(result: MemorySearch, dotName = "Dot"): string {
  const sections: string[] = [];
  if (result.memories.length) {
    sections.push(
      `Durable memories:\n${result.memories.map((memory) => `- [${memory.id}] ${memory.text}`).join("\n")}`,
    );
  }
  if (result.episodes.length) {
    const episodes = result.episodes
      .map((episode) => {
        const date = new Date(episode.at).toISOString().slice(0, 10);
        const lines = episode.lines.map((line) => `${line.role === "user" ? "User" : dotName}: ${line.text}`).join("\n");
        return `- ${date} · ${episode.title}\n${lines}`;
      })
      .join("\n\n");
    sections.push(`Relevant past conversations:\n${episodes}`);
  }
  if (!sections.length) return "No matching durable memory or past conversation was found. Try different or translated keywords.";
  return sections.join("\n\n");
}

/** Context injected automatically for a turn; bounded so old history doesn't crowd out the task. */
export function memoryContext(dotId: string, query: string, currentConversationId: string | null, dotName: string): string {
  const result = searchMemory(dotId, query, { currentConversationId, memoryLimit: 6, episodeLimit: 3 });
  const formatted = formatMemorySearch(result, dotName);
  if (!result.episodes.length && result.terms.length) {
    return `${formatted}\n\nIf the user is clearly referring to something from an earlier chat and it is not above, use search_memory with alternate or translated keywords before answering.`;
  }
  return formatted;
}
