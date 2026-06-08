# Deployment Guide — Render

This app is a Node.js (Express) server that serves both the API and the static
frontend. Render runs the Node process directly, so the whole app (UI + API)
deploys as a single web service.

> GitHub Pages will **not** work for this project — it only hosts static files
> and cannot run the Node backend. Use Render (or any Node host).

---

## 1. Prerequisites

- Code pushed to a GitHub repository.
- A [Render](https://render.com) account (free tier is fine).
- Valid API keys: Ocean.io, Prospeo, Brevo.

---

## 2. Required Environment Variables

Set these in the Render dashboard (**Service → Environment**). They are **not**
committed to the repo.

| Variable             | Required | Purpose                                                        |
| -------------------- | -------- | -------------------------------------------------------------- |
| `OCEAN_API_KEY`      | yes      | Ocean.io API token (Stage 1 — similar companies)               |
| `PROSPEO_API_KEY`    | yes      | Prospeo API key (Stage 2 — people + email enrichment)          |
| `BREVO_API_KEY`      | yes      | Brevo transactional email key (Stage 5)                        |
| `BREVO_SENDER_EMAIL` | for real sends | A Brevo-**verified** sender address                      |
| `BREVO_SENDER_NAME`  | optional | Display name for the sender (defaults to "Outreach Team")      |
| `DRY_RUN`            | yes      | `"true"` (default, safe) logs emails; `"false"` actually sends |
| `MAX_SIMILAR_COMPANIES` | optional | Default cap on similar companies (default `5`)             |
| `MAX_PEOPLE_PER_COMPANY` | optional | Default cap on people per company (default `10`)          |
| `PORT`               | auto     | Injected by Render — **do not set manually**                   |

> Keep `DRY_RUN=true` until you've verified everything. `/api/generate` and
> `/api/send` spend real API credits.

---

## 3. Deploy via render.yaml (Blueprint)

The repo includes a `render.yaml` blueprint.

1. Push the repo to GitHub.
2. In Render: **New → Blueprint**, connect the repo.
3. Render reads `render.yaml` and creates the `outreach-pipeline` web service:
   - **Build:** `npm install`
   - **Start:** `node src/server.js`
   - **Health check:** `/api/health`
4. Fill in the secret env vars (the ones marked `sync: false`).
5. **Create / Deploy.**

### Or deploy manually (no blueprint)

1. Render: **New → Web Service**, connect the repo.
2. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node src/server.js`
   - **Health Check Path:** `/api/health`
3. Add the environment variables from the table above.
4. **Create Web Service.**

---

## 4. GitHub Deployment Workflow

Render auto-deploys on every push to the connected branch.

```bash
# one-time
git init
git add .
git commit -m "Outreach pipeline"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

- Connect the repo in Render once (steps above).
- Every subsequent `git push origin main` triggers a new build + deploy.
- Watch progress in **Render → your service → Events / Logs**.

> Ensure `.env`, `node_modules`, `outputs/`, and `server.log` are git-ignored
> (see `.gitignore`). Never commit real API keys.

---

## 5. Verify the Deployment

Once Render shows **Live**, with `https://<your-app>.onrender.com`:

1. **Health check**
   ```bash
   curl https://<your-app>.onrender.com/api/health
   # -> {"ok":true,"dryRun":true}
   ```
2. **Frontend loads** — open the URL in a browser; the page and styles render,
   favicon shows.
3. **API wired** — enter a domain, click **Generate**. Network tab should show a
   `POST /api/generate` to the **same origin** (no `localhost`, no `:5501`).
4. **Logs** — Render log stream shows `Server running on port <PORT>`.

### Local verification (before deploying)

```bash
npm install
npm start                 # -> "Server running on port 3000"
# open http://localhost:3000  (served by Express, same-origin API)
curl http://localhost:3000/api/health
```

---

## 6. Troubleshooting

| Symptom | Cause / Fix |
| ------- | ----------- |
| **Generate fails with `Backend error 405`** | Page served by a static server (Live Server / GitHub Pages), not the Node app. Open the Render URL (or `http://localhost:3000`), not a static host. |
| **Calls go to `localhost` / `:5501` in production** | Stale `API_BASE`. It must resolve to `''` (same-origin) off-localhost. Hard-refresh; confirm `frontend/app.js` `API_BASE` logic. |
| **`Missing required environment variable(s)`** at boot | A required key (`OCEAN_API_KEY` / `PROSPEO_API_KEY` / `BREVO_API_KEY`) isn't set in Render env. |
| **`Invalid API token` / `Insufficient credits`** | Provider account issue (key not registered or out of credits), not a deploy bug. Update the key / top up. |
| **Build fails** | Ensure Node 20+ (`engines` or Render's default). Run `npm install` locally to confirm a clean lockfile. |
| **App sleeps / slow first request** | Render free tier spins down on idle; first request after idle is slow. Expected on free plan. |
| **Emails not sending** | `DRY_RUN` is `true` (default). Set `DRY_RUN=false` **and** `BREVO_SENDER_EMAIL` to send for real. |
| **Long request / timeout on Generate** | Prospeo rate limits (1/sec, 20/min) make large inputs slow. Keep `maxSimilar`/`maxPeople` small; inputs are capped at 25 server-side. |

---

## 7. Notes

- The server binds `process.env.PORT || 3000`; Render injects `PORT` — never
  hardcode it.
- Paid endpoints (`/api/generate`, `/api/send`) are rate-limited in-memory
  (10/hour/IP). This resets on restart and is per-instance — add real auth and a
  shared store before serious production use.
- `outputs/*.json` are written at runtime to ephemeral disk; on Render's free
  tier the filesystem is not persistent across deploys/restarts.
