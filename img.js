// GET /api/img?url=<image url>  ->  the image, served from this site so the page can shrink it into a thumbnail
const { UA_BOT, publicHttpUrl, fetchWithTimeout } = require("./_lib");
const MAX = 8 * 1024 * 1024;

module.exports = async (req, res) => {
  const u = publicHttpUrl(req.query && req.query.url);
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
};
