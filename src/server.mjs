import express from "express";
import crypto from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 7000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GEMINI_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || "low";
const UPSTREAM_STREAM_ADDON_URL = process.env.UPSTREAM_STREAM_ADDON_URL || "";
const MAX_STREAMS = Math.max(1, Number(process.env.MAX_STREAMS || 6));
const MAX_UPSTREAMS = Math.min(6, Math.max(1, Number(process.env.MAX_UPSTREAMS || 4)));
const UPSTREAM_TIMEOUT_MS = Math.max(500, Number(process.env.UPSTREAM_TIMEOUT_MS || 2500));
const GEMINI_TIMEOUT_MS = Math.max(500, Number(process.env.GEMINI_TIMEOUT_MS || 2200));
const CACHE_TTL_MS = Math.max(1000, Number(process.env.CACHE_TTL_MS || 20000));
const STALE_TTL_MS = Math.max(CACHE_TTL_MS, Number(process.env.STALE_TTL_MS || 300000));
const AI_CACHE_TTL_MS = Math.max(10000, Number(process.env.AI_CACHE_TTL_MS || 180000));
const AI_ENABLED = String(process.env.AI_ENABLED ?? "true").toLowerCase() !== "false";

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use((_req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const manifest = {
  id: "com.1eddd.nuvio.ai",
  version: "0.2.0",
  name: "Nuvio AI",
  description: "Fast AI-powered stream cleanup, quality ranking, duplicate reduction and fallback selection.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
    p2p: true
  },
  config: [
    {
      key: "upstream",
      type: "text",
      title: "Upstream stream addon URL",
      required: true,
      default: ""
    },
    {
      key: "max",
      type: "number",
      title: "Maximum results",
      default: String(MAX_STREAMS),
      required: false
    }
  ]
};

const responseCache = new Map();
const aiCache = new Map();
const refreshLocks = new Map();

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function cleanUrl(raw) {
  if (!raw) return "";
  let value = String(raw).trim();
  if (!value) return "";
  value = value.replace(/\/+$/, "");
  value = value.replace(/\/manifest\.json$/i, "");
  return value;
}

function decodeConfig(raw) {
  if (!raw) return {};
  try {
    const normalized = String(raw).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(decodeURIComponent(raw));
    } catch {
      return {};
    }
  }
}

function getConfig(req) {
  const pathConfig = decodeConfig(req.params.config);
  const queryConfig = decodeConfig(req.query.config);

  return {
    ...queryConfig,
    ...pathConfig
  };
}

function getUpstreams(req) {
  const config = getConfig(req);
  const raw = [
    config.upstreams,
    config.upstream,
    req.query.upstreams,
    req.query.upstream,
    UPSTREAM_STREAM_ADDON_URL
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/[\n,|]+/))
    .map(cleanUrl)
    .filter(Boolean);

  return [...new Set(raw)].slice(0, MAX_UPSTREAMS);
}

function getMaxStreams(req) {
  const config = getConfig(req);
  const requested = Number(config.max || req.query.max || MAX_STREAMS);
  if (!Number.isFinite(requested)) return MAX_STREAMS;
  return Math.min(20, Math.max(1, Math.floor(requested)));
}

function getCacheKey(type, id, upstreams, maxStreams) {
  return stableHash(JSON.stringify({
    type,
    id,
    upstreams,
    maxStreams,
    ai: AI_ENABLED ? GEMINI_MODEL : "off"
  }));
}

