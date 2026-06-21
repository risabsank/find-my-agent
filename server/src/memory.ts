// Agent memory: a RediSearch index of past interventions/verdicts the supervisor
// can semantically recall. Vector KNN when Voyage embeddings are available, else
// RediSearch full-text. All gated by Redis being present; fails open to no-op.

import { getRedis, redisEnabled } from "./redis.ts";
import { VOYAGE_API_KEY, VOYAGE_MODEL, VOYAGE_DIM } from "../../shared/config.ts";

const INDEX = "fma:mem";
const PREFIX = "fma:mem:";
const hasVectors = !!VOYAGE_API_KEY;
let memoryReady = false; // RediSearch index exists

export function memoryEnabled(): boolean {
  return memoryReady;
}

/** Create the RediSearch index once (idempotent). No-op without RediSearch. */
export async function ensureMemoryIndex(): Promise<void> {
  const client = getRedis();
  if (!client) return;
  const schema = [
    "repo", "TAG",
    "kind", "TAG",
    "text", "TEXT",
    "ts", "NUMERIC",
    ...(hasVectors
      ? ["vector", "VECTOR", "HNSW", "6", "TYPE", "FLOAT32", "DIM", String(VOYAGE_DIM), "DISTANCE_METRIC", "COSINE"]
      : []),
  ];
  try {
    await client.sendCommand(["FT.CREATE", INDEX, "ON", "HASH", "PREFIX", "1", PREFIX, "SCHEMA", ...schema]);
    memoryReady = true;
    console.log(`[memory] index ready (${hasVectors ? "vector" : "full-text"})`);
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Index already exists")) {
      memoryReady = true;
    } else {
      console.error("[memory] RediSearch unavailable — recall disabled:", msg);
      memoryReady = false;
    }
  }
}

async function embed(text: string): Promise<Float32Array | null> {
  if (!hasVectors) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${VOYAGE_API_KEY}` },
      body: JSON.stringify({ input: [text], model: VOYAGE_MODEL }),
    });
    if (!res.ok) throw new Error(`voyage ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return Float32Array.from(json.data[0].embedding);
  } catch (e) {
    console.error("[memory] embed failed:", (e as Error).message);
    return null;
  }
}

function tag(s: string): string {
  // Alphanumeric + underscore only — avoids RediSearch TAG query escaping issues
  // (hyphens/dots/slashes are tokenizers in the query parser).
  return s.replace(/[^a-zA-Z0-9_]/g, "_") || "repo";
}

/** Store a memory (one-line lesson) for later recall. */
export async function recordMemory(opts: { repo: string; kind: string; text: string }): Promise<void> {
  const client = getRedis();
  if (!client || !memoryReady) return;
  try {
    const id = `${PREFIX}${crypto.randomUUID()}`;
    const args: (string | Buffer)[] = [
      "HSET", id,
      "repo", tag(opts.repo),
      "kind", opts.kind,
      "text", opts.text,
      "ts", String(Date.now()),
    ];
    if (hasVectors) {
      const v = await embed(opts.text);
      if (v) args.push("vector", Buffer.from(v.buffer));
    }
    await client.sendCommand(args);
  } catch (e) {
    console.error("[memory] record failed:", (e as Error).message);
  }
}

function parseSearch(reply: unknown): string[] {
  // FT.SEARCH reply: [count, key, [f,v,...], key, [f,v,...], ...]
  if (!Array.isArray(reply)) return [];
  const out: string[] = [];
  for (let i = 1; i < reply.length; i += 2) {
    const fields = reply[i + 1];
    if (!Array.isArray(fields)) continue;
    for (let j = 0; j < fields.length; j += 2) {
      if (String(fields[j]) === "text") out.push(String(fields[j + 1]));
    }
  }
  return out;
}

/** Recall the most relevant past memories for a repo + situation. */
export async function recallMemories(repo: string, query: string, k = 3): Promise<string[]> {
  const client = getRedis();
  if (!client || !memoryReady) return [];
  const repoTag = tag(repo);
  try {
    if (hasVectors) {
      const v = await embed(query);
      if (v) {
        const reply = await client.sendCommand([
          "FT.SEARCH", INDEX,
          `(@repo:{${repoTag}})=>[KNN ${k} @vector $BLOB AS score]`,
          "RETURN", "1", "text",
          "SORTBY", "score", "ASC",
          "PARAMS", "2", "BLOB", Buffer.from(v.buffer),
          "LIMIT", "0", String(k),
          "DIALECT", "2",
        ]);
        return parseSearch(reply);
      }
    }
    // Full-text fallback.
    const terms = query.replace(/[^a-zA-Z0-9 ]/g, " ").trim().slice(0, 120) || "*";
    const reply = await client.sendCommand([
      "FT.SEARCH", INDEX,
      `@repo:{${repoTag}} ${terms}`,
      "RETURN", "1", "text",
      "LIMIT", "0", String(k),
      "DIALECT", "2",
    ]);
    return parseSearch(reply);
  } catch (e) {
    console.error("[memory] recall failed:", (e as Error).message);
    return [];
  }
}

export function memoryMode(): "vector" | "fulltext" | "off" {
  if (!redisEnabled() || !memoryReady) return "off";
  return hasVectors ? "vector" : "fulltext";
}
