<!-- Section 02 / 10 — Cài đặt & setup. Một phần của Arkon SOP. -->

# 02 — Cài đặt Arkon từ đầu

Hướng dẫn này đưa bạn từ một máy chủ trống đến hệ thống Arkon hoàn chỉnh — bao gồm Docker, cấu hình môi trường, migration database, tạo admin, seed dữ liệu và bulk import nhân viên. Thực hiện tuần tự từ trên xuống.

---

## 1. Checklist prerequisites

Trước khi bắt đầu, xác nhận đủ các thành phần sau:

- [ ] **Docker Desktop** (Windows/macOS) hoặc **Docker Engine 24+** với Docker Compose v2+ (Linux server)
- [ ] **Git** để clone repo
- [ ] **Quyền truy cập API key** cho ít nhất một AI provider: OpenAI, Google AI Studio, hoặc Anthropic
- [ ] Cổng `3119`, `5055`, `9002`, `9003` chưa bị process khác chiếm

> Không cần cài Node.js hay Python thêm — mọi thứ chạy trong container.

Kiểm tra Docker đã sẵn sàng:

```bash
docker version
docker compose version
```

Bạn sẽ thấy output dạng:

```
Docker version 26.x.x, ...
Docker Compose version v2.x.x
```

---

## 2. Clone repo và cấu hình `.env.docker`

```bash
git clone https://github.com/nduckmink/arkon.git
cd arkon
cp .env.docker.example .env.docker
```

Mở `.env.docker` và điền các biến bắt buộc sau (không để giá trị default trong production):

| Biến | Bắt buộc | Mô tả |
|---|:---:|---|
| `SECRET_KEY` | Có | JWT signing key. Sinh bằng lệnh dưới. |
| `MCP_TOKEN_PEPPER` | Có | HMAC pepper hash MCP token. Sinh một lần, không đổi sau khi deploy. |
| `DEFAULT_ADMIN_EMAIL` | Có | Email tài khoản admin đầu tiên. |
| `DEFAULT_ADMIN_PASSWORD` | Có | Mật khẩu admin đầu tiên, đổi ngay sau login. |
| `POSTGRES_PASSWORD` | Có | Mật khẩu PostgreSQL — phải khớp với `DATABASE_URL`. |
| `DATABASE_URL` | Có | Connection string đầy đủ, dạng `postgresql+asyncpg://arkon:<password>@postgres:5432/arkon`. |
| `MINIO_ACCESS_KEY` | Có | MinIO root user (khởi tạo container lần đầu). |
| `MINIO_SECRET_KEY` | Có | MinIO root password. Đổi sau lần khởi tạo đầu tiên sẽ cần `docker compose down -v`. |
| `MINIO_PUBLIC_ENDPOINT` | Có | Địa chỉ MinIO browser-accessible. Local: `localhost:9002`. Server: `<ip>:9002`. |
| `REDIS_PASSWORD` | Có | Password Redis queue. |
| `NEXT_PUBLIC_API_URL` | Có | URL API công khai trình duyệt sử dụng. Local: `http://localhost:5055`. |
| `CORS_ORIGINS` | Có | Danh sách origin cho phép, cách nhau bằng dấu phẩy. |

> **Lưu ý quan trọng:** `NEXT_PUBLIC_API_URL` là biến **build-time** — Next.js bake thẳng vào bundle JS. Nếu đổi giá trị này sau khi đã build, bạn phải rebuild image frontend, không phải chỉ restart container.

Sinh giá trị ngẫu nhiên cho `SECRET_KEY` và `MCP_TOKEN_PEPPER`:

