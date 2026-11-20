# Putting the Engine behind your reverse proxy

The container listens on `127.0.0.1:8787`. Your proxy only needs to send one
hostname there. WebSockets (`/ws/presence`) must pass through; all three below do.

Find out which proxy you have:

    sudo ss -tlnp | grep -E ':80 |:443 '
    docker ps --format '{{.Names}}\t{{.Image}}'

## Caddy (installed on the server)

Add to `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`:

    engine.buildblackwell.com {
        encode zstd gzip
        reverse_proxy 127.0.0.1:8787
    }

## nginx (installed on the server)

    server {
        server_name engine.buildblackwell.com;
        location / {
            proxy_pass http://127.0.0.1:8787;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }

Then `sudo certbot --nginx -d engine.buildblackwell.com`.

## Traefik in Docker (the usual Hostinger n8n setup)

Traefik cannot reach `127.0.0.1` on the host from inside its container, so join
its network instead. Copy `docker-compose.traefik.example.yml` to
`docker-compose.override.yml`, set the network and certificate-resolver names to
match your n8n compose file, then `docker compose up -d`.

## Launch day

Add `buildblackwell.com` and `www.buildblackwell.com` next to the engine hostname
(www should redirect to the bare domain), set `PUBLIC_URL=https://buildblackwell.com`
in `.env`, and run `./scripts/deploy.sh`.
