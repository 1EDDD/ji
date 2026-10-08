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
const UPSTREAM_TIMEOUT_MS = Math.max(500, Number(process.env.UPSTREAM_TIMEOUT_MS || 1200));
const FAST_RETURN_MS = Math.max(0, Number(process.env.FAST_RETURN_MS || 250));
const GEMINI_TIMEOUT_MS = Math.max(500, Number(process.env.GEMINI_TIMEOUT_MS || 1800));
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
  version: "0.3.0",
  name: "Nuvio AI",
  description: "Fast AI-powered stream intelligence with instant fallback, smart ranking and a polished Apple TV-inspired dashboard.",
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

  const originalName = String(stream.name || stream.title || "Stream").trim();
  const badge =
    rank === 0 ? "BEST MATCH" :
    rank === 1 ? "FASTEST" :
    rank === 2 ? "BACKUP" :
    "OPTION";

  return {
    ...stream,
    name: quality ? `${badge}  •  ${quality}` : badge,
    title: originalName,
    description: quality
      ? `${quality}  •  Selected by Nuvio AI`
      : "Selected by Nuvio AI",
    behaviorHints: {
      ...(stream.behaviorHints || {}),
      bingeGroup: `nuvio-ai-${parsed.resolution || "auto"}-${parsed.source}-${parsed.codec}`
    }
  };
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

  const completed = [];
  const jobs = upstreams.map((upstream, index) =>
    fetchUpstream(type, id, upstream)
      .then((streams) => {
        const result = { index, upstream, streams };
        completed.push(result);
        return result;
      })
      .catch((error) => {
        const result = { index, upstream, streams: [], error };
        completed.push(result);
        return result;
      })
  );

  const nonEmpty = jobs.map((job) =>
    job.then((result) => {
      if (result.streams.length) return result;
      throw result.error || new Error("empty upstream");
    })
  );

  try {
    const first = await Promise.any(nonEmpty);
    if (FAST_RETURN_MS === 0) return first.streams;

    // Return as soon as one source is ready. Only harvest requests that
    // have already finished during the tiny grace window.
    await sleep(FAST_RETURN_MS);

    const combined = completed
      .filter((result) => result.streams.length)
      .sort((a, b) => a.index - b.index)
      .flatMap((result) => result.streams);

    return combined.length ? combined : first.streams;
  } catch {
    // Only wait for all requests when every source was empty/failed.
    const results = await Promise.all(jobs);
    return results
      .filter((result) => result.streams.length)
      .sort((a, b) => a.index - b.index)
      .flatMap((result) => result.streams);
  }
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

function makeResponse(items, maxStreams) {
  const selected = items
    .slice(0, maxStreams)
    .map((item, index) => decorateStream(item.stream, index, item.parsed))
    .map(stripInternal);

  return {
    streams: selected,
    cacheMaxAge: Math.floor(CACHE_TTL_MS / 1000),
    staleRevalidate: Math.floor(STALE_TTL_MS / 1000)
  };
}

async function buildBaselineResponse(type, id, upstreams, maxStreams) {
  const gathered = await gatherStreams(type, id, upstreams);
  const ranked = dedupeAndRank(gathered);
  return {
    data: makeResponse(ranked, maxStreams),
    ranked
  };
}

async function enhanceCacheWithAI(type, id, maxStreams, cacheKey, ranked) {
  if (!AI_ENABLED || !GEMINI_API_KEY || ranked.length < 3) return;

  try {
    const aiPool = ranked.slice(0, Math.max(maxStreams * 2, 12));
    const aiRanked = await geminiRank(aiPool, { type, id });
    const enhanced = makeResponse(aiRanked, maxStreams);

    responseCache.set(cacheKey, {
      data: enhanced,
      expiresAt: now() + CACHE_TTL_MS,
      staleUntil: now() + STALE_TTL_MS
    });
  } catch {
    // Keep the fast baseline response in cache.
  }
}

