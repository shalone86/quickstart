const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export async function ghostToken(adminKey, now = Date.now()) {
  const [id, secret] = String(adminKey || "").split(":");
  if (!id || !secret) throw new Error("GHOST_ADMIN_KEY must look like <id>:<secret>");
  const iat = Math.floor(now / 1e3);
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id })));
  const body = b64url(enc.encode(JSON.stringify({ iat, exp: iat + 300, aud: "/admin/" })));
  const key = await crypto.subtle.importKey("raw", hexToBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

export class GhostError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function ghostFetch(env, path, init = {}) {
  const url = env.GHOST_URL.replace(/\/$/, "") + "/ghost/api/admin" + path;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Ghost ${await ghostToken(env.GHOST_ADMIN_KEY)}`);
  headers.set("Accept-Version", "v6.0");
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const msg = data?.errors?.[0]?.context || data?.errors?.[0]?.message || `Ghost returned ${res.status}`;
    throw new GhostError(msg, res.status);
  }
  return data;
}

// Forwards a multipart body the phone already built (file + purpose + ref) to Ghost untouched.
// The Worker never parses the photo, so an 8-12 MB upload costs almost no CPU time.
export async function uploadImageRaw(env, body, contentType) {
  const data = await ghostFetch(env, "/images/upload/", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body
  });
  return data.images[0].url;
}

function galleryRows(n) {
  const rows = [];
  for (let left = n; left > 0; left -= 3) rows.push(Math.min(3, left));
  return rows;
}

function buildLexical(images) {
  const children = [];
  for (let i = 0; i < images.length; i += 9) {
    const chunk = images.slice(i, i + 9);
    const rows = galleryRows(chunk.length);
    let k = 0;
    const withRows = [];
    rows.forEach((count, row) => {
      for (let j = 0; j < count; j++, k++) {
        const img = chunk[k];
        withRows.push({
          row,
          fileName: img.url.split("/").pop(),
          src: img.url,
          width: img.width,
          height: img.height,
          title: "",
          alt: "",
          caption: "",
          href: ""
        });
      }
    });
    children.push({ type: "gallery", version: 1, images: withRows, caption: "" });
  }
  return JSON.stringify({
    root: { children, direction: null, format: "", indent: 0, type: "root", version: 1 }
  });
}

function nqlString(s) {
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

async function findExisting(env, title, publishedAt) {
  const filter = encodeURIComponent(`title:${nqlString(title)}`);
  const data = await ghostFetch(env, `/posts/?filter=${filter}&fields=id,url,published_at,status&limit=5`);
  const want = Date.parse(publishedAt);
  return (data.posts || []).find(p => p.published_at && Math.abs(Date.parse(p.published_at) - want) < 6e4) || null;
}

export async function createPost(env, { title, status, publishedAt, featureImage, images, tag }) {
  const existing = await findExisting(env, title, publishedAt);
  if (existing) {
    const { id, url, status: status2, published_at } = existing;
    return { id, url, status: status2, published_at, duplicate: true };
  }
  const body = {
    posts: [{
      title,
      status,
      published_at: publishedAt,
      feature_image: featureImage,
      tags: [{ name: tag }],
      lexical: buildLexical(images)
    }]
  };
  const data = await ghostFetch(env, "/posts/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const p = data.posts[0];
  return { id: p.id, url: p.url, status: p.status, published_at: p.published_at };
}
