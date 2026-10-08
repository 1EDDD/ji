import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 7000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const UPSTREAM_STREAM_ADDON_URL = process.env.UPSTREAM_STREAM_ADDON_URL || "";
const MAX_STREAMS = Math.max(1, Number(process.env.MAX_STREAMS || 8));

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const manifest = {
  id: "com.1eddd.nuvio.ai",
  version: "0.1.0",
  name: "Nuvio AI",
  description: "AI-assisted stream ranking and duplicate reduction for Nuvio.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  behaviorHints: { configurable: true, configurationRequired: true },
  config: [
    {
      key: "upstream",
      type: "text",
      title: "Upstream stream addon URL",
      required: true,
      default: ""
    }
  ]
};

app.get("/", (_req, res) => {
  res.json({ name: "Nuvio AI", status: "ok", manifest: "/manifest.json" });
});

app.get("/manifest.json", (_req, res) => res.json(manifest));

function scoreStream(s) {
  const text = JSON.stringify(s).toLowerCase();
  let score = 0;

  if (text.includes("2160p") || text.includes("4k")) score += 45;
  else if (text.includes("1080p")) score += 35;
  else if (text.includes("720p")) score += 20;

  if (text.includes("bluray") || text.includes("remux")) score += 20;
  if (text.includes("web-dl")) score += 14;
  if (text.includes("hevc") || text.includes("x265")) score += 10;
  if (text.includes("eac3") || text.includes("ddp") || text.includes("dd5.1")) score += 8;
  if (text.includes("hdr")) score += 5;

  if (text.includes("cam") || text.includes("ts") || text.includes("telesync")) score -= 60;
  return score;
}

function dedupe(streams) {
  const seen = new Set();
  return streams.filter((s) => {
    const key = [
      s.url || s.externalUrl || "",
      s.name || "",
      s.title || "",
      s.behaviorHints?.videoHash || ""
    ].join("|").toLowerCase();

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function geminiRank(candidates, meta) {
  if (!GEMINI_API_KEY || candidates.length < 2) return candidates;

  const prompt = [
    "You are a media release ranking assistant.",
    "Choose the best releases for reliable playback and high quality.",
    "Do not invent URLs or metadata.",
    "Return ONLY a JSON array of candidate indexes, best first.",
    "Media: " + (meta.type || "") + " " + (meta.id || ""),
    JSON.stringify(candidates.map((x, i) => ({
      i,
      name: x.name,
      title: x.title,
      url: x.url,
      behaviorHints: x.behaviorHints
    })))
  ].join("\n");

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(GEMINI_MODEL) +
    ":generateContent?key=" +
    encodeURIComponent(GEMINI_API_KEY);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json"
        }
      })
    });

    if (!r.ok) return candidates;

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const indexes = JSON.parse(text);

    if (!Array.isArray(indexes)) return candidates;

    const ordered = indexes
      .filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length)
      .map((i) => candidates[i]);

    const used = new Set(ordered);
    return ordered.concat(candidates.filter((x) => !used.has(x)));
  } catch {
    return candidates;
  }
}

function decodeConfig(raw) {
  if (!raw) return {};
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
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

function getUpstreamUrl(req) {
  const configured = decodeConfig(req.params.config || req.query.config);
  return configured.upstream || UPSTREAM_STREAM_ADDON_URL;
}

async function fetchUpstream(type, id, upstreamUrl) {
  if (!upstreamUrl) return [];

  const base = upstreamUrl.replace(/\/$/, "");
  const url =
    base +
    "/stream/" +
    encodeURIComponent(type) +
    "/" +
    encodeURIComponent(id) +
    ".json";

  const r = await fetch(url, {
    headers: { accept: "application/json" }
  });

  if (!r.ok) {
    throw new Error("Upstream stream addon returned " + r.status);
  }

  const data = await r.json();
  return Array.isArray(data?.streams) ? data.streams : [];
}

app.get("/:config/stream/:type/:id.json", handleStream);
app.get("/stream/:type/:id.json", handleStream);

async function handleStream(req, res) {
  try {
    const { type, id } = req.params;

    const upstreamUrl = getUpstreamUrl(req);
    let streams = await fetchUpstream(type, id, upstreamUrl);

    streams = dedupe(streams)
      .map((s) => ({ ...s, _nuvioScore: scoreStream(s) }))
      .sort((a, b) => b._nuvioScore - a._nuvioScore);

    const poolSize = Math.max(MAX_STREAMS * 2, 12);
    streams = await geminiRank(
      streams.slice(0, poolSize),
      { type, id }
    );

    streams = streams
      .slice(0, MAX_STREAMS)
      .map(({ _nuvioScore, ...s }) => s);

    res.json({ streams });
  } catch (error) {
    res.status(502).json({
      streams: [],
      error: error.message
    });
  }
}

app.listen(PORT, () => {
  console.log("Nuvio AI listening on port " + PORT);
});
