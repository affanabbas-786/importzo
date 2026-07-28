#!/bin/bash
# Importzo — Production Deploy Script
# Usage: bash deploy.sh

set -e

echo "==> Building app..."
npm run build

echo "==> Running database migrations..."
npx prisma migrate deploy

echo "==> Reloading PM2 (zero-downtime)..."
pm2 reload importzo

echo "==> Done. Live at https://importzo.dazzletech.co"
pm2 list
