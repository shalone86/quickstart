import { fileTaken, toInstant } from "/taken.js";

const $ = s => document.querySelector(s);
const UPLOADS_AT_ONCE = 2;
const RETRIES = 2;

let zone = "America/New_York";
let photos = [];          // { id, file, url, when, source, weak, width, height, remoteUrl, el }
let featuredId = null;
let mode = "random";      // "random" | "pick"
let status = "published"; // "published" | "draft"
let dateOverride = null;  // Date chosen by hand, or null to use the earliest photo
let busy = false;
let nextId = 1;

// ---------- startup ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

boot();
async function boot() {
  const me = await fetch("/api/me").then(r => r.ok ? r.json() : null).catch(() => null);
  if (!me) return showLogin();
  zone = me.timezone || zone;
  showCompose();
  const params = new URLSearchParams(location.search);
  if (params.has("shared")) {
    history.replaceState(null, "", "/");
    await loadShared();
  } else if (params.get("share") === "retry") {
    history.replaceState(null, "", "/");
    showErr("The app was still getting ready. Share the photos to it once more, or tap Choose photos.");
  }
}

function show(id) {
  for (const s of ["#login", "#compose", "#done"]) $(s).hidden = s !== id;
  $("#signout").hidden = id === "#login";
}

// ---------- sign in ----------
function showLogin() {
  show("#login");
  $("#passcode").focus();
}
$("#login").addEventListener("submit", async e => {
  e.preventDefault();
  $("#loginErr").hidden = true;
  const r = await fetch("/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: $("#passcode").value })
  }).catch(() => null);
  if (r && r.ok) { $("#passcode").value = ""; boot(); return; }
  $("#loginErr").textContent = r ? (await r.json().catch(() => ({}))).error || "Sign-in failed." : "No connection. Try again.";
  $("#loginErr").hidden = false;
});
$("#signout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ---------- compose ----------
function showCompose() {
  show("#compose");
  try { $("#title").value = localStorage.getItem("olph-title") || ""; } catch {}
  render();
}
$("#title").addEventListener("input", () => {
  try { localStorage.setItem("olph-title", $("#title").value); } catch {}
  render();
});
$("#files").addEventListener("change", async e => {
  await addFiles([...e.target.files]);
  e.target.value = "";
});

async function loadShared() {
  try {
    const cache = await caches.open("olph-share");
    const files = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      const blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(res.headers.get("X-Name") || "photo.jpg"), {
        type: blob.type, lastModified: +res.headers.get("X-Modified") || Date.now()
      }));
      await cache.delete(req);
    }
    await addFiles(files);
  } catch {
    showErr("Couldn't open the shared photos. Tap Choose photos instead.");
  }
}

async function addFiles(files) {
  hideErr();
  const images = files.filter(f => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
  if (images.length < files.length) showErr(`${files.length - images.length} file(s) weren't photos and were skipped.`);
  const known = new Set(photos.map(p => p.file.name + p.file.size));
  for (const file of images) {
    if (known.has(file.name + file.size)) continue;
    const t = await fileTaken(file, zone);
    const thumb = await makeThumb(file);
    photos.push({ id: nextId++, file, url: thumb.url, ...t, width: thumb.width, height: thumb.height });
  }
  photos.sort((a, b) => (a.weak ? 1 : 0) - (b.weak ? 1 : 0) || a.when - b.when); // undated photos go last
  if (mode === "random" || !photos.some(p => p.id === featuredId)) pickRandom();
  render();
}

// Earliest photo with a real date; undated photos only count if nothing else has a date.
function earliest() {
  const dated = photos.filter(p => !p.weak);
  return (dated.length ? dated : photos)[0];
}

// Small preview + the photo's real shape. Decoding one photo at a time and keeping only a
// 400px copy stops the phone from holding a dozen 12-megapixel photos in memory at once.
async function makeThumb(file) {
  try {
    const bmp = await createImageBitmap(file); // applies the camera's rotation
    const { width, height } = bmp;
    const scale = Math.min(1, 400 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.8));
    return { url: URL.createObjectURL(blob), width, height };
  } catch {
    return { url: URL.createObjectURL(file), width: 0, height: 0 }; // e.g. a format the browser can't decode
  }
}

function pickRandom() {
  featuredId = photos.length ? photos[Math.floor(Math.random() * photos.length)].id : null;
}

