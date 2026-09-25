// GET /api/preview?url=<post url>  ->  { title, description, image, author }
const { UA_BOT, publicHttpUrl, fetchWithTimeout, metaTags } = require("./_lib");

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
