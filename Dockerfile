# syntax=docker/dockerfile:1.4

# --- STAGE 1: Builder (chạy 1 lần, cache pnpm store) ---
FROM node:20-slim AS builder
WORKDIR /app

# Cache pnpm binary
RUN --mount=type=cache,target=/root/.npm \
    npm install -g pnpm

# Copy lock file trước để tận dụng layer cache
COPY pnpm-lock.yaml package.json ./

# Cache pnpm store — không bao giờ download lại packages đã có
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm config set node-linker hoisted && \
    pnpm install --frozen-lockfile --prod

# --- STAGE 2: Slim Runner (API & AI Worker — ~150MB) ---
FROM node:20-slim AS runner-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN mkdir -p data logs
EXPOSE 3000

# --- STAGE 3: Heavy Runner (Scraper — Chromium only ~200MB thay vì 632MB) ---
FROM node:20-slim AS runner-heavy
WORKDIR /app

# Chỉ cài Chromium + deps tối thiểu, xóa apt cache ngay trong cùng layer
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgbm1 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Trỏ Playwright dùng Chromium hệ thống — không download browser riêng
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
RUN mkdir -p data logs
