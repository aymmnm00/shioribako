// GET /api/preview?url=<post url>  -> { title, description, image, author }
// GET /api/preview?img=<image url>  -> the image itself (so the page can make a thumbnail)
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


const MAX = 8 * 1024 * 1024;
async function serveImage(req, res) {
  const u = publicHttpUrl(req.query && req.query.img);
  if (!u) { res.status(400).end(); return; }
  try {
    const r = await fetchWithTimeout(u.href, { headers: { "User-Agent": UA_BOT } });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !/^image\//i.test(type)) { res.status(404).end(); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX) { res.status(413).end(); return; }
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, s-maxage=86400");
    res.status(200).send(buf);
  } catch (e) { res.status(502).end(); }
}


const clip = (s, n) => (s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) : "");

async function fromX(u) {
  const m = u.pathname.match(/\/status(?:es)?\/(\d+)/);
  if (!m) return null;
  const r = await fetchWithTimeout("https://api.fxtwitter.com/status/" + m[1], { headers: { "User-Agent": "shioribako" } });
  if (!r.ok) return null;
  const j = await r.json();
  const t = j && j.tweet;
  if (!t) return null;
  const media = t.media || {};
  const image = (media.photos && media.photos[0] && media.photos[0].url)
    || (media.videos && media.videos[0] && media.videos[0].thumbnail_url)
    || (media.mosaic && media.mosaic.formats && media.mosaic.formats.jpeg) || "";
  const author = t.author ? "@" + t.author.screen_name : "";
  return { title: clip(t.text, 140), description: t.author ? clip(t.author.name, 60) : "", image, author };
}

async function fromTikTok(u) {
  const r = await fetchWithTimeout("https://www.tiktok.com/oembed?url=" + encodeURIComponent(u.href));
  if (!r.ok) return null;
  const j = await r.json();
  if (!j) return null;
  return { title: clip(j.title, 140), description: clip(j.author_name, 60), image: j.thumbnail_url || "", author: j.author_unique_id ? "@" + j.author_unique_id : "" };
}

async function fromOg(u) {
  const r = await fetchWithTimeout(u.href, { headers: { "User-Agent": UA_BOT, "Accept-Language": "ja,en;q=0.8" } });
  if (!r.ok) return null;
  const html = (await r.text()).slice(0, 600000);
  const m = metaTags(html);
  const title = m["og:title"] || m["twitter:title"] || m["title"] || "";
  const description = m["og:description"] || m["twitter:description"] || m["description"] || "";
  let image = m["og:image"] || m["og:image:url"] || m["twitter:image"] || "";
  if (image) { try { image = new URL(image, u.href).href; } catch (e) { image = ""; } }
  if (!title && !image) return null;
  return { title: clip(title, 140), description: clip(description, 200), image, author: "" };
}

module.exports = async (req, res) => {
  if (req.query && req.query.img) return serveImage(req, res);
  const u = publicHttpUrl(req.query && req.query.url);
  if (!u) { res.status(400).json({ error: "bad_url" }); return; }
  const h = u.hostname.replace(/^(www|m|mobile|vm|vt)\./, "");
  let out = null;
  try {
    if (h === "x.com" || h === "twitter.com") out = await fromX(u);
    else if (h.endsWith("tiktok.com")) out = await fromTikTok(u);
    if (!out) out = await fromOg(u);
  } catch (e) { out = null; }
  res.setHeader("Cache-Control", out ? "public, s-maxage=86400" : "no-store");
  if (!out) { res.status(404).json({ error: "not_found" }); return; }
  res.status(200).json(out);
};
