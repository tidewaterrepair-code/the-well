#!/usr/bin/env bash
# Rebuild and restart the Engine, then prove it is alive.   ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No .env file. Run: cp .env.example .env && nano .env"; exit 1; }
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git remote get-url origin >/dev/null 2>&1; then
  git pull --ff-only || echo "(git pull skipped: local changes or no upstream)"
fi
docker compose build
docker compose up -d
echo "Waiting for the Engine..."
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
    curl -fsS http://127.0.0.1:8787/api/health; echo
    echo "The Engine is up."
    docker compose logs --tail 12 engine | grep -F "[setup]" || true
    exit 0
  fi
  sleep 2
done
echo "THE ENGINE DID NOT COME UP. Last log lines:"
docker compose logs --tail 60 engine
exit 1
