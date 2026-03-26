# ═══════════════════════════════════════════════════
# Playwright + Node.js trên Render
# ═══════════════════════════════════════════════════
FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# Copy package files → install deps
COPY package.json ./
RUN npm install --production

# Copy source code
COPY . .

# Render bind port
EXPOSE 10000

# Khởi chạy scanner
CMD ["node", "index.js"]
