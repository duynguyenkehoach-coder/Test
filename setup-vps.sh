#!/bin/bash
# ═══════════════════════════════════════════════════════════
# THG Lead Gen — VPS 1-Click Setup Script
# Run: bash setup-vps.sh
# ═══════════════════════════════════════════════════════════

set -e
echo "═══════════════════════════════════════════════════════════"
echo "  🚀 THG Lead Gen — VPS Setup Starting..."
echo "═══════════════════════════════════════════════════════════"

# 1. Update system
echo "[1/7] 📦 Updating system..."
apt update && apt upgrade -y

# 2. Install Node.js 20
echo "[2/7] 🟢 Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
echo "  Node.js version: $(node -v)"
echo "  npm version: $(npm -v)"

# 3. Install PM2 (Process Manager)
echo "[3/7] ⚡ Installing PM2..."
npm install -g pm2

# 4. Install Nginx (Reverse Proxy)
echo "[4/7] 🌐 Installing Nginx..."
apt install -y nginx

# 5. Clone repo
echo "[5/7] 📥 Cloning repository..."
cd /root
if [ -d "THG_tool" ]; then
    echo "  Repository already exists, pulling latest..."
    cd THG_tool && git pull
else
    git clone https://github.com/davidanh98/THG_tool.git
    cd THG_tool
fi

# 6. Install dependencies
echo "[6/7] 📦 Installing npm dependencies..."
npm install

# 7. Create .env file
echo "[7/7] 🔐 Creating .env file..."
if [ ! -f .env ]; then
cat > .env << 'ENVFILE'
# === THG Lead Gen Environment Variables ===
# RapidAPI (scraping)
RAPIDAPI_KEY=YOUR_RAPIDAPI_KEY_HERE

# Groq AI (classification)
GROQ_API_KEY=YOUR_GROQ_API_KEY_HERE

# Gemini AI (copilot responses)
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE

# Apify (fallback scraping)
APIFY_TOKEN=YOUR_APIFY_TOKEN_HERE

# Telegram Bot
TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=@THG_sale

# Facebook Webhook
FB_VERIFY_TOKEN=thg_verify_2024
FB_PAGE_ACCESS_TOKEN=

# Server
PORT=3000
NODE_ENV=production
ENVFILE
    echo "  ✅ .env created!"
else
    echo "  ⚠️ .env already exists, skipping..."
fi

# 8. Create data directory
mkdir -p data logs

# 9. Configure Nginx
echo "🌐 Configuring Nginx reverse proxy..."
cat > /etc/nginx/sites-available/thg-lead-gen << 'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/thg-lead-gen /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# 10. Start with PM2
echo "⚡ Starting THG Lead Gen with PM2..."
pm2 delete thg-lead-gen 2>/dev/null || true
pm2 start src/index.js --name thg-lead-gen --max-memory-restart 800M
pm2 save
pm2 startup systemd -u root --hp /root

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ THG Lead Gen — SETUP COMPLETE!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  🌐 Dashboard: http://61.14.233.242"
echo "  🔍 Health:    http://61.14.233.242/health"
echo "  📡 Webhook:   http://61.14.233.242/webhook"
echo ""
echo "  📋 Useful commands:"
echo "    pm2 logs thg-lead-gen    ← View real-time logs"
echo "    pm2 restart thg-lead-gen ← Restart server"
echo "    pm2 status               ← Check status"
echo "    cd /root/THG_tool && git pull && pm2 restart thg-lead-gen  ← Update code"
echo ""
echo "═══════════════════════════════════════════════════════════"
