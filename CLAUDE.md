# The Reckoning Engine

Interactive storefront for Buildblackwell (gothic apparel, limited drops). Replaces buildblackwell.com.
The owner (Jimmy) is not a developer. After each task, say in 2-3 plain sentences what
changed and exactly what he should check on his phone.

## Shape of the project

- `web/`: Vite + TypeScript, zero runtime dependencies. One WebGL fragment shader (`src/gl.ts`)
  renders the ring frame with analytic sphere parallax, light flicker, shaft glow, stars.
  `src/main.ts` = boot, loop, drag/snap physics. `src/ui.ts` = HUD, vault, cart. `src/fx.ts` = souls,
  presence, sigils, sparks. `src/demo.ts` is only in the demo build (`VITE_DEMO=1`).
- `api/`: Node 22 ESM JavaScript (no build step), Fastify 5, better-sqlite3, Stripe Checkout.
  `src/app.js` routes, `src/commerce.js` money path, `src/db.js` stock/orders, `src/logic.js` pure rules,
  `src/fulfillment.js` + `src/yoycol.js` (adapter stub), `src/pages.js` (/shop, /thanks, /admin).
  The API also serves `web/dist`. One container, one port (8787).
- `config/*.json`: single source of truth for chambers, products, lore, scene. Hot-reloaded.
  A bad edit is ignored and logged; the last good config keeps serving.

## Rules

- Never hardcode drop data, product data or lore. It lives in `config/`.
- Prices and stock are decided on the server. Never trust the browser.
- Secrets live only in `.env`. Never print a full secret, never commit one, never ask Jimmy to paste one into chat.
- Stripe stays in test mode until Jimmy says "go live".
- Never stop, restart or reconfigure n8n, Postiz or any other container on this VPS.
  Show any reverse-proxy change before applying it.
- Run `cd api && npm test` and `cd web && npm run build` before every commit. Add a test for any change to the money path.
- Phone first: check at 390x844. Keep first paint under 3 MB. Respect `prefers-reduced-motion`.
- Checkout stays two taps from a product: Add to cart, then Checkout.
- Do not add frameworks or heavy libraries to `web/`. The bundle is ~14 KB gzipped; keep it small.
- Do not name anything "Death Star" or imitate that design. The machine is The Reckoning Engine.
- Commit after each working step with a clear message.

## Brand voice (any text you write for the site)

- Masthead is always THE BLACK WELL.
- Lore lines are third-person universal laws: cold, detached, the Well as an entity with rules.
- Never first person, never emotional or wounded, never hustle-motivational.
- Examples: SOFT DIES FIRST. WARMTH IS HOW THEY GET IN. THE WELL COLLECTS ALL DEBTS.
- Error and status messages stay in voice but must be clear about what happened and whether money moved.

## Commands

    cd api && npm test                 # server tests
    cd api && npm run dev              # API on :8787 (reads ../config, writes ../data)
    cd web && npm run dev              # site on :5173, proxies /api to :8787
    cd web && npm run build            # type-check + production build
    ./scripts/deploy.sh                # docker build + restart + health check
    python3 scripts/make_ring.py -h    # frame ring / chamber plates from source art
