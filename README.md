# SakAI

AI commute planner for Philippine jeepneys and tricycles: which jeep to take, where to board, where to say "Para po!", and how much it costs. Expo (React Native) app that also ships as a website.

## Features (MVP)

- **Map** – OpenStreetMap via MapLibre (native) / maplibre-gl (web), OpenFreeMap tiles, no API key.
- **Routes** – jeep, modern jeep and tricycle lines for a Metro Manila corridor (`src/data/routes.ncr.json`), browsable and searchable.
- **Trip planner** – direct and one-transfer trips; boarding/alighting points are snapped onto route lines since jeeps stop anywhere (`src/lib/planner.ts`).
- **Fares** – LTFRB jeep matrix + per-LGU tricycle table with 20% student/senior/PWD discount (`src/data/fares.json`).
- **Traffic** – deterministic dummy data by time of day, affects ETAs; "Traffic at" chips simulate rush hour (`src/lib/traffic.ts`).
- **Community routes** – commuters draw and submit routes (Routes → "+ Add route"). They show as *unverified* until 3 other devices confirm them ("Nasakyan ko 'to ✓"), and the planner ranks them slightly below official routes. Stored by the API in `server/`.

> Route lines are hand-traced approximations and tricycle fares are placeholders — replace with OSM route relations and LGU ordinances before release.

## AI in SakAI

SakAI's trip ranking, time estimates and requests all run through AI that works on the routes added by hand (the bundled `routes.ncr.json` plus commuter-added community routes). The planner still finds candidate trips over those routes; the AI decides which is best for *you*. Code is in `src/lib/ai/`.

| What | How | Where |
| --- | --- | --- |
| **Preference learning** | Each trip you pick ("I'm taking this trip") trains an online logistic model (pairwise, Bradley–Terry) over time, fare, transfers, walking, unconfirmed routes and heavy traffic. Trips are re-ranked by your learned weights. | `preferences.ts`, `ranker.ts` |
| **Travel-time learning** | Tell SakAI how long a trip really took. It keeps, per route and time-of-day slot, the mean and spread of log(actual ÷ predicted), shrunk toward the schedule model until enough reports back it. Estimates become ranges ("likely 24–31 min") with a confidence note. | `eta-model.ts` |
| **Ask SakAI** | Type a trip in English, Filipino or Taglish ("galing Cubao papuntang Quiapo, pinakamura, estudyante, makarating bago 9am"). Understood on-device by default, or by Claude when the API has a key and you're logged in. Place names come from landmarks *and every loading point on every route*, so hand-added routes widen what it understands. | `intent.ts`, `assistant.ts`, `llm.ts` |
| **Why this trip** | Structured reasons (faster/cheaper than the next option, heavy traffic, learned slowdowns, unconfirmed route) worded per language, with an optional Claude-written explanation. | `explain.ts` |
| **When to leave** | Compares your best trip now vs later, and with an "arrive by" time finds the latest departure that still makes it using the slow end of the time range. | `departure.ts` |

Everything has an on-device path, so the app works offline and without a key; the language model only adds better reading of messy requests and friendlier explanations. Learned data stays on the device (chunked secure storage, keys `sakai.ai.*`); "Reset what SakAI learned" clears it.

Traffic is still the demo feed in `src/lib/traffic.ts`: the learned corrections are how SakAI adapts to what commuters actually experience on the routes.

## Develop

Requires Node 22.13+ (`nvm use` reads `.nvmrc`).

```bash
npm install
npm run web          # browser
npx expo run:android # native; MapLibre needs a dev build, not Expo Go
npm test             # planner, fare, traffic and AI unit tests
npm run typecheck && npm run lint
```

## Deploy (web → Vercel)

`vercel.json` builds with `expo export -p web` and serves `dist/` as a single-page app.

```bash
npx vercel        # preview
npx vercel --prod # production
```

Or import the Git repo in the Vercel dashboard — no extra settings needed. Set Node.js to 22+ in Project Settings if the build complains.

Mobile apps ship through EAS (`npx eas-cli@latest build`), not Vercel.

## Community routes API (`server/` → Fly.io)

Node 24 + Hono + Turso (libSQL). Username + password accounts: passwords are hashed with scrypt, and logins get a 30-day opaque session token (only its SHA-256 is stored) sent as `Authorization: Bearer <token>`. Anyone can read routes; adding and confirming need a login. Limits: 10 submissions/hour per user, 20 login attempts/hour per username, 30 sign-ups/hour per IP.

