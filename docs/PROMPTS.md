# Prompts for Claude Code

Paste these into Claude Code on the VPS, one at a time, from inside `~/reckoning-engine`.
After each one, check what it tells you to check, then say `commit this`.

## 1. Bring it up on this server

```text
Read CLAUDE.md and README.md. This project is already built. Your job is to get it running here.
1. Look around first: list running Docker containers and what handles ports 80/443 (Traefik, Caddy or nginx), and how n8n is routed. Do not change n8n or Postiz.
2. Run: cd api && npm ci && npm test. Then cd ../web && npm ci && npm run build. Fix nothing unless a test fails; if one does, show me.
3. I have filled in .env. Check it has APP_SECRET, ADMIN_PASSWORD and PREVIEW_PASSWORD set (do not print their values).
4. Run ./scripts/deploy.sh. If the Docker build fails, fix the Dockerfile and tell me what was wrong.
5. Using deploy/README.md, route https://engine.buildblackwell.com to the engine the same way n8n is routed. Show me the proxy change before applying it.
6. Tell me the URL to open on my phone and what I should see.
```

You should see: the site asks for a password, then shows the sphere. `/admin` asks for your admin login.

## 2. Connect GitHub

```text
Help me log in with gh auth login (I will do the browser part). Then push this project to my private repo YOUR_GITHUB_USERNAME/reckoning-engine. Confirm .env and data/ are not in the repo.
```

## 3. Swap in the real sphere

Put your orbit video (or folder of frames) in `assets/source/` first.

```text
My sphere orbit is at assets/source/[FILE]. Set up a Python venv with Pillow and numpy, then:
1. Extract one frame and show me where the sphere is: estimate its centre x, centre y and radius as fractions of the frame (radius as a fraction of frame height).
2. Run scripts/make_ring.py with those --sphere values, 72 frames, sizes 640,1024,1600.
3. Make a contact sheet image of every 6th output frame with its frame number so I can pick which frame shows each chamber best. Save it where I can open it.
4. After I tell you the frame number for each chamber, update "frame" (and "lon"/"lat" if the hotspot should sit off-centre) in config/chambers.json and move the three sigils in config/scene.json to dark, hard-to-spot places.
5. Run ./scripts/deploy.sh and tell me the first-load size on a phone.
```

Optional, for a razor-sharp resting view: upscale the exact ring frame for a chamber, then

```text
Make a plate for chamber iv from assets/source/iv_upscaled.png with scripts/make_ring.py --plate iv (same --sphere values as that source), add the "plate" line to chambers.json, and deploy.
```

## 4. Enter the real products

```text
Help me replace the placeholder products in config/products.json. Ask me one product at a time: name, chamber, price, a rough description (tighten it in the brand voice and show me), sizes, how many of each size this drop has, and the Yoycol SKU for each size if I have it. I will give you photos; save them to web/public/img/products/ as 1200px WebP. Keep ids short and lowercase. When we are done, validate the config with npm test and deploy.
```

## 5. Stripe test mode

Do the Stripe steps in the build doc first (test key and webhook secret into `.env`).

```text
I added my Stripe TEST key and webhook secret to .env. Restart the engine with ./scripts/deploy.sh and confirm the startup log says "test payments". Then watch the logs while I buy a shirt with card 4242 4242 4242 4242, and tell me whether the webhook arrived, the order is "paid" and a soul was created.
```

## 6. Yoycol adapter (only if Yoycol gave you API access)

```text
Finish api/src/yoycol.js. First read Yoycol's API reference at https://www.yoycol.com/api/2025/redoc: it is a ReDoc page, so fetch the HTML, find the OpenAPI spec it loads, and read that. Do not create any order yet. Tell me in plain words how auth works, what an order needs, whether orders must be paid or approved in a second step, how tracking is read, and whether there is a sandbox.
Then implement createOrder and getOrder exactly to the contract in the comment at the top of yoycol.js, set ready: true, pass yoycolReady through to the admin page, and add tests with a mocked fetch (success, retry safety on the same reference, error). Keep FULFILLMENT_MODE=dryrun until I say otherwise.
```

## 7. n8n: alerts, shipping emails, drop posts

Put `N8N_URL`, `N8N_API_KEY`, `POSTIZ_URL` and `POSTIZ_API_KEY` in `.env` first.

```text
Using the n8n API, import n8n/engine-events.json into my n8n as a starting point (fix it if this n8n version rejects any node), then wire the branches:
- order.paid and order.attention -> alert me by [Telegram / email]. For order.paid include the soul number, items and ship-to block.
- order.shipped -> email the customer their tracking number. Subject: YOUR PIECE HAS LEFT THE WELL.
- chamber.opened -> Postiz post: CHAMBER [numeral] IS OPEN.
- chamber.sealed -> Postiz post: CHAMBER [numeral] IS SEALED. THE WELL KEEPS WHAT IT TAKES.
- signup.created -> add the email to a list I can export.
- Every 5 minutes, GET /api/health; if it fails twice in a row, alert me.
Reject any request whose x-engine-secret header does not match EVENTS_SECRET. Show me each workflow before activating it, then put the webhook URL in .env as N8N_EVENTS_WEBHOOK and redeploy. Send one fake order.attention event so my phone buzzes.
```

## 8. Go live (launch day only)

```text
Go live.
- I put my LIVE Stripe key and the live webhook secret in .env, and set PUBLIC_URL=https://buildblackwell.com and PREVIEW_PASSWORD to empty. Check those are set (do not print them).
- Add buildblackwell.com and www.buildblackwell.com to the reverse proxy with HTTPS. www and engine.buildblackwell.com redirect to buildblackwell.com. Show me the change first.
- Redirect these old links to the right new pages: [PASTE LIST].
- Deploy, confirm the log says "LIVE payments", and run a final check: /api/health, /shop, /admin (asks for login), and that /api/state shows the right chambers.
```

## Every drop

```text
New drop in Chamber [NUMERAL]: [NAME]. Goes live [DATE] at [TIME] Eastern. [N] per size.
Ask me for each product's details and photos, add them to config/products.json, set the chamber to live with that goesLiveAt, deploy, and show me the countdown on my phone.
```