async function refresh(type, id, upstreams, maxStreams, cacheKey) {
  const existingLock = refreshLocks.get(cacheKey);
  if (existingLock) return existingLock;

  const promise = (async () => {
    try {
      // Return the deterministic quality-ranked list first.
      // AI refinement continues in the background so opening a stream
      // never waits for Gemini.
      const baseline = await buildBaselineResponse(
        type,
        id,
        upstreams,
        maxStreams
      );

      responseCache.set(cacheKey, {
        data: baseline.data,
        expiresAt: now() + CACHE_TTL_MS,
        staleUntil: now() + STALE_TTL_MS
      });

      void enhanceCacheWithAI(
        type,
        id,
        maxStreams,
        cacheKey,
        baseline.ranked
      );

      return baseline.data;
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
  if (res.locals.nuvioStartedAt) {
    res.setHeader("X-Nuvio-Duration", String(now() - res.locals.nuvioStartedAt));
  }
  res.json(data);
}

function renderDashboard() {
  const ai = Boolean(GEMINI_API_KEY && AI_ENABLED);
  const manifestUrl = "/manifest.json";
  const statusText = ai ? "AI READY" : "FAST MODE";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#05060a">
<title>Nuvio AI</title>
<style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",Inter,system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(circle at 18% 8%,rgba(80,110,255,.22),transparent 28%),radial-gradient(circle at 88% 26%,rgba(175,90,255,.18),transparent 24%),linear-gradient(180deg,#070910 0%,#030409 100%);color:#f5f7ff}
.wrap{max-width:980px;margin:auto;padding:32px 22px 64px}
.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:46px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.02em}
.dot{width:12px;height:12px;border-radius:50%;background:linear-gradient(135deg,#8aa4ff,#b36cff);box-shadow:0 0 24px rgba(139,164,255,.8)}
.pill{padding:8px 13px;border:1px solid rgba(255,255,255,.09);border-radius:999px;background:rgba(255,255,255,.05);font-size:12px;color:#cdd2e2}
.hero{padding:42px 0 28px}.kicker{color:#9eabff;font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}
h1{font-size:clamp(46px,9vw,88px);line-height:.94;letter-spacing:-.065em;margin:14px 0 18px;max-width:780px}
.sub{font-size:18px;line-height:1.55;color:#aeb5c6;max-width:660px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:36px}
.card{padding:20px;border-radius:24px;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.035));border:1px solid rgba(255,255,255,.09);box-shadow:0 20px 70px rgba(0,0,0,.24);backdrop-filter:blur(22px)}
.label{font-size:12px;color:#8f96a9;text-transform:uppercase;letter-spacing:.08em}
.value{font-size:22px;font-weight:650;letter-spacing:-.03em;margin-top:8px}
.section{margin-top:30px}.section h2{font-size:22px;letter-spacing:-.03em;margin:0 0 14px}
.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px;border-radius:18px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);margin-top:10px}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#cbd1e1;overflow:auto;white-space:nowrap}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:13px 17px;border-radius:14px;background:#f5f7ff;color:#0a0b10;text-decoration:none;font-weight:650}
.muted{color:#8f96a9}.footer{margin-top:50px;color:#6f7687;font-size:13px}
@media(max-width:720px){.grid{grid-template-columns:1fr}.wrap{padding:20px 16px 46px}h1{font-size:54px}.sub{font-size:16px}.hero{padding-top:28px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="nav"><div class="brand"><span class="dot"></span><span>Nuvio AI</span></div><div class="pill">${statusText}</div></div>
  <div class="hero"><div class="kicker">Stream intelligence</div><h1>Fast. Clean.<br>Ridiculously selective.</h1><div class="sub">A fast intelligence layer that cleans up stream choices, removes duplicates and ranks the first playable options without waiting for AI.</div></div>
  <div class="grid">
    <div class="card"><div class="label">Model</div><div class="value">${GEMINI_MODEL}</div></div>
    <div class="card"><div class="label">AI ranking</div><div class="value">${ai ? "Enabled" : "Disabled"}</div></div>
    <div class="card"><div class="label">Response path</div><div class="value">Fast-first</div></div>
  </div>
  <div class="section"><h2>Connect to Nuvio</h2><div class="row"><div><div class="label">Manifest</div><div class="code">${manifestUrl}</div></div><a class="btn" href="${manifestUrl}">Open</a></div></div>
  <div class="section"><h2>Build</h2>
    <div class="row"><span>First non-empty upstream wins</span><span class="muted">fast fallback</span></div>
    <div class="row"><span>Duplicate releases collapse</span><span class="muted">clean list</span></div>
    <div class="row"><span>Gemini ranks in background</span><span class="muted">never blocks</span></div>
    <div class="row"><span>Stale cache survives slow sources</span><span class="muted">repeat opens</span></div>
  </div>
  <div class="footer">Nuvio AI 0.3 • Apple TV-inspired dark glass</div>
</div>
</body>
</html>`;
}

app.get("/", (req, res) => {
  if (String(req.headers.accept || "").includes("text/html")) {
    return res.type("html").send(renderDashboard());
  }
  return res.json({
    name: "Nuvio AI",
    version: manifest.version,
    status: "ok",
    model: GEMINI_MODEL,
    ai: Boolean(GEMINI_API_KEY && AI_ENABLED),
    manifest: "/manifest.json"
  });
});

app.get("/ui", (_req, res) => res.type("html").send(renderDashboard()));;

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
  res.locals.nuvioStartedAt = now();
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

    res.setHeader("X-Nuvio-Cache", "error");
    res.setHeader("X-Nuvio-Duration", String(now() - res.locals.nuvioStartedAt));
    return res.status(502).json({
      streams: [],
      error: error instanceof Error ? error.message : "Upstream request failed"
    });
  }
}

app.listen(PORT, () => {
  console.log(`Nuvio AI listening on port ${PORT}`);
});
