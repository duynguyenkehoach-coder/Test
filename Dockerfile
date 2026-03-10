# ─── Stage 1: Install production dependencies ────────────────────────────────
FROM mcr.microsoft.com/playwright/node:20-jammy AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --production --silent

# ─── Stage 2: Production runtime ─────────────────────────────────────────────
FROM mcr.microsoft.com/playwright/node:20-jammy AS runner
# This base image has Chromium + all system deps pre-installed.
# No `playwright install` ever needed!

WORKDIR /app

# Copy installed dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (order matters for layer caching)
COPY src/ ./src/
COPY public/ ./public/
COPY ecosystem.config.js ./
COPY nginx/ ./nginx/

# Copy scripts if they exist
COPY scripts/ ./scripts/ 2>/dev/null || true

# Ensure data & log dirs exist (they'll be volume-mounted in production)
RUN mkdir -p data logs

EXPOSE 3000

# Health check — Docker and nginx use this to verify app is alive
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/api/stats || exit 1

CMD ["node", "src/index.js"]