```bash
# Linux / macOS
python3 -c "import secrets; print(secrets.token_urlsafe(32))"

# Windows PowerShell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Chạy lệnh hai lần, gán kết quả lần lượt cho `SECRET_KEY` và `MCP_TOKEN_PEPPER`.

> **AI provider keys không được đặt trong `.env.docker`**. OpenAI API key, Google AI key, và Anthropic key được cấu hình qua Admin Portal → Settings sau khi hệ thống chạy. Đây là thiết kế có chủ đích — keys được mã hóa và lưu trong database.

---

## 3. Khởi động hệ thống

```bash
docker compose --env-file .env.docker up -d --build
```

> Luôn truyền `--env-file .env.docker` tường minh. Bỏ qua flag này khiến Docker Compose fallback về `.env` (config local dev), gây lỗi `SignatureDoesNotMatch` ở MinIO và frontend vẫn gọi `localhost:5055`.

Quá trình khởi động theo thứ tự:

1. `arkon_postgres`, `arkon_redis`, `arkon_minio` khởi động và chạy health check
2. `arkon_migrator` chạy `alembic upgrade head` — tạo toàn bộ schema và seed 5 knowledge type mặc định
3. `arkon_api` khởi động sau khi migrator hoàn tất, tự tạo admin account lần đầu
4. `arkon_worker` và `arkon_worker_skills` khởi động sau khi API pass health check
5. `arkon_frontend` khởi động sau khi API healthy

Theo dõi trạng thái:

```bash
docker compose ps
```

Bạn sẽ thấy tất cả container ở trạng thái `running` hoặc `healthy` (worker không có health check nên hiển thị `running`). Quá trình này mất khoảng 60–90 giây lần đầu do build image.

Xem log API để xác nhận migration và admin tạo thành công:

```bash
docker compose logs arkon_migrator
docker compose logs arkon_api | head -40
```

Bạn sẽ thấy ở log `arkon_api`:

```
INFO  Starting Arkon API...
SUCCESS  MinIO bucket ready
SUCCESS  Default admin created: admin@yourcompany.com
SUCCESS  Arkon MCP Server ready at /mcp
SUCCESS  Arkon API started successfully
```

**Ports mặc định:**

| Service | Port | Truy cập |
|---|---|---|
| Frontend (UI) | `3119` | `http://localhost:3119` |
| API + MCP | `5055` | `http://localhost:5055` |
| MinIO console | `9003` | `http://localhost:9003` |
| MinIO API | `9002` | `http://localhost:9002` (presigned URLs) |

---

## 4. Tạo admin đầu tiên

Admin được tạo **tự động** khi API khởi động lần đầu, dựa trên `DEFAULT_ADMIN_EMAIL` và `DEFAULT_ADMIN_PASSWORD` trong `.env.docker`. Không cần chạy script thủ công.

Xác nhận bằng cách đăng nhập UI tại `http://localhost:3119` với email và mật khẩu đã cấu hình.

Hoặc verify qua API:

```bash
curl -s -X POST http://localhost:5055/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@yourcompany.com", "password": "your-password"}' \
  | python -m json.tool
```

Response thành công trả về `access_token` và `"role": "admin"`.

**Đổi mật khẩu admin ngay sau login đầu tiên** qua menu profile trên giao diện.

---

## 5. Cấu hình AI provider (bắt buộc trước khi dùng)

Sau khi đăng nhập, vào **Settings → AI Models** và cấu hình:

- **Embedding model** — bắt buộc để tìm kiếm semantic wiki (ví dụ: `text-embedding-004` của Google)
- **LLM** — bắt buộc để compile wiki từ tài liệu (ví dụ: `gemini-2.5-pro`, `gpt-4o`, `claude-sonnet-4-5`)
- **Vision model** — tùy chọn, bật caption ảnh khi ingest PDF có hình

Không cần restart container sau khi lưu — config được apply ngay.

---

## 6. Seed dữ liệu mẫu cho triển khai trường học

Bỏ qua bước này nếu bạn không triển khai cho môi trường trường học.

### 6a. Seed phòng ban và role templates

Script tạo 15 phòng ban (Ban Giám Hiệu, các khối học, phòng ban hành chính) và 14 role templates tiếng Việt (Hiệu trưởng, Giáo viên, Trưởng phòng, v.v.). Idempotent — chạy lại không tạo bản ghi trùng.