function getText(stream) {
  return [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function firstMatch(text, patterns) {
  for (const [value, re] of patterns) {
    if (re.test(text)) return value;
  }
  return null;
}

function parseRelease(stream) {
  const text = getText(stream);

  const resolution = firstMatch(text, [
    [2160, /(?:2160p|4k|uhd)/i],
    [1080, /1080p/i],
    [720, /720p/i],
    [576, /576p/i],
    [480, /480p/i],
    [360, /360p/i]
  ]) || 0;

  const source = firstMatch(text, [
    ["remux", /remux/i],
    ["bluray", /blu(?:-)?ray/i],
    ["web-dl", /web[ .-]?dl/i],
    ["webrip", /web[ .-]?rip/i],
    ["hdtv", /hdtv/i],
    ["dvd", /dvd/i],
    ["tv", /\btv\b/i]
  ]) || "unknown";

  const codec = firstMatch(text, [
    ["av1", /\bav1\b/i],
    ["hevc", /(?:\bhevc\b|x265)/i],
    ["avc", /(?:\bavc\b|x264|h\.264)/i],
    ["vp9", /\bvp9\b/i]
  ]) || "unknown";

  const audio = firstMatch(text, [
    ["truehd", /truehd/i],
    ["atmos", /atmos/i],
    ["dts-hd", /dts[ .-]?hd/i],
    ["dts", /\bdts\b/i],
    ["eac3", /(?:eac3|e-ac-3|ddp)/i],
    ["ac3", /(?:\bac3\b|dd5\.1|dolby digital)/i],
    ["aac", /\baac\b/i]
  ]) || "unknown";

  const hdr = firstMatch(text, [
    ["dolby-vision", /(?:dolby.?vision|\bdv\b)/i],
    ["hdr10+", /hdr10\+/i],
    ["hdr10", /hdr10/i],
    ["hdr", /\bhdr\b/i]
  ]) || "sdr";

  const flags = {
    proper: /(?:repack|proper)/i.test(text),
    cam: /(?:\bcam\b|camrip|telesync|telecine|\bts\b)/i.test(text),
    lowQuality: /(?:screener|workprint|hdtc)/i.test(text),
    "3d": /\b3d\b/i.test(text),
    anime: /(?:\banime\b|\bdual audio\b)/i.test(text)
  };

  const seeders = Number(
    stream.seeders ??
    stream.behaviorHints?.seeders ??
    stream.meta?.seeders ??
    0
  ) || 0;

  const videoSize = Number(stream.behaviorHints?.videoSize || stream.videoSize || 0) || 0;

  return {
    resolution,
    source,
    codec,
    audio,
    hdr,
    flags,
    seeders,
    videoSize
  };
}

function releaseIdentity(stream, parsed) {
  const hash = stream.behaviorHints?.videoHash || stream.infoHash;
  if (hash) return "hash:" + String(hash).toLowerCase();

  const filename =
    stream.behaviorHints?.filename ||
    stream.title ||
    stream.name ||
    stream.url ||
    "";

  const normalized = String(filename)
    .toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:multi|dual|eng|english|arabic|ita|spa|fra)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return [
    normalized.slice(0, 160),
    parsed.resolution,
    parsed.source,
    parsed.codec,
    parsed.audio,
    parsed.hdr
  ].join("|");
}

function scoreStream(stream) {
  const p = parseRelease(stream);
  let score = 0;

  const resolutionScore = {
    2160: 52,
    1080: 40,
    720: 25,
    576: 15,
    480: 10,
    360: 5
  };
  score += resolutionScore[p.resolution] || 0;

  const sourceScore = {
    remux: 30,
    bluray: 26,
    "web-dl": 21,
    webrip: 15,
    hdtv: 7,
    dvd: 4,
    tv: 3,
    unknown: 0
  };
  score += sourceScore[p.source] || 0;

  const codecScore = {
    av1: 11,
    hevc: 10,
    avc: 5,
    vp9: 6,
    unknown: 0
  };
  score += codecScore[p.codec] || 0;

  const audioScore = {
    truehd: 10,
    atmos: 11,
    "dts-hd": 9,
    dts: 7,
    eac3: 6,
    ac3: 4,
    aac: 2,
    unknown: 0
  };
  score += audioScore[p.audio] || 0;

  const hdrScore = {
    "dolby-vision": 8,
    "hdr10+": 7,
    hdr10: 6,
    hdr: 4,
    sdr: 0
  };
  score += hdrScore[p.hdr] || 0;

  if (p.flags.proper) score += 6;
  if (p.flags.cam) score -= 120;
  if (p.flags.lowQuality) score -= 45;
  if (p.flags["3d"]) score -= 3;

  if (p.seeders > 0) {
    score += Math.min(12, Math.log2(p.seeders + 1) * 2.5);
  }

  if (p.videoSize > 0 && p.resolution >= 1080) {
    const gb = p.videoSize / (1024 ** 3);
    if (gb >= 2 && gb <= 35) score += 3;
    if (gb > 80) score -= 4;
  }

  return { score, parsed: p };
}

function decorateStream(stream, rank, parsed) {
  const quality = [
    parsed.resolution ? parsed.resolution + "p" : null,
    parsed.hdr !== "sdr" ? parsed.hdr : null,
    parsed.codec !== "unknown" ? parsed.codec : null,
    parsed.audio !== "unknown" ? parsed.audio : null
  ]
    .filter(Boolean)
    .join(" · ");

  const originalName = stream.name || stream.title || "Stream";
  const prefix =
    rank === 0 ? "★ BEST" :
    rank === 1 ? "⚡ FAST BACKUP" :
    rank === 2 ? "◆ BACKUP" :
    "•";

  const out = {
    ...stream,
    name: quality ? `${prefix} · ${quality}\n${originalName}` : `${prefix} · ${originalName}`,
    behaviorHints: {
      ...(stream.behaviorHints || {}),
      bingeGroup: `nuvio-ai-${parsed.resolution || "auto"}-${parsed.source}-${parsed.codec}`
    }
  };

  return out;
}

function dedupeAndRank(streams) {
  const groups = new Map();

  for (const stream of streams) {
    const { score, parsed } = scoreStream(stream);
    const identity = releaseIdentity(stream, parsed);
    const item = {
      stream,
      score,
      parsed,
      identity
    };

    const existing = groups.get(identity);
    if (!existing || item.score > existing.score) {
      groups.set(identity, item);
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;

    const aSeeders = a.parsed.seeders || 0;
    const bSeeders = b.parsed.seeders || 0;
    if (bSeeders !== aSeeders) return bSeeders - aSeeders;

    return String(a.stream.name || "").localeCompare(String(b.stream.name || ""));
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstream(type, id, upstream) {
  const base = cleanUrl(upstream);
  if (!base) return [];

  const url =
    base +
    "/stream/" +
    encodeURIComponent(type) +
    "/" +
    encodeURIComponent(id) +
    ".json";

  const response = await fetchWithTimeout(
    url,
    { headers: { accept: "application/json" } },
    UPSTREAM_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Upstream ${base} returned ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data?.streams)
    ? data.streams.map((stream) => ({
        ...stream,
        _nuvioUpstream: base
      }))
    : [];
}

async function gatherStreams(type, id, upstreams) {
  if (!upstreams.length) return [];

  const results = await Promise.allSettled(
    upstreams.map((upstream) => fetchUpstream(type, id, upstream))
  );

  return results
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value);
}

function sanitizeForAI(items) {
  return items.map((item, index) => ({
    i: index,
    resolution: item.parsed.resolution,
    source: item.parsed.source,
    codec: item.parsed.codec,
    audio: item.parsed.audio,
    hdr: item.parsed.hdr,
    seeders: item.parsed.seeders,
    sizeGB: item.parsed.videoSize
      ? Math.round((item.parsed.videoSize / (1024 ** 3)) * 10) / 10
      : null,
    proper: item.parsed.flags.proper,
    baselineScore: Math.round(item.score * 100) / 100,
    label: String(item.stream.name || item.stream.title || "Stream")
      .replace(/https?:\/\/[^\s]+/gi, "")
      .slice(0, 180)
  }));
}

async function geminiRank(items, meta) {
  if (!AI_ENABLED || !GEMINI_API_KEY || items.length < 3) {
    return items;
  }

  const fingerprint = stableHash(
    JSON.stringify({
      type: meta.type,
      id: meta.id,
      items: sanitizeForAI(items)
    })
  );

  const cached = aiCache.get(fingerprint);
  if (cached && cached.expiresAt > now()) {
    return cached.items;
  }

  const payload = sanitizeForAI(items);

  const prompt = [
    "You rank streaming releases for a media player.",
    "Choose the best releases for playback quality, compatibility, and reliability.",
    "Prefer genuine high-quality sources over misleading labels.",
    "Do not invent anything.",
    "Return ONLY a JSON array of indexes, best first.",
    "Do not omit an index unless you are certain it is inferior.",
    "The client already has the real stream URLs; never output URLs.",
    "Media:",
    JSON.stringify(meta),
    "Candidates:",
    JSON.stringify(payload)
  ].join("\n");

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(GEMINI_MODEL) +
    ":generateContent";

  try {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            thinkingConfig: {
              thinkingLevel: GEMINI_THINKING_LEVEL
            }
          }
        })
      },
      GEMINI_TIMEOUT_MS
    );

    if (!response.ok) return items;

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const indexes = JSON.parse(text);

    if (!Array.isArray(indexes)) return items;

    const orderedIndexes = [];
    const seen = new Set();

    for (const value of indexes) {
      if (
        Number.isInteger(value) &&
        value >= 0 &&
        value < items.length &&
        !seen.has(value)
      ) {
        seen.add(value);
        orderedIndexes.push(value);
      }
    }

    for (let i = 0; i < items.length; i += 1) {
      if (!seen.has(i)) orderedIndexes.push(i);
    }

    const ordered = orderedIndexes.map((index) => items[index]);

    aiCache.set(fingerprint, {
      items: ordered,
      expiresAt: now() + AI_CACHE_TTL_MS
    });

    return ordered;
  } catch {
    return items;
  }
}

