# The Reckoning Engine

The storefront for The Black Well: a gothic sphere you spin, chambers you enter,
limited drops you buy. Stripe takes the money. Yoycol prints and ships.

It is already built and tested. What is left is on the server: keys, your real
art, your real products. The numbered steps for that are in the build doc; the
prompts to paste into Claude Code are in `docs/PROMPTS.md`.

## What is in here

| Folder | What it is |
| --- | --- |
| `config/` | **The only files you edit to run drops.** Chambers, products, lore text, scene. Changes apply within 30 seconds, no restart. |
| `web/` | The site visitors see (TypeScript, one WebGL shader, no frameworks). About 14 KB of code. |
| `api/` | The server: stock, Stripe checkout, orders, souls, `/admin`, `/shop`. One SQLite file, no database to run. |
| `scripts/` | `make_ring.py` turns your orbit video into the frame ring. `deploy.sh` rebuilds and restarts. |
| `deploy/` | Copy-paste settings for Caddy, nginx or Traefik. |
| `n8n/` | Starter workflow for alerts, shipping emails and drop posts. |
| `docs/PROMPTS.md` | The prompts for Claude Code, in order. |

## First run on the server

    cp .env.example .env && nano .env      # fill in at least APP_SECRET, ADMIN_PASSWORD, PREVIEW_PASSWORD
    ./scripts/deploy.sh                    # builds and starts on 127.0.0.1:8787

Then point your reverse proxy at it (`deploy/README.md`).

## Running a drop

1. Add the products to `config/products.json` (price in cents, a `limit` per size).
2. Put their photos in `web/public/img/products/` and run `./scripts/deploy.sh`.
3. In `config/chambers.json` set the chamber to `"status": "live"` and, for a
   timed drop, `"goesLiveAt": "2026-12-05T20:00:00-05:00"`.

The Engine does the rest by itself: counts down, opens on time, holds stock for
30 minutes while someone pays, lights a lantern per order, seals the chamber
when the last piece sells, and tells n8n at each step.

Chamber status in the file is one of `live`, `dormant`, `locked`, `archived`.
"Countdown" and "sold out" are worked out automatically.

## The one asset the whole site needs

A loop of the sphere turning once (a video or numbered frames):

    python3 scripts/make_ring.py assets/source/orbit.mp4 --frames 72 --sphere 0.5,0.5,0.4

Then set each chamber's `"frame"` (which frame shows it front and centre). The
3D feel, flickering windows, glowing shaft, stars and sound are all generated in
the browser from that one ring. The frames shipped here are low-resolution
placeholders cut from the turntable contact sheet.

## Checking it

    cd api && npm test          # 15 tests: stock holds, payments, sell-outs, sigils, admin
    cd web && npm run build     # type-checks and builds the site
    cd web && npm run build:demo   # a no-server demo build in web/dist-demo

## Fulfillment modes (`FULFILLMENT_MODE` in `.env`)

- `manual` (default): each paid order appears in `/admin` with a copy-ready
  block. Place it in Yoycol, then record the Yoycol order number and tracking.
- `dryrun`: logs exactly what would be sent to Yoycol, sends nothing.
- `yoycol`: sends through `api/src/yoycol.js`. **That adapter is not wired yet**
  because Yoycol's API reference could not be read when this was built. See the
  Yoycol prompt in `docs/PROMPTS.md`.

## Not yet verified

- The Docker image has not been built (no Docker daemon where this was written).
  The app itself was run and browser-tested directly with Node 22.
- Stripe was tested against a stand-in, not the real Stripe. Do the test-card
  run in the build doc before going live.
- `n8n/engine-events.json` is a starter and has not been imported into a real n8n.