function render() {
  const n = photos.length;
  $("#count").textContent = n ? `${n} selected` : "";
  $("#pickBig").hidden = n > 0;
  for (const id of ["#grid", "#gridHint", "#featFld", "#dateFld", "#statusFld"]) $(id).hidden = !n;

  const grid = $("#grid");
  grid.replaceChildren(...photos.map(p => {
    if (!p.el) {
      p.el = document.createElement("div");
      p.el.className = "ph";
      p.el.setAttribute("role", "button");
      p.el.tabIndex = 0;
      p.el.innerHTML = `<img alt=""><span class="t"></span><button class="rm" type="button" aria-label="Remove photo">×</button><span class="bar" style="width:0"></span>`;
      const img = p.el.querySelector("img");
      img.decoding = "async";
      img.src = p.url;
      p.el.addEventListener("click", e => {
        if (busy) return;
        if (e.target.closest(".rm")) return removePhoto(p);
        featuredId = p.id; mode = "pick"; render();
      });
      p.el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.el.click(); } });
    }
    const feat = p.id === featuredId;
    p.el.classList.toggle("feat", feat);
    p.el.setAttribute("aria-label", `${p.weak ? "Photo with no date" : "Photo taken " + fmtTime(p.when)}${feat ? ", featured" : ""}`);
    p.el.querySelector(".t").textContent = p.weak ? "no date" : fmtTime(p.when);
    let star = p.el.querySelector(".star");
    if (feat && !star) { star = document.createElement("span"); star.className = "star"; star.textContent = "★"; p.el.appendChild(star); }
    if (!feat && star) star.remove();
    return p.el;
  }));
  if (n) {
    const more = document.createElement("label");
    more.className = "more ph";
    more.setAttribute("aria-label", "Add more photos");
    more.style.display = "grid"; more.style.placeItems = "center";
    more.innerHTML = `+<input type="file" accept="image/*" multiple hidden>`;
    more.querySelector("input").addEventListener("change", async e => { await addFiles([...e.target.files]); });
    grid.appendChild(more);
  }

  $("#modeRandom").setAttribute("aria-pressed", mode === "random");
  $("#modePick").setAttribute("aria-pressed", mode === "pick");
  $("#featNote").textContent = mode === "random"
    ? "A random photo was picked (★). Tap Random again for a different one."
    : "Tap any photo to make it the featured image (★).";

  if (n) {
    const first = earliest();
    const when = dateOverride || first.when;
    $("#dateText").textContent = `${fmtDay(when)} · ${fmtTime(when)}`;
    const weak = photos.filter(p => p.weak).length;
    $("#dateSrc").textContent = dateOverride
      ? "Set by you"
      : `When the first photo was taken (from its ${first.source})` +
        (weak ? `. ${weak} photo(s) had no date, so check this.` : "");
  }

  $("#stPublish").setAttribute("aria-pressed", status === "published");
  $("#stDraft").setAttribute("aria-pressed", status === "draft");
  $("#publish").textContent = status === "draft" ? "Save draft" : "Publish";
  $("#publish").disabled = busy || !n || !$("#title").value.trim();
}

function removePhoto(p) {
  URL.revokeObjectURL(p.url);
  photos = photos.filter(x => x !== p);
  if (featuredId === p.id) pickRandom();
  render();
}

$("#modeRandom").addEventListener("click", () => { if (busy) return; mode = "random"; pickRandom(); render(); });
$("#modePick").addEventListener("click", () => { if (busy) return; mode = "pick"; render(); });
$("#stPublish").addEventListener("click", () => { if (busy) return; status = "published"; render(); });
$("#stDraft").addEventListener("click", () => { if (busy) return; status = "draft"; render(); });

$("#dateEdit").addEventListener("click", () => {
  const input = $("#dateInput");
  if (input.hidden) {
    input.value = zoneLocal(dateOverride || earliest().when).slice(0, 16);
    input.hidden = false;
    $("#dateEdit").textContent = "Use photo date";
    input.focus();
  } else {
    input.hidden = true; dateOverride = null;
    $("#dateEdit").textContent = "Change";
    render();
  }
});
$("#dateInput").addEventListener("change", e => {
  if (!e.target.value) return;
  dateOverride = toInstant(e.target.value.length === 16 ? e.target.value + ":00" : e.target.value, null, zone);
  render();
});

// ---------- publish ----------
$("#publish").addEventListener("click", publish);

async function publish() {
  const title = $("#title").value.trim();
  if (!title || !photos.length || busy) return;
  busy = true; hideErr(); render();
  $("#prog").hidden = false;
  const lock = await navigator.wakeLock?.request("screen").catch(() => null);
  window.addEventListener("beforeunload", warnLeave);

  try {
    await Promise.all(photos.map(ensureSize));
    await uploadAll();
    setProgress(photos.length, photos.length, "Creating the post…");
    const featured = photos.find(p => p.id === featuredId) || photos[0];
    const res = await api("/api/post", {
      title,
      status,
      publishedAt: (dateOverride || earliest().when).toISOString(),
      featureImage: featured.remoteUrl,
      images: photos.map(p => ({ url: p.remoteUrl, width: p.width, height: p.height }))
    });
    showDone(res.post, title, featured);
  } catch (err) {
    showErr(err.message + " Photos that already uploaded won't upload again. Tap the button to retry.");
  } finally {
    busy = false;
    $("#prog").hidden = true;
    window.removeEventListener("beforeunload", warnLeave);
    lock?.release?.().catch(() => {});
    render();
  }
}