| Method | Path | Auth | |
| --- | --- | --- | --- |
| POST | `/auth/signup` | | `{username, password}` → `{token, user}`. Username 3–20 of `a-z 0-9 _ .` (case-insensitive), password ≥8 chars |
| POST | `/auth/login` | | `{username, password}` → `{token, user}` |
| POST | `/auth/logout` | ✓ | Revokes the session |
| GET | `/auth/me` | ✓ | Current user |
| GET | `/routes` | | All community routes as GeoJSON features (`status`, `confirmations`, `reports`, `author`) |
| POST | `/routes` | ✓ | Submit a route (validated: inside PH, ≥2 points, ≤5 km between points) |
| POST | `/routes/:id/confirm` | ✓ | Confirm a route (not your own; once per user) |
| POST | `/routes/:id/report` | ✓ | `{reason: "wrong_path" \| "not_running" \| "spam"}`; replaces your confirmation if any |
| POST | `/routes/:id/fares` | ✓ | Propose a fare: `{kind: "flat", amount}` or `{kind: "distance", base, baseKm, perKm}` |
| POST | `/routes/:id/fares/:fareId/confirm` | ✓ | Back a proposed fare (once per user) |
| POST | `/ai/intent` | ✓ | `{text, lang, places:[{id,name}]}` → `{intent}`: Claude reads a free-text request; ids are validated against `places`. 503 without `ANTHROPIC_API_KEY`; 60 requests/hour per user |
| POST | `/ai/explain` | ✓ | `{lang, priority, leaning, selected, trips}` → `{text}`: a short explanation of the selected trip |

Each user has one vote per route: a confirmation or a report; voting again refreshes its date. `status`, first match wins:

- `unavailable`: ≥2 "not running" reports since the latest confirmation, however many older confirmations there are. Anyone confirming again brings it back.
- `disputed`: reports − confirmations ≥ 2.
- `verified`: ≥3 confirmations; otherwise `unverified`.

The app stops suggesting `unavailable` and `disputed` routes in trips.

Fares: a route's `fare` is its newest proposal backed by ≥2 users (the proposer counts); a newer proposal still short of that is `pendingFare`. Without a `fare`, the app uses the standard fare table (`src/data/fares.json`).

There's no password reset yet; forgotten passwords mean a new account.

```bash
cd server && npm install
npm run dev        # http://localhost:8080, in-memory store unless TURSO_DATABASE_URL is set
npm test           # API tests (in-memory + in-memory SQLite via libSQL)
```

Optional language model: set `ANTHROPIC_API_KEY` (and `ANTHROPIC_MODEL`, default `claude-haiku-5-5`) to enable `/ai/*`. Without it those endpoints answer 503 and the app uses its on-device AI.

For a persistent local database: `TURSO_DATABASE_URL=file:local.db npm run dev`.

Point the app at it with `EXPO_PUBLIC_API_URL=http://localhost:8080 npm run web`. Without that variable the app runs on bundled routes only and hides "Add route".

### Deploy to Fly.io

```bash
cd server
turso db create ruta --location aws-ap-northeast-1   # Tokyo; fly.toml uses nrt to match
fly launch --no-deploy --copy-config              # app name is in fly.toml
fly secrets set TURSO_DATABASE_URL="$(turso db show ruta --url)" \
  ANTHROPIC_API_KEY=sk-ant-... \
  TURSO_AUTH_TOKEN="$(turso db tokens create ruta)" \
  CORS_ORIGIN=https://<your-app>.vercel.app
fly deploy
```

Tables are created on boot. Then set `EXPO_PUBLIC_API_URL=https://<app>.fly.dev` in Vercel (Project → Settings → Environment Variables) and redeploy the web app.

## Road snapping (`routing/` → Fly.io)

Add route draws lines along real streets: the app sends the tapped points to `GET /directions` on the API (login required, 600 requests/hour per user), which forwards them to a private [OSRM](https://project-osrm.org/) service with a driving profile (jeeps, tricycles) and a walking profile (walk links). OSRM also returns the street name at each tap, which pre-fills Mula/Hanggang.

`routing/` builds OSRM data for Metro Manila and its edges (bbox 120.90,14.30 → 121.20,14.85) from Geofabrik's Philippines extract at image build time. It has no public ports; the API reaches it over Fly's private network:

```bash
fly deploy routing --remote-only              # app ruta-osrm-jem; ~1 GB machine
fly secrets set -a ruta-api-jem \
  OSRM_DRIVING_URL=http://ruta-osrm-jem.internal:5000 \
  OSRM_WALKING_URL=http://ruta-osrm-jem.internal:5001
```

Redeploy `routing/` (with `--build-arg OSM_DATE=$(date +%F)`) to pick up newer map data. Without the `OSRM_*` secrets, `/directions` answers 503 and the app draws straight lines.

## Updating route data

Bump `version` in `routes.ncr.json`. To push updates without an app release, host a JSON of the same shape and set `EXPO_PUBLIC_ROUTES_URL`; the app uses it when its `version` is higher than the bundled one.
