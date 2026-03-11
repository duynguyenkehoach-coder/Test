#!/bin/bash
# VPS Recovery Script - run after reboot
# ssh -p 2018 root@61.14.233.242 "bash -s" < scripts/vps-recover.sh

set -e
echo "=== VPS Recovery $(date) ==="

# 1. Check disk space
echo "--- Disk ---"
df -h /

# 2. Check memory
echo "--- Memory ---"
free -m

# 3. Check Docker status
echo "--- Docker ---"
systemctl status docker --no-pager -l | head -20

# 4. Start Docker if not running
if ! systemctl is-active --quiet docker; then
  echo "Starting Docker..."
  systemctl start docker
  sleep 3
fi

# 5. Check container
echo "--- Containers ---"
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# 6. Go to app dir
cd /root/THG_tool || { echo "ERROR: /root/THG_tool not found!"; exit 1; }

# 7. Pull latest code  
echo "--- Git Pull ---"
git fetch origin main
git reset --hard origin/main

# 8. Start/restart container
echo "--- Docker Compose Up ---"
docker compose up -d

# 9. Wait for health
echo "--- Health Check ---"
for i in $(seq 1 12); do
  sleep 5
  HTTP=$(curl -so /dev/null -w "%{http_code}" http://localhost:3000/api/stats 2>/dev/null || echo "000")
  if [ "$HTTP" = "200" ]; then
    echo "✅ App healthy! HTTP 200 after $((i*5))s"
    docker ps --filter name=thg-lead-gen
    exit 0
  fi
  echo "  [$((i*5))s] HTTP ${HTTP}..."
done

echo "⚠️ App not responding after 60s — showing logs:"
docker logs thg-lead-gen --tail 50
