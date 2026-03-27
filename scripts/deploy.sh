#!/usr/bin/env bash
set -euo pipefail

# Simple deployment helper for university/demo use.
# It pulls the latest code and recreates the containers using Docker Compose.

git pull
docker compose up --build -d

echo "Deployment finished."