// The gallery layout needs each photo's shape (upright photos respect the camera's rotation).
function ensureSize(p) {
  if (p.width && p.height) return;
  return new Promise(resolve => {
    const img = new Image();
    const src = URL.createObjectURL(p.file);
    img.onload = () => { p.width = img.naturalWidth; p.height = img.naturalHeight; URL.revokeObjectURL(src); resolve(); };
    img.onerror = () => { URL.revokeObjectURL(src); resolve(); };
    img.src = src;
  });
}

function warnLeave(e) { e.preventDefault(); e.returnValue = ""; }

async function uploadAll() {
  const queue = photos.filter(p => !p.remoteUrl);
  let finished = photos.length - queue.length;
  setProgress(finished, photos.length);
  let failure = null;
  async function worker() {
    while (queue.length && !failure) {
      const p = queue.shift();
      p.el?.classList.remove("fail");
      for (let attempt = 0; ; attempt++) {
        try {
          p.remoteUrl = await uploadOne(p);
          p.el?.classList.add("done");
          break;
        } catch (err) {
          if (attempt >= RETRIES || err.fatal) { p.el?.classList.add("fail"); failure = err; return; }
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      finished++;
      setProgress(finished, photos.length);
    }
  }
  await Promise.all(Array.from({ length: UPLOADS_AT_ONCE }, worker));
  if (failure) throw failure;
}

function uploadOne(p) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const bar = p.el?.querySelector(".bar");
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("X-OLPH", "1");
    xhr.upload.onprogress = e => { if (bar && e.lengthComputable) bar.style.width = (e.loaded / e.total * 100) + "%"; };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && data.url) return resolve(data.url);
      const err = new Error(data.error || `Upload failed (${xhr.status}).`);
      err.fatal = xhr.status === 401 || xhr.status === 415;
      if (xhr.status === 401) setTimeout(showLogin, 1500);
      reject(err);
    };
    xhr.onerror = () => reject(new Error("The connection dropped during upload."));
    // Built exactly the way Ghost wants it; the server just passes it along.
    const name = safeName(p.file.name);
    const form = new FormData();
    form.append("file", p.file, name);
    form.append("purpose", "image");
    form.append("ref", name);
    xhr.send(form);
  });
}

function safeName(name) {
  const clean = String(name || "photo.jpg").replace(/[^\w.\-]+/g, "_").replace(/^_+/, "");
  return clean.slice(-120) || "photo.jpg";
}

async function api(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OLPH": "1" },
    body: JSON.stringify(body)
  }).catch(() => { throw new Error("No connection."); });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) setTimeout(showLogin, 1500);
    throw new Error(data.error || `Something went wrong (${r.status}).`);
  }
  return data;
}

function setProgress(done, total, text) {
  $("#progText").textContent = text || `Uploading photo ${Math.min(done + 1, total)} of ${total}…`;
  $("#progBar").style.width = (total ? done / total * 100 : 0) + "%";
}

function showDone(post, title, featured) {
  show("#done");
  $("#doneTitle").textContent = post.duplicate ? "Already posted" : post.status === "draft" ? "Draft saved" : "Posted";
  $("#doneImg").src = featured.url;
  $("#doneNote").textContent = post.duplicate
    ? `“${title}” was already on the site, so a second copy wasn't made.`
    : `“${title}” · dated ${fmtDay(new Date(post.published_at || Date.now()))}`;
  $("#doneLink").href = post.status === "draft"
    ? new URL(`/ghost/#/editor/post/${post.id}`, new URL(post.url).origin).href
    : post.url;
  $("#doneLink").textContent = post.status === "draft" ? "Open the draft in Ghost" : "View the post";
  try { localStorage.removeItem("olph-title"); } catch {}
}

$("#again").addEventListener("click", () => {
  photos.forEach(p => URL.revokeObjectURL(p.url));
  photos = []; featuredId = null; mode = "random"; dateOverride = null; status = "published";
  $("#title").value = ""; $("#dateInput").hidden = true; $("#dateEdit").textContent = "Change";
  showCompose();
});

// ---------- messages & formatting ----------
function showErr(msg) { $("#err").textContent = msg; $("#err").hidden = false; }
function hideErr() { $("#err").hidden = true; }
function fmtDay(d) { return d.toLocaleDateString("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric", year: "numeric" }); }
function fmtTime(d) { return d.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }); }
function zoneLocal(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
