#!/bin/bash
# ═══════════════════════════════════════════════════════
# THG Lead Gen — VPS Deployment Script (Ubuntu 22.04)
# Run: bash deploy_vps.sh
# ═══════════════════════════════════════════════════════
set -e

echo "█████████████████████████████████████████████████"
echo "  🚀 THG LEAD GEN — VPS DEPLOYMENT"
echo "█████████████████████████████████████████████████"

# ── Step 1: Create 4GB Swap ──────────────────────────
echo ""
echo "▓▓▓ STEP 1: Creating 4GB Swap (2GB RAM → 6GB) ▓▓▓"
if [ -f /swapfile ]; then
    echo "✅ Swap already exists:"
    swapon --show
else
    sudo fallocate -l 4G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    # Optimize swap for SSD
    echo 'vm.swappiness=30' | sudo tee -a /etc/sysctl.conf
    echo 'vm.vfs_cache_pressure=50' | sudo tee -a /etc/sysctl.conf
    sudo sysctl -p
    echo "✅ 4GB Swap created!"
fi
free -h

# ── Step 2: Install Node.js 20 LTS ──────────────────
echo ""
echo "▓▓▓ STEP 2: Installing Node.js 20 LTS ▓▓▓"
if command -v node &> /dev/null; then
    echo "✅ Node.js already installed: $(node -v)"
else
    sudo apt update
    sudo apt install -y curl unzip
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "✅ Node.js installed: $(node -v)"
fi

# ── Step 3: Install dependencies ─────────────────────
echo ""
echo "▓▓▓ STEP 3: Installing npm dependencies ▓▓▓"
npm install --omit=dev
echo "✅ Dependencies installed"

# ── Step 4: Install Playwright Chromium ──────────────
echo ""
echo "▓▓▓ STEP 4: Installing Playwright Chromium + deps ▓▓▓"
npx playwright install chromium --with-deps
echo "✅ Playwright Chromium installed"

# ── Step 5: Create logs directory ────────────────────
mkdir -p logs data

# ── Step 6: Install & configure PM2 ─────────────────
echo ""
echo "▓▓▓ STEP 6: Setting up PM2 ▓▓▓"
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
fi

# Stop old processes if running
pm2 delete all 2>/dev/null || true

# Start 3-tier architecture
pm2 start ecosystem.config.js
pm2 save

# Auto-start on reboot
sudo env PATH=$PATH:$(which node) $(which pm2) startup systemd -u $(whoami) --hp $HOME
pm2 save

echo ""
echo "█████████████████████████████████████████████████"
echo "  ✅ DEPLOYMENT COMPLETE!"
echo ""
echo "  📊 pm2 monit         — Live dashboard"
echo "  📋 pm2 logs          — Live logs"
echo "  🔄 pm2 restart all   — Restart all"
echo "  ❌ pm2 stop all      — Stop all"
echo "█████████████████████████████████████████████████"
pm2 status
