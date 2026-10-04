import { GhostError, uploadImageRaw, createPost } from "./ghost.js";

const COOKIE = "olph_session";
const SESSION_DAYS = 60;
const MAX_TITLE = 255;
const MAX_IMAGES = 200;
const MAX_UPLOAD = 50 * 1024 * 1024;
const enc = new TextEncoder();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, env, url);
      if (url.pathname === "/share") return Response.redirect(new URL("/?share=retry", url), 303);
      return env.ASSETS.fetch(req);
    } catch (err) {
      const status = err instanceof GhostError ? 502 : err.status || 500;
      const message = err instanceof GhostError ? `Ghost said: ${err.message}` : err.message || "Something went wrong";
      return json({ error: message }, status);
    }
  }
};

async function api(req, env, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === "POST /api/login") {
    const { passcode } = await req.json().catch(() => ({}));
    if (!env.PASSCODE || !await safeEqual(String(passcode || ""), env.PASSCODE)) {
      await new Promise(r => setTimeout(r, 800));
      return json({ error: "That passcode isn't right." }, 401);
    }
    const exp = Date.now() + SESSION_DAYS * 864e5;
    const token = `${exp}.${await hmac(env.SESSION_SECRET, String(exp))}`;
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`
    });
  }
  if (route === "POST /api/logout") {
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }
  if (!await signedIn(req, env)) return json({ error: "Please sign in again." }, 401);
  if (route === "GET /api/me") {
    return json({ ok: true, site: env.GHOST_URL, timezone: env.TIMEZONE || "America/New_York", tag: env.TAG || "Photos" });
  }
  if (req.method === "POST" && req.headers.get("X-OLPH") !== "1") return json({ error: "Bad request." }, 400);
  if (route === "POST /api/upload") {
    // Parsing a 10 MB photo out of the form used more CPU time than Cloudflare allows a Worker,
    // so Cloudflare cut the connection mid-upload. The phone now builds Ghost's form itself and
    // the Worker only adds the admin key and passes the bytes along.
    const type = req.headers.get("Content-Type") || "";
    if (!type.startsWith("multipart/form-data")) return json({ error: "No photo in the upload." }, 400);
    if (+req.headers.get("Content-Length") > MAX_UPLOAD) return json({ error: "That photo is over 50 MB." }, 413);
    try {
      return json({ url: await uploadImageRaw(env, await req.arrayBuffer(), type) });
    } catch (err) {
      // Ghost refusing the file itself (wrong type, too big) won't fix itself on retry.
      if (err instanceof GhostError && (err.status === 413 || err.status === 415 || err.status === 422)) {
        return json({ error: `Ghost said: ${err.message}` }, 415);
      }
      throw err;
    }
  }
  if (route === "POST /api/post") {
    const b = await req.json().catch(() => null);
    if (!b) return json({ error: "Bad request." }, 400);
    const title = String(b.title || "").trim().slice(0, MAX_TITLE);
    const images = Array.isArray(b.images) ? b.images.slice(0, MAX_IMAGES) : [];
    const site = env.GHOST_URL.replace(/\/$/, "");
    if (!title) return json({ error: "Add a title." }, 400);
    if (!images.length) return json({ error: "Add at least one photo." }, 400);
    for (const img of images) {
      if (typeof img.url !== "string" || !img.url.startsWith(site + "/content/images/")) return json({ error: "One of the photos didn't upload correctly. Try again." }, 400);
      img.width = Math.max(1, Math.round(+img.width || 0)) || 2e3;
      img.height = Math.max(1, Math.round(+img.height || 0)) || 1500;
    }
    const publishedAt = new Date(b.publishedAt);
    if (isNaN(publishedAt)) return json({ error: "The post date isn't valid." }, 400);
    const featureImage = images.some(i => i.url === b.featureImage) ? b.featureImage : images[0].url;
    const post = await createPost(env, {
      title,
      status: b.status === "draft" ? "draft" : "published",
      publishedAt: publishedAt.toISOString(),
      featureImage,
      images,
      tag: env.TAG || "Photos"
    });
    return json({ post });
  }
  return json({ error: "Not found." }, 404);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }
  });
}

async function hmac(secret, msg) {
  if (!secret) throw Object.assign(new Error("SESSION_SECRET isn't set."), { status: 500 });
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

async function signedIn(req, env) {
  const cookie = req.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || +exp < Date.now()) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, exp));
}
