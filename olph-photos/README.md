# OLPH Post Photos (photos.shalonely.com)

Cloudflare Worker `olph-photos` + static page. Phone picks photos, Worker uploads them to Ghost
(olphvb.org) with the admin key and creates a "Photos" post dated to the earliest photo.

Recovered from the live deployment on 2026-10-04 (no original repo existed).

## Fix: "The connection dropped during upload"
The Worker parsed each 8–10 MB photo out of the form (`req.formData()`) and re-encoded it for
Ghost. On the Workers Free plan (10 ms CPU per request) Cloudflare tolerates the occasional
overrun, then starts killing the Worker every time, which the phone sees as a dropped connection.
Now the phone builds Ghost's form (`file`, `purpose`, `ref`) and the Worker forwards the raw bytes.

## Deploy
Secrets/vars stay in the Cloudflare dashboard (GHOST_URL, GHOST_ADMIN_KEY, PASSCODE,
SESSION_SECRET, optional TIMEZONE/TAG); `keep_vars` keeps them.

    npx wrangler@4 deploy        # needs CLOUDFLARE_API_TOKEN with Workers Scripts: Edit