```bash
docker exec arkon_api python -m app.scripts.seed_school_setup
```

Output mong đợi:

```
  + department: Ban Giám Hiệu
  + department: Phòng Đào Tạo - Giáo Vụ
  ...
  + role: Hiệu trưởng (16 perms)
  + role: Giáo viên (7 perms)
  ...
Seed complete. New departments: 15/15, new roles: 14, updated roles: 0, total school roles: 14.
```

### 6b. Seed knowledge types cho trường học

Script thay thế 5 knowledge type mặc định (General, SOP, Product, Project, Customer) bằng 15 loại phù hợp với trường học (Quy trình SOP, Chính sách, Biểu mẫu, Tuyển sinh, v.v.). Idempotent và tự remap các source và wiki page đang dùng type cũ.

```bash
docker exec arkon_api python -m app.scripts.seed_school_knowledge_types
```

Output mong đợi:

```
  + KT: tai-lieu-chung — Tài liệu chung
  + KT: quy-trinh-sop — Quy trình SOP
  ...
  ↻ remap KT: general → tai-lieu-chung
Done. Inserted 15/15 school KTs, remapped 0 sources, deleted 5 default KTs.
```

---

## 7. Bulk import nhân viên từ Excel

### Bước 1: Tạo file template

Chạy script để sinh file template Excel có sẵn dropdown phòng ban và vai trò từ database live:

```bash
docker exec arkon_api python -m app.scripts.generate_employees_template
docker cp arkon_api:/app/employees_import_template.xlsx ./tmp/
```

File `employees_import_template.xlsx` có 4 sheet:
- **Nhân viên** — điền dữ liệu vào đây (3 dòng ví dụ sẵn, xóa trước khi import)
- **Hướng dẫn** — đọc trước khi điền
- **Phòng ban** — danh mục hợp lệ (tham chiếu bởi dropdown)
- **Vai_tro** — danh mục role hợp lệ

Cột bắt buộc: `Họ tên`, `Email`, `Phòng ban`. Cột `Mật khẩu tạm thời` để trống thì script tự sinh ngẫu nhiên.

### Bước 2: Điền dữ liệu và import

Sau khi phòng nhân sự điền xong, copy file vào container và chạy import:

```bash
# Windows PowerShell
docker cp .\tmp\employees_import.xlsx arkon_api:/app/

# Linux / macOS
docker cp ./tmp/employees_import.xlsx arkon_api:/app/
```

```bash
docker exec arkon_api python -m app.scripts.import_employees
```

Output mong đợi:

```
Đang xử lý 25 dòng...

  ✓ [ 2] nv.an@vietanh.edu.vn             → created   id=...
  ✓ [ 3] tt.binh@vietanh.edu.vn           → created   id=...
  ⊘ [ 4] existing@vietanh.edu.vn          → skipped   Email đã tồn tại
  ...
Tổng: 25  ✓ 23 tạo  ⊘ 1 bỏ qua  ✗ 1 lỗi
```

### Bước 3: Lấy file kết quả

```bash
docker cp arkon_api:/app/employees_import_result.xlsx ./tmp/
```

File kết quả chứa mật khẩu plaintext của từng nhân viên (kể cả mật khẩu tự sinh). Chuyển credentials qua kênh bảo mật và **xóa file sau khi dùng — không commit vào git**.

---

## 8. Tạo MCP token đầu tiên cho admin

MCP token dùng để Claude Desktop kết nối Arkon qua Bearer token (thay cho OAuth khi không có HTTPS). Admin tự tạo token của mình qua API:

```bash
# Lấy JWT token trước
TOKEN=$(curl -s -X POST http://localhost:5055/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@yourcompany.com", "password": "your-password"}' \
  | python -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Tạo MCP token
curl -s -X POST http://localhost:5055/api/my/mcp-token \
  -H "Authorization: Bearer $TOKEN" \
  | python -m json.tool
```

> Trên Windows PowerShell, dùng cách 2 dòng riêng biệt thay vì `$()` subshell.

