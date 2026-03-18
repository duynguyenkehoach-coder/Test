#!/bin/bash
# ═══════════════════════════════════════════════════════
# THG — Ollama Setup for VPS (2 CPU / 4GB RAM / 40GB)
# Model: qwen2.5:3b (~2.2GB RAM, hiểu tiếng Việt tốt)
# ═══════════════════════════════════════════════════════

set -e
echo "🚀 THG Ollama Setup — Starting..."

# ── Step 1: Install Ollama ──
echo "📦 Installing Ollama..."
curl -fsSL https://ollama.com/install.sh | sh

# ── Step 2: Add swap (4GB) for safety ──
if [ ! -f /swapfile ]; then
    echo "💾 Creating 4GB swap..."
    sudo fallocate -l 4G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "✅ Swap created (4GB)"
else
    echo "✅ Swap already exists"
fi

# ── Step 3: Configure Ollama systemd service ──
echo "⚙️ Configuring Ollama service..."
cat > /etc/systemd/system/ollama.service << 'EOF'
[Unit]
Description=Ollama Service
After=network-online.target

[Service]
ExecStart=/usr/local/bin/ollama serve
User=ollama
Group=ollama
Restart=always
RestartSec=3
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=2"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_HOST=127.0.0.1:11434"

[Install]
WantedBy=default.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ollama
sudo systemctl restart ollama

# Wait for Ollama to be ready
echo "⏳ Waiting for Ollama to start..."
for i in $(seq 1 15); do
    if curl -s http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
        echo "✅ Ollama is running!"
        break
    fi
    sleep 2
    echo "  [$((i*2))s] waiting..."
done

# ── Step 4: Pull model ──
echo "📥 Pulling qwen2.5:3b model (~2GB)..."
ollama pull qwen2.5:3b

# ── Step 5: Verify ──
echo ""
echo "═══════════════════════════════════════════════"
echo "✅ Ollama Setup Complete!"
echo "═══════════════════════════════════════════════"
echo ""
echo "📊 Model info:"
ollama list
echo ""
echo "🔧 Test command:"
echo "  curl http://127.0.0.1:11434/v1/chat/completions \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"model\":\"qwen2.5:3b\",\"messages\":[{\"role\":\"user\",\"content\":\"Xin chào\"}]}'"
echo ""
echo "📡 Ollama API: http://127.0.0.1:11434"
echo "🤖 Model: qwen2.5:3b"
echo "🔒 Bound to localhost only (secure)"
