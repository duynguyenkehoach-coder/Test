FROM mcr.microsoft.com/playwright:v1.50.1-noble

# Switch to Node.js 20 (Playwright image uses Node 18 by default)
# noble = Ubuntu 24.04 — all Chromium deps already installed
# Playwright's Chromium is at /ms-playwright/chromium-*/chrome-linux/chrome

WORKDIR /app

# Install production Node deps only
COPY package*.json ./
RUN npm ci --production --silent

# Copy app source
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# Ensure data & log dirs exist (volume-mounted in production)
RUN mkdir -p data logs

# Use system Chromium bundled by Playwright base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/api/stats || exit 1

CMD ["node", "src/index.js"]
