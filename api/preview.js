// GET /api/preview?url=<post url>  -> { title, description, image, author }
// GET /api/preview?img=<image url>  -> the image itself (so the page can make a thumbnail)
// GET/POST /api/preview?data       -> your bookmarks, stored in Vercel Storage (needs header x-shiori-pass)
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


// ---------- shared bookmark data (Upstash Redis via Vercel Storage) ----------
const crypto = require("crypto");
const KEY = "shioribako:data:v1";
// works whatever prefix was chosen when connecting Upstash (KV_, STORAGE_, ...)
function findEnv(re) { const k = Object.keys(process.env).find(n => re.test(n) && process.env[n]); return k ? process.env[k] : ""; }
function redisCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || findEnv(/(^|_)(KV_)?REST_API_URL$/) || findEnv(/REDIS_REST_URL$/);
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || findEnv(/(^|_)(KV_)?REST_API_TOKEN$/) || findEnv(/REDIS_REST_TOKEN$/);
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}
async function redis(cmd) {
  const c = redisCfg();
  const r = await fetchWithTimeout(c.url, { method: "POST", headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" }, body: JSON.stringify(cmd) }, 8000);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error("redis: " + (j.error || r.status));
  return j.result;
}
function passOk(given) {
  const want = process.env.SHIORI_PASSWORD || "";
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return want.length > 0 && crypto.timingSafeEqual(a, b);
}
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
function cleanCat(c) { return c && c.id && c.name ? { id: str(c.id, 60), name: str(c.name, 30), color: str(c.color || "#2E44D6", 20) } : null; }
function cleanItem(it) {
  if (!it || !it.id || !it.url || !/^https?:\/\//i.test(String(it.url))) return null;
  const o = { id: str(it.id, 60), url: str(it.url, 2000), title: str(it.title, 120), note: str(it.note, 1000), categoryId: it.categoryId ? str(it.categoryId, 60) : null, createdAt: Number(it.createdAt) || Date.now() };
  for (const k of ["pvTitle", "pvDesc", "pvAuthor"]) if (it[k]) o[k] = str(it[k], 300);
  if (it.pvAt) o.pvAt = Number(it.pvAt) || 0;
  return o;
}
function applyOp(doc, op) {
  if (!op || typeof op !== "object") return;
  if (op.op === "setCats" && Array.isArray(op.cats)) {
    doc.cats = op.cats.map(cleanCat).filter(Boolean).slice(0, 200);
    const ids = new Set(doc.cats.map(c => c.id));
    for (const it of doc.items) if (it.categoryId && !ids.has(it.categoryId)) it.categoryId = null;
  } else if (op.op === "upsertItem") {
    const it = cleanItem(op.item); if (!it) return;
    const i = doc.items.findIndex(x => x.id === it.id);
    if (i >= 0) doc.items[i] = it; else if (!doc.items.some(x => x.url === it.url)) doc.items.push(it);
  } else if (op.op === "patchItem") {
    const i = doc.items.findIndex(x => x.id === op.id); if (i < 0) return;
    const merged = cleanItem({ ...doc.items[i], ...(op.patch || {}), id: doc.items[i].id }); if (merged) doc.items[i] = merged;
  } else if (op.op === "deleteItem") {
    doc.items = doc.items.filter(x => x.id !== op.id);
  } else if (op.op === "merge") {
    for (const c of (op.cats || []).map(cleanCat).filter(Boolean)) if (!doc.cats.some(x => x.id === c.id)) doc.cats.push(c);
    for (const it of (op.items || []).map(cleanItem).filter(Boolean)) if (!doc.items.some(x => x.id === it.id || x.url === it.url)) doc.items.push(it);
  }
}
async function serveData(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!redisCfg()) { res.status(503).json({ error: "no_storage" }); return; }
  if (!process.env.SHIORI_PASSWORD) { res.status(503).json({ error: "no_password_set" }); return; }
  let given = ""; try { given = decodeURIComponent(req.headers["x-shiori-pass"] || ""); } catch (e) {}
  if (!passOk(given)) { res.status(401).json({ error: "bad_password" }); return; }
  let doc = null;
  try { const raw = await redis(["GET", KEY]); doc = raw ? JSON.parse(raw) : null; } catch (e) { res.status(502).json({ error: "storage_error" }); return; }
  const fresh = !doc;
  if (!doc || !Array.isArray(doc.items) || !Array.isArray(doc.cats)) doc = { cats: [], items: [], rev: 0 };
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const ops = body && Array.isArray(body.ops) ? body.ops.slice(0, 200) : [];
    for (const op of ops) applyOp(doc, op);
    if (doc.items.length > 5000) { res.status(413).json({ error: "too_many" }); return; }
    doc.rev = (doc.rev || 0) + 1; doc.updatedAt = Date.now();
    try { await redis(["SET", KEY, JSON.stringify(doc)]); } catch (e) { res.status(502).json({ error: "storage_error" }); return; }
  }
  res.status(200).json({ ...doc, fresh: fresh && req.method !== "POST" });
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
  if (req.query && req.query.data !== undefined) return serveData(req, res);
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
