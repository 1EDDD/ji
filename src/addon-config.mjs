export function cleanUrl(raw) {
  if (!raw) return "";
  const value = String(raw).trim();
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (/\/manifest\.json$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\/manifest\.json$/i, "") || "/";
    }
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/+$/, "").replace(/\/manifest\.json$/i, "");
  }
}

export function decodeConfig(raw) {
  if (!raw) return {};
  const value = String(raw).trim();

  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}

  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}

  return {};
}

export function buildStreamUrl(upstream, type, id) {
  const base = cleanUrl(upstream);
  if (!base) throw new TypeError("Upstream must be a valid HTTP(S) URL");

  const endpoint = new URL(base);
  endpoint.pathname =
    endpoint.pathname.replace(/\/+$/, "") +
    "/stream/" +
    encodeURIComponent(type) +
    "/" +
    encodeURIComponent(id) +
    ".json";

  return endpoint.toString();
}