Response chứa `token` dạng `ark_...`. Mỗi lần gọi `POST /api/my/mcp-token` sẽ sinh token mới và vô hiệu hóa token cũ.

Admin cũng có thể tạo token cho nhân viên khác qua:

```
POST /api/employees/{emp_id}/token
```

(Yêu cầu quyền `org:employees:manage`.)

Dán token vào `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "arkon": {
      "url": "http://localhost:5055/mcp",
      "headers": { "Authorization": "Bearer ark_..." }
    }
  }
}
```

---

## 9. Smoke test sau cài đặt

Thực hiện các kiểm tra nhanh để xác nhận hệ thống hoạt động end-to-end:

**Health check API:**

```bash
curl http://localhost:5055/health
```

Response mong đợi: `{"status": "healthy", "services": {"database": "healthy", "redis": "healthy", "minio": "healthy"}}`

**Login UI:** Mở `http://localhost:3119`, đăng nhập bằng admin account. Bạn sẽ thấy dashboard chính.

**Upload file thử:** Vào Knowledge Base → Upload → chọn một file PDF hoặc Word → chọn knowledge type → Submit. Trạng thái chuyển từ `pending` sang `processing` rồi `ready` trong vòng 1–2 phút (tùy độ phức tạp file và tốc độ AI provider).

**Query qua MCP:** Sau khi có MCP token, mở Claude Desktop và hỏi: "search the knowledge base for [từ khóa trong file vừa upload]". Arkon trả về kết quả từ wiki.

---

## 10. Troubleshooting cài đặt

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Port `3119` hoặc `5055` đã được dùng | Conflict với process khác | Dừng process kia, hoặc sửa port trong `docker-compose.yml` và `.env.docker` |
| `arkon_migrator` exit với error | Database chưa sẵn sàng hoặc password sai | `docker compose logs arkon_migrator` để xem chi tiết; kiểm tra `POSTGRES_PASSWORD` khớp trong `DATABASE_URL` |
| `arkon_api` log `WARNING: SECRET_KEY is set to the default value` | Quên thay `SECRET_KEY` | Dừng stack, sửa `.env.docker`, chạy lại |
| MinIO `SignatureDoesNotMatch` | Chạy `docker compose up` không có `--env-file` | `docker compose down -v` rồi `docker compose --env-file .env.docker up -d --build` — flag `-v` xóa volume MinIO để reinit credentials |
| File/ảnh không load trên browser (`ERR_NAME_NOT_RESOLVED`) | `MINIO_PUBLIC_ENDPOINT` trỏ đến hostname nội bộ | Đặt `MINIO_PUBLIC_ENDPOINT=localhost:9002` (local) hoặc `<server-ip>:9002` (remote) |
| Frontend vẫn gọi `localhost:5055` sau khi đổi `NEXT_PUBLIC_API_URL` | Biến này là build-time, không phải runtime | Rebuild image: `docker compose --env-file .env.docker build --no-cache frontend && docker compose --env-file .env.docker up -d` |
| OpenAI 429 / quota exceeded khi upload file | Rate limit từ OpenAI | Giảm `WORKER_MAX_JOBS` xuống `1` trong `.env.docker`, restart worker |
| Document mãi ở trạng thái `pending` | Worker chưa chạy hoặc bị crash | `docker compose ps` kiểm tra `arkon_worker`; `docker compose logs arkon_worker` xem lỗi |
| `seed_school_setup` báo "department already exists" | Script đã chạy trước đó | Bình thường — script idempotent, bỏ qua các row đã tồn tại |
| Import nhân viên: "Phòng ban không tồn tại" | Tên phòng ban trong Excel không khớp chính xác | Mở lại template, dùng giá trị chính xác từ sheet "Phòng ban" (case-sensitive) |

---

Sau khi hoàn tất section này, hệ thống Arkon đã sẵn sàng. Bước tiếp theo: **Section 03 — Quản lý phân quyền (RBAC)** để thiết lập quyền truy cập cho từng nhóm nhân viên.
