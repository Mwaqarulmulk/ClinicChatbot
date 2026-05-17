# ─────────────────────────────────────────────────────────────────────────────
# Use Debian-based slim image (NOT Alpine).
# @lancedb/lancedb-linux-x64-gnu and @libsql/linux-x64-gnu are GNU/glibc
# native binaries — they will NOT load on Alpine (musl libc) and will crash
# the process at startup.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV NODE_ENV=production

# Install runtime system dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy only package manifests first for Docker layer-cache efficiency.
# npm ci uses the lockfile for fully reproducible installs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false

# Copy application source (node_modules already installed above)
COPY . .

# Create the data directory that the volume will be mounted over on Fly.io.
# On Fly.io: mounted at /app/data via fly.toml [[mounts]].
# Locally:   app defaults to .data/ via config.ts defaults.
RUN mkdir -p /app/data

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

# Expose the HTTP port declared in fly.toml [env] PORT
EXPOSE 8080

# Docker-native health check (Fly.io also checks /health via http_service.checks)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e \
    "require('http').get('http://localhost:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Start via tsx (TypeScript at runtime — no separate compile step needed)
CMD ["node", "--import", "tsx", "src/index.ts"]
