// Shared helpers for the preview functions (files starting with _ are not routes on Vercel).
const UA_BOT = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

function publicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  // no IP literals / local names (keeps this from being used to reach private networks)
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.endsWith(".local") || h.endsWith(".internal") || h === "localhost") return null;
  return u;
}

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { redirect: "follow", ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function metaTags(html) {
  const out = {};
  const re = /<meta\s+[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/content\s*=\s*"([^"]*)"/i) || tag.match(/content\s*=\s*'([^']*)'/i) || [])[1];
    if (key && val != null && !(key.toLowerCase() in out)) out[key.toLowerCase()] = decodeEntities(val);
  }
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  if (title && !out["title"]) out["title"] = decodeEntities(title).trim();
  return out;
}

module.exports = { UA_BOT, publicHttpUrl, fetchWithTimeout, decodeEntities, metaTags };
