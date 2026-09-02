# Deploy checklist

No CLI needed — both platforms deploy from the public GitHub repo.
Repo: https://github.com/3rif005-commits/second-brain-webmcp

**Order matters.** The API's CORS allow-list is the Vercel origin, and the
frontend's `FASTAPI_URL` is the Render origin — each needs the other's URL. So:
Render with a placeholder → Vercel → come back and fix Render.

---

## 1 · Render (do this first — it is the only unknown)

1. https://dashboard.render.com → **New → Blueprint**
2. Connect GitHub, pick `3rif005-commits/second-brain-webmcp`.
   It reads `render.yaml` and proposes one service, `second-brain-api`.
3. It will prompt for the five `sync: false` env vars. Copy from `backend/.env`
   in your local repo — the values are already correct there:

   | Render env var | Copy from `backend/.env` |
   |---|---|
   | `SUPABASE_URL` | `SUPABASE_URL` |
   | `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SERVICE_ROLE_KEY` |
   | `SUPABASE_JWT_SECRET` | `SUPABASE_JWT_SECRET` |
   | `DATABASE_URL` | `DATABASE_URL` (the pooler string, port 6543) |
   | `FRONTEND_URL` | put `https://placeholder.vercel.app` for now |

   `DATABASE_ROWS_ENABLED=true` and `PYTHON_VERSION=3.12` are already in the
   blueprint — don't retype them.
4. Deploy. **Watch the build log.** It installs the full `requirements.txt`,
   including pymupdf, yt-dlp and trafilatura, none of which `/db` needs —
   `main.py` imports every router, so they all have to install. Expect 5–10
   minutes.
5. Verify: `curl https://<your-service>.onrender.com/health`

   **If the build fails or times out**, that's the fallback case — tell me and
   I'll add a slim entrypoint that mounts only `notes` + `databases` and a
   trimmed requirements file. Don't burn time debugging it by hand.

## 2 · Vercel

1. https://vercel.com/new → import the same repo.
2. **Root Directory: `frontend`** ← the single most common way this fails.
   Framework preset should auto-detect Next.js.
3. Environment variables — copy from `frontend/.env.local`:

   | Vercel env var | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | from `frontend/.env.local` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from `frontend/.env.local` |
   | `DATABASE_ROWS_ENABLED` | `true` |
   | `FASTAPI_URL` | the Render URL from step 1 (no trailing slash) |
   | `GOOGLE_GENERATIVE_AI_API_KEY` | optional — only powers the inline editor AI |

4. Deploy, then note the production URL.

## 3 · Close the loop

Back in Render → the service → **Environment** → set `FRONTEND_URL` to the exact
Vercel origin (`https://….vercel.app`, no trailing slash, no path) → save, which
redeploys. Get this wrong and every `/db` call fails CORS in the browser while
working fine in curl — a confusing failure worth avoiding.

## 4 · Seed the demo account

Create the demo user in Supabase (Authentication → Users → Add user, and tick
"auto confirm"), then:

```bash
SUPABASE_URL=https://xxx.supabase.co \
SUPABASE_ANON_KEY=... \
DEMO_EMAIL=demo@... \
DEMO_PASSWORD=... \
API_URL=https://<render-service>.onrender.com \
python3 scripts/seed-demo.py
```

## 5 · Keep it awake for judging

Render's free tier sleeps after ~15 minutes idle and cold-starts in roughly 50
seconds. Submissions are judged *after* the deadline (winners announced Sept 23),
so judges will hit a cold instance unless something keeps it warm. Point a free
pinger (cron-job.org, UptimeRobot) at `https://<service>.onrender.com/health`
every 10 minutes. Two minutes of setup that protects the Execution score.

## 6 · Fill in the placeholders

`README.md` and `docs/submission/devpost-description.md` both have `_TODO_`
markers for the live URL, video URL and demo password.
