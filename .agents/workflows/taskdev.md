---
description: Kill all node processes on port 3000 and restart dev server
---

// turbo-all
1. Install task CLI nếu chưa có, rồi kill node và start dev server
```powershell
if (-not (Get-Command task -ErrorAction SilentlyContinue)) { winget install Task.Task -e --silent }; Stop-Process -Name node -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; node src/server.js
```
