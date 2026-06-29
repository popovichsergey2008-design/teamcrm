#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] applying migrations..."
node dist/database/migrate.js

echo "[entrypoint] starting API..."
exec node dist/main.js
