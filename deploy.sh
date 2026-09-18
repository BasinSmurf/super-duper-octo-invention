#!/usr/bin/env bash
# ──────────────────────────────────────────────
# Sundog — deploy / rebuild script
#
# Usage:
#   ./deploy.sh              # build + start everything
#   ./deploy.sh --seed       # also seed the database
#   ./deploy.sh --down       # stop everything
#   ./deploy.sh --logs       # tail all logs
#   ./deploy.sh --reset      # nuke volumes + rebuild (DESTRUCTIVE)
# ──────────────────────────────────────────────
set -euo pipefail

# Bare compose auto-loads ./.env -- the SAME file the CI path (ci/ci-deploy.sh) and
# the running stack use, and the one Postgres was initialized with. Do NOT force
# --env-file .env.production: that is a stale template, and using it sends the api a
# stale POSTGRES_PASSWORD => P1000 auth failure. (See ci/SETUP-CI-PIPELINE.md.)
COMPOSE="docker compose -f docker-compose.prod.yml"

case "${1:-up}" in

  up|--up)
    echo "🔨 Building and starting Sundog..."
    $COMPOSE up -d --build
    echo ""
    echo "⏳ Waiting for API health check..."
    for i in $(seq 1 30); do
      if $COMPOSE exec -T api wget -qO- http://localhost:3001/api/health 2>/dev/null | grep -q '"ok"'; then
        echo "✅ API is healthy"
        break
      fi
      [ "$i" -eq 30 ] && echo "⚠️  API didn't become healthy in 30s — check logs" && exit 1
      sleep 1
    done
    echo ""
    echo "🌐 Sundog is running!"
    echo "   Open https://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<your-ip>') on your iPad"
    echo "   (Accept the self-signed certificate warning on first visit)"
    ;;

  --seed)
    echo "🌱 Running database migrations + seed..."
    $COMPOSE exec api npx prisma migrate deploy
    $COMPOSE exec api npx prisma db seed
    echo "✅ Database seeded"
    ;;

  --migrate)
    echo "📦 Running database migrations..."
    $COMPOSE exec api npx prisma migrate deploy
    echo "✅ Migrations applied"
    ;;

  --down)
    echo "🛑 Stopping Sundog..."
    $COMPOSE down
    echo "✅ Stopped"
    ;;

  --logs)
    $COMPOSE logs -f --tail=100
    ;;

  --status)
    $COMPOSE ps
    ;;

  --reset)
    echo "⚠️  This will DELETE all data (database, uploads, etc.)"
    read -p "Are you sure? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      $COMPOSE down -v
      $COMPOSE up -d --build
      echo "🔄 Reset complete — run './deploy.sh --seed' to re-seed"
    fi
    ;;

  *)
    echo "Usage: ./deploy.sh [up|--seed|--migrate|--down|--logs|--status|--reset]"
    exit 1
    ;;

esac