function stripInternal(stream) {
  const copy = { ...stream };
  delete copy._nuvioUpstream;
  delete copy._nuvioScore;
  delete copy._nuvioIdentity;
  return copy;
}

async function buildResponse(type, id, upstreams, maxStreams) {
  const gathered = await gatherStreams(type, id, upstreams);
  const ranked = dedupeAndRank(gathered);

  const aiPool = ranked.slice(0, Math.max(maxStreams * 2, 12));
  const aiRanked = await geminiRank(aiPool, { type, id });

  const selected = aiRanked
    .slice(0, maxStreams)
    .map((item, index) => decorateStream(item.stream, index, item.parsed))
    .map(stripInternal);

  return {
    streams: selected,
    cacheMaxAge: Math.floor(CACHE_TTL_MS / 1000),
    staleRevalidate: Math.floor(STALE_TTL_MS / 1000)
  };
}

async function refresh(type, id, upstreams, maxStreams, cacheKey) {
  const existingLock = refreshLocks.get(cacheKey);
  if (existingLock) return existingLock;

  const promise = (async () => {
    try {
      const data = await buildResponse(type, id, upstreams, maxStreams);
      responseCache.set(cacheKey, {
        data,
        expiresAt: now() + CACHE_TTL_MS,
        staleUntil: now() + STALE_TTL_MS
      });
      return data;
    } finally {
      refreshLocks.delete(cacheKey);
    }
  })();

  refreshLocks.set(cacheKey, promise);
  return promise;
}

