# Sử dụng phiên bản ổn định, noble (Ubuntu 24.04) đã cài sẵn Chromium
FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# Chỉ copy package.json để cài dependencies trước (Layer này sẽ được cache)
COPY package*.json ./
RUN npm ci --production --silent

# Copy mã nguồn sau
COPY . .

# Không tải thêm browser vì image base đã có sẵn
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

# Tạo thư mục dữ liệu nếu chưa có
RUN mkdir -p data logs

EXPOSE 3000

CMD ["node", "src/index.js"]
