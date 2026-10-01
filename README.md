# Scriptorium

A local-first notes app built to replace Obsidian notes. Open it and you're already in a new note: type like a tweet, press **Save**, and your 3 latest notes sit right below. Notes live on your phone first (works offline), then sync automatically to your server, Cloudflare, and GitHub. On GitHub they're plain Markdown, so Obsidian keeps working.

> Design: Apple-Notes "Paper" style, with a Twitter-style composer on the home screen. See [docs/DESIGN.md](docs/DESIGN.md) for the three options I workshopped and why I picked this one.

## What's in it (your list)

| You asked for | Status | Where / how |
|---|---|---|
| Open to a new note + snippets of the 3 most recent | ✅ | Home screen (count adjustable in Settings) |
| Record notes like Twitter: just a box | ✅ | Home composer. **Save** or ⌘/Ctrl+Enter |
| Notes make their own title, dated and timestamped | ✅ | Title = first line (or "Sketch · Oct 1", "Voice note · …"). Rename from **⋯** if you want |
| Bullets | ✅ | Toolbar, or type `- ` / `1. ` / `[] ` (checklist) |
| Justification | ✅ | Align button: left / center / right / justify |
| Bold, italic, underline, highlights | ✅ | Toolbar + ⌘B/I/U, ⌘⇧H highlight (5 colors) |
| Simple note linking, no brackets | ✅ | Type **@** and pick a note (or create one). Backlinks show at the bottom of each note |
| Folders for projects/collections | ✅ | Folder button on a note, sidebar, **Organize** page, optional emoji |
| Sketch | ✅ | Pen with pressure, highlighter, eraser, line/arrow/box/circle, grid/dots paper. Tap a sketch to edit it again |
| Text list of all notes | ✅ | **Notes** tab: grouped by date, sort by edited/created/title, filter chips |
| Tags: easy pop-up, easy to create and apply | ✅ | Tag button → type → Enter creates and applies. Colors in Organize |
| Synced: server, GitHub/Cloudflare bucket, phone | ✅ | Local IndexedDB + Worker (D1 + R2) or home server + GitHub. See setup below |
| AI to ask questions about notes, with open web | ✅ | **Ask** tab. Claude reads your most relevant notes, can search the web, links the notes it used, can save the answer as a note. Needs the Worker or server |
| SearXNG quick search and add in | ✅ | 🌐 button in a note: insert link, insert snippet, or save page as note |
| News feed of papers I like + similar papers, one-click save | ✅ | **News** tab: "For you" (new papers for your interests + papers similar to ones you saved, via OpenAlex), RSS feeds (journals, arXiv, Google News topics), paper search. **Save** → note with abstract and full text |
| Upload images | ✅ | Toolbar, paste, or drag & drop (auto-resized) |
| Download notes | ✅ | Per note: Markdown / web page / PDF / text. Everything: Obsidian-ready zip + backup (Settings) |
| Super-granular version history, proof of writing, paste detection, export as video | ✅ | **History** on any note: keystroke-level replay, typed vs pasted vs dictated %, every paste listed, restore any point, export **video**, **provenance report**, raw log with SHA-256 hash chain |
| Pinned notes | ✅ | Pin button, shown first on Home and in lists |
| Bookmarked notes | ✅ | Bookmark button + Bookmarks filter |
| Share notes with people | ✅ | Share → send a copy (iOS share sheet / email) or a **public read-only link** (via Worker/server), revocable |
| Always auto-synced everywhere | ✅ | Syncs a couple of seconds after each change, every minute, on app open and when the network returns. A cloud icon shows status |
| Audio notes + speech to text | ✅ | 🎙 button: live transcript while recording, then a cleaner Whisper transcript from your Worker (Workers AI) or home server |
| Math in notes | ✅ | Type `12*4 + 3 =` → answer appears. **Σ** button totals the selection, list or line (sum, average, min, max, difference, product, quotient) and inserts the result |
| Calendar of notes | ✅ | **Calendar** tab: heat-map month; tap a day to see notes written (or edited) that day |
| Search all notes on home | ✅ | Home search bar → instant results. Supports `"phrases"`, `#tag`, `folder:name`, `is:pinned` |
| Parse news articles into notes with images intact | ✅ | Paste a link in News (or tap a link in a note → "Save page as a note"). Uses Mozilla Readability, and images are downloaded into the note so they never break |

Extras: import from Obsidian (Markdown files, folders and zips, including `[[links]]`, `![[images]]`, tags and checklists), dark mode, works offline, installable on your phone's home screen, and on Android you can "share to Scriptorium" from other apps.

## Using it

### 1. Open the app (nothing to set up)

- **On GitHub Pages:** once this branch is merged to `main`, the *Deploy app to GitHub Pages* workflow publishes it to **https://shalone86.github.io/quickstart/**. One-time step: repo **Settings → Pages → Source: GitHub Actions**.
- **Android app (like Daily):** in the app, go to **Settings → Get the Android app** (or open `https://shalone86.github.io/quickstart/scriptorium.apk`) and install it. It opens full-screen, records voice notes, saves downloads to `Downloads/Scriptorium`, and adds **Share → Save to Scriptorium** to every app. Share an article from Google News or Chrome and it becomes a note, text and images included. You can also use Chrome's **Install app** instead.
- **iPhone:** open the link in Safari → Share → **Add to Home Screen**.
- Everything works locally right away: notes, sketches, voice notes with the live transcript, history, math, calendar, search, import/export, and paper search.

> ⚠️ This repo is **public**, and that's fine for the *app code*. Never point sync at this repo. Use a private repo for your notes (below).