function sendResponse(res, data, cacheState = "hit") {
  res.setHeader(
    "Cache-Control",
    `public, max-age=${Math.max(1, data.cacheMaxAge)}, stale-while-revalidate=${Math.max(1, data.staleRevalidate)}, stale-if-error=${Math.max(1, data.staleRevalidate)}`
  );
  res.setHeader("X-Nuvio-Cache", cacheState);
  res.json(data);
}

app.get("/", (_req, res) => {
  res.json({
    name: "Nuvio AI",
    version: manifest.version,
    status: "ok",
    model: GEMINI_MODEL,
    ai: Boolean(GEMINI_API_KEY && AI_ENABLED),
    manifest: "/manifest.json"
  });
});

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    model: GEMINI_MODEL,
    aiEnabled: AI_ENABLED && Boolean(GEMINI_API_KEY)
  });
});

app.get("/manifest.json", (_req, res) => {
  res.json(manifest);
});

app.get("/:config/stream/:type/:id.json", handleStream);
app.get("/stream/:type/:id.json", handleStream);

async function handleStream(req, res) {
  const { type, id } = req.params;
  const upstreams = getUpstreams(req);
  const maxStreams = getMaxStreams(req);

  if (!upstreams.length) {
    return res.status(400).json({
      streams: [],
      error: "No upstream stream addon configured."
    });
  }

  const cacheKey = getCacheKey(type, id, upstreams, maxStreams);
  const cached = responseCache.get(cacheKey);

  if (cached && cached.expiresAt > now()) {
    return sendResponse(res, cached.data, "fresh");
  }

  if (cached && cached.staleUntil > now()) {
    void refresh(type, id, upstreams, maxStreams, cacheKey);

    return sendResponse(res, cached.data, "stale");
  }

  try {
    const data = await refresh(type, id, upstreams, maxStreams, cacheKey);
    return sendResponse(res, data, "miss");
  } catch (error) {
    if (cached) {
      return sendResponse(res, cached.data, "stale-error");
    }

    return res.status(502).json({
      streams: [],
      error: error instanceof Error ? error.message : "Upstream request failed"
    });
  }
}

app.listen(PORT, () => {
  console.log(`Nuvio AI listening on port ${PORT}`);
});
