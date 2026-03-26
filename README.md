# 📡 Facebook Group Scanner

Script Node.js chạy ngầm (headless) — tự động quét bài viết từ Facebook Groups theo từ khóa, gửi thông báo về Telegram. Hỗ trợ deploy lên **Render.com** miễn phí.

---

## ⚡ Cài Đặt Nhanh (5 phút)

### Bước 1: Cài dependencies

```bash
npm install
npx playwright install chromium
```

### Bước 2: Tạo file `.env`

```bash
copy .env.example .env
```

Mở `.env` và điền:

| Biến | Cách lấy |
|------|----------|
| `TELEGRAM_BOT_TOKEN` | Mở Telegram → tìm **@BotFather** → gửi `/newbot` → nhận token |
| `TELEGRAM_CHAT_ID` | Mở Telegram → tìm **@userinfobot** → gửi `/start` → nhận Chat ID |
| `FB_COOKIES` | Xem hướng dẫn bên dưới |

### Bước 3: Lấy Facebook Cookies

**Cách 1 — File JSON (khuyến nghị):**
1. Đăng nhập Facebook trên Chrome
2. Cài extension [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)
3. Mở `facebook.com` → click extension → **Export** → **JSON**
4. Lưu nội dung vào file `cookies.json` trong thư mục gốc

**Cách 2 — Chuỗi cookie trong .env:**
1. Mở Chrome DevTools (F12) → tab **Application** → **Cookies** → `facebook.com`
2. Copy giá trị 3 cookie: `c_user`, `xs`, `datr`
3. Dán vào `.env`: `FB_COOKIES=c_user=123; xs=abc; datr=xyz`

### Bước 4: Cấu hình Groups và Từ Khóa

Mở **`config.js`** và điền vào 2 mảng:

```javascript
const TARGET_GROUPS = [
    { name: 'Hội Ship Hàng', url: 'https://www.facebook.com/groups/123456789' },
    { name: 'Cộng Đồng Seller', url: 'https://www.facebook.com/groups/987654321' },
];

const TARGET_KEYWORDS = [
    'ship hàng đi mỹ',
    'fulfillment',
    'cần kho',
];
```

---

## 🚀 Chạy Local

```bash
npm start          # Chạy liên tục (cron mỗi 30 phút)
npm run scan       # Chạy 1 lần để test
```

---

## ☁️ Deploy lên Render.com (Miễn phí)

### Bước 1: Push code lên GitHub

```bash
git add -A
git commit -m "fb-scanner v1.0"
git push origin main
```

### Bước 2: Tạo service trên Render

1. Vào [render.com](https://render.com) → **New** → **Web Service**
2. Kết nối repo GitHub
3. Render sẽ tự detect `Dockerfile` → chọn **Docker** runtime
4. Plan: **Free**
5. Thêm **Environment Variables**:
   - `TELEGRAM_BOT_TOKEN` = token của bạn
   - `TELEGRAM_CHAT_ID` = chat ID của bạn
   - `FB_COOKIES` = chuỗi cookies (VD: `c_user=123; xs=abc; datr=xyz`)
6. Click **Deploy**

### Bước 3: Giữ app sống bằng UptimeRobot (Nếu dùng Render)

Render free tier tắt app sau 15 phút không có request. Cần ping giữ sống:

1. Vào [uptimerobot.com](https://uptimerobot.com) → tạo tài khoản miễn phí
2. **Add New Monitor** → **HTTP(S)** → dán URL Render (VD: `https://fb-scanner-xxxx.onrender.com`)
3. Interval: **5 minutes**
4. Done! UptimeRobot sẽ ping mỗi 5 phút, Render không tắt app.

---

## 🤖 Chạy trên GitHub Actions (Miễn phí & 24/7)

Đây là cách tốt nhất để chạy bot định kỳ (mỗi giờ) mà không cần máy tính và không bị tắt như Render.

### Bước 1: Thiết lập GitHub Secrets
Vào Repo của bạn trên GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Thêm các biến sau:

- `FB_COOKIES`: Chuỗi cookie Facebook (hoặc nội dung file `cookies.json`).
- `TELEGRAM_BOT_TOKEN`: Token của bot Telegram.
- `TELEGRAM_CHAT_ID`: Chat ID của bạn.
- `GOOGLE_SHEET_ID`: ID của file Google Sheet.

### Bước 2: Kích hoạt Workflow
1. Tab **Actions** trên GitHub.
2. Chọn **Facebook Auto-Comment Bot**.
3. Bot sẽ tự động chạy mỗi giờ một lần (theo lịch Cron).
4. Bạn có thể bấm **Run workflow** để chạy thử ngay lập tức.

---

---

## 📁 Cấu Trúc File

```
├── .env.example      ← Template hướng dẫn
├── config.js         ← 👉 ĐIỀN GROUPS + TỪ KHÓA Ở ĐÂY
├── index.js          ← Entry point (cron + health-check server)
├── scraper.js        ← Playwright scraper
├── telegram.js       ← Gửi thông báo Telegram
├── Dockerfile        ← Docker config cho Render
├── render.yaml       ← Render deployment config
├── cookies.json      ← (Tự tạo) Facebook cookies
├── seen_posts.json   ← (Tự tạo) Chống gửi trùng
└── package.json      ← Dependencies
```

---

## ❓ Xử Lý Lỗi Thường Gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `Session Facebook không hợp lệ` | Cookies hết hạn | Lấy lại cookies mới (Bước 3) |
| `CHECKPOINT` | Facebook nghi ngờ bot | Đợi 24h, đổi tài khoản, giảm số groups |
| `Chưa cấu hình TELEGRAM_BOT_TOKEN` | Chưa điền .env | Hoàn thành Bước 2 |
| `TARGET_GROUPS trống` | Chưa điền config.js | Hoàn thành Bước 4 |

---

## ⚙️ Tuỳ Chỉnh (.env)

- `SCAN_INTERVAL_MINUTES=30` — Chu kỳ quét (phút)
- `MAX_POSTS_PER_GROUP=30` — Số bài tối đa mỗi group
- `MAX_POST_AGE_DAYS=3` — Bỏ qua bài cũ hơn X ngày

---

## 📊 Cấu hình Google Sheets (Bình luận tự động)

Để bot tự động bình luận, bạn cần cấu hình Google Sheet:

1. Tạo một Google Sheet mới.
2. Cấu hình 11 cột đúng thứ tự sau:
   `Group name` | `Nội dung 1` | `Ảnh 1` | `Nội dung 2` | `Ảnh 2` | `Nội dung 3` | `Ảnh 3` | `Nội dung 4` | `Ảnh 4` | `Nội dung 5` | `Ảnh 5`
3. **Group name**: Phải khớp chính xác với `name` trong `config.js`.
4. **Ảnh**: Điền đường dẫn tuyệt đối (VD: `C:\Photos\sale.png`) hoặc đường dẫn tương đối (VD: `./images/sale.png`).
5. Vào **File** → **Share** → **Publish to web**.
6. Chọn **Entire Document** và **CSV (.csv)**. Copy link này.
7. Lấy ID của Sheet từ URL (chuỗi ký tự giữa `/d/` và `/edit`) và dán vào `GOOGLE_SHEET_ID` trong `config.js` hoặc `.env`.

Bot sẽ tự động chọn tất cả các cặp (Nội dung + Ảnh) có dữ liệu để bình luận (tối đa 5 lượt mỗi bài viết).