### 2. GitHub sync (works without any server)

**Shortcut:** if you've set up Daily in this browser, the Home screen offers **Use Daily's settings**. One tap and notes sync to `shalone86/todo-data` in a `Notes/` folder next to `Todo/`, with the same token. (Inside the Android app, enter the settings once, since each app keeps its own storage.)

1. Pick the repo for your notes. I suggest your Obsidian vault repo **`shalone86/todo-data`** (private). Notes then show up in Obsidian under `Notes/`, next to your `Todo/` folder. A new private repo works too.
2. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate. Choose *Only select repositories* → that repo, then *Repository permissions → Contents: Read and write*.
3. In the app: **Settings → GitHub** → turn on, then enter repo `shalone86/todo-data`, folder `Notes`, branch `main`, and paste the token → **Test connection**.

What lands in the repo:
```
Notes/<Folder>/<Title>.md          ← Markdown with front matter (id, created, updated, tags, folder)
Notes/_attachments/<id>.png|webm   ← images, sketches, audio (embedded as ![[...]])
Notes/.scriptorium/db.json         ← the app's full data (Obsidian ignores dot-folders)
Notes/.scriptorium/history/*.json  ← keystroke history (your proof-of-writing log)
```
Every sync is one commit, so GitHub's history is also a timestamped backup.

### 3. Cloudflare Worker (AI, transcription, share links, feeds, R2 backups)

This one Worker serves the app *and* the API from a single address. You can do it from your computer:

```bash
git clone https://github.com/shalone86/quickstart && cd quickstart
npm install
npx wrangler login
npx wrangler deploy                        # creates the D1 database + R2 bucket automatically
npx wrangler secret put APP_TOKEN          # any long random string, e.g. from: openssl rand -hex 24
npx wrangler secret put ANTHROPIC_API_KEY  # for Ask AI (console.anthropic.com)
```

Then open the `https://scriptorium.<you>.workers.dev` address it prints, add it to your home screen, go to **Settings → Your server**, turn it on, and paste the APP_TOKEN. (Leave the server address empty when using the app from the Worker's own address. If you keep using the GitHub Pages copy, enter the workers.dev address.)

You get:
- **D1 database:** sync between all your devices.
- **R2 bucket:** images and audio, plus an automatic **nightly backup** (`backups/YYYY-MM-DD.json.gz`, 60 days kept).
- **Workers AI Whisper:** voice note transcription (free daily allowance).
- **Claude:** Ask AI with web search.
- **Share links** (`/s/...`), and fetching for articles, RSS feeds and SearXNG.

Prefer doing it from GitHub? Add the repo secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers" plus D1 and R2 edit permissions) and `CLOUDFLARE_ACCOUNT_ID`. The *Deploy Cloudflare Worker* workflow then deploys on every push to `main`. You still set the two secrets above once with `wrangler secret put` (or in the dashboard: Worker → Settings → Variables and Secrets).

### 4. Your own server (optional, same API)

```bash
cp server/.env.example server/.env   # set APP_TOKEN, optionally ANTHROPIC_API_KEY, SEARXNG_URL, WHISPER_URL
docker compose -f server/docker-compose.yml up -d
# or without Docker:  APP_TOKEN=... node server/server.js
```
It serves the app at `http://your-server:8787` and stores everything as files in `server/data/` (plus nightly gzip backups). For transcription, point `WHISPER_URL` at an OpenAI-compatible Whisper server (a commented example is in the compose file). Put it behind HTTPS (e.g. Caddy or Cloudflare Tunnel) to use it from your phone.

You can run **both** the home server and the Worker. The app syncs to each destination you turn on. Right now the Settings screen has one server slot plus GitHub, so the usual setup is Worker + GitHub, or home server + GitHub.

### 5. SearXNG

Settings → Web, news & reading → enter your SearXNG address. In SearXNG's `settings.yml`, make sure JSON is enabled:
```yaml
search:
  formats: [html, json]
```
With the Worker or server connected, searches go through it (no browser restrictions to worry about).

## Good to know

- **Conflicts:** if the same note is edited on two devices before they sync, the newest edit wins and the other version is saved in that note's **History** as a restore point. Nothing is lost.
- **Proof of writing:** each edit is stored with its time and type (typed, pasted, dropped, dictated, or inserted by the app). The report highlights pasted text in orange, and the video replays the writing with the same colors. Turn it off in Settings if you ever want to.
- **Privacy:** tokens stay on the device (they never sync). The AI only receives the notes that best match your question, plus a list of titles.
- **Papers** come from [OpenAlex](https://openalex.org) (free). If you hit its daily limit, add a free OpenAlex key in Settings.
- **Without a server,** saving articles uses the free [r.jina.ai](https://jina.ai/reader) reader (toggle in Settings), and most RSS feeds won't load (a browser restriction). The Worker fixes both.

## Project layout

```
app/        the app (plain HTML/CSS/JS modules, no build step), served by Pages, the Worker or the server
  js/       editor, store (IndexedDB), sync engines, history/provenance, views…
worker/     Cloudflare Worker (D1 + R2 + Workers AI + Claude)
server/     Node home server with the same API (+ Dockerfile)
android/    tiny full-screen Android wrapper (build: ANDROID_HOME=… android/build-apk.sh → app/scriptorium.apk)
tests/      unit tests (node --test) and end-to-end browser tests (Playwright)
docs/       design notes
```

Development: `npm test` (unit tests), `npm run test:e2e` (browser tests: starts the server, a mock GitHub and a test site), `npm run server`, `npx wrangler dev`.
