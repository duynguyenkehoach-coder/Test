# syntax=docker/dockerfile:1.4
# --- STAGE 1: Builder (chạy 1 lần duy nhất, cache pnpm store) ---
FROM node:20-slim AS builder
WORKDIR /app

# Cache pnpm binary — chỉ reinstall nếu version thay đổi
RUN --mount=type=cache,target=/root/.npm \
    npm install -g pnpm

# Copy lock file trước để tận dụng layer cache
COPY pnpm-lock.yaml package.json ./

# Cache pnpm store trên disk — không bao giờ download lại packages đã có
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm config set node-linker hoisted && \
    pnpm install --frozen-lockfile --prod

# --- STAGE 2: Slim Runner (API & AI Worker) ---
FROM node:20-slim AS runner-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN mkdir -p data logs
EXPOSE 3000

# --- STAGE 3: Heavy Runner (Scraper — Playwright) ---
# Playwright image được cache trên disk sau lần đầu (~632MB pull 1 lần duy nhất)
FROM mcr.microsoft.com/playwright:v1.48.0-noble AS runner-heavy
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production
RUN mkdir -p data logs
