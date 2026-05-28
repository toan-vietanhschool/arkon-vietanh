<!-- Section 10 / 10 — Vận hành & sự cố. Một phần của Arkon SOP. -->

# Section 10 — Vận hành ngày thường & xử lý sự cố

Tài liệu này dành cho on-call engineer và admin hệ thống. Mục tiêu: phát hiện bất thường sớm, xử lý source bị kẹt, backup/restore dữ liệu, và chạy đúng script khi cần.

---

## 10.1 Monitoring hệ thống

### Xem log container

```bash
# Log API (1 giờ gần nhất)
docker logs --since 1h arkon_api

# Log worker (theo dõi pipeline ingestion)
docker logs --since 1h arkon_worker

# Follow log real-time
docker logs -f --tail=100 arkon_worker
```

### Kiểm tra API health

```bash
curl http://localhost:5055/health
```

Response mong đợi: `{"status": "ok"}`. Nếu trả về lỗi hoặc timeout → container API có vấn đề, kiểm tra `docker ps` ngay.

### Redis queue depth

```bash
docker exec arkon_redis redis-cli -a arkon_secret LLEN arq:queue
```

Số lượng > 20 và không giảm sau vài phút → worker có thể bị crash hoặc bị block bởi rate limit.

### DB health — các query monitor thường dùng

```bash
# Mở psql trong container
docker exec -it arkon_postgres psql -U arkon -d arkon
```

Sau khi vào psql, chạy các query sau:

```sql
-- Sources đang xử lý (processing > 5 phút = nghi vấn bị kẹt)
SELECT id, title, status, pipeline_phase, progress_message, updated_at
FROM sources
WHERE status IN ('processing', 'pending')
ORDER BY updated_at ASC;

-- Sources bị lỗi
SELECT id, title, status, progress_message, error_message, updated_at
FROM sources
WHERE status = 'error'
ORDER BY updated_at DESC
LIMIT 20;

-- Draft wiki đang chờ trong queue
SELECT COUNT(*) AS drafts_pending
FROM wiki_page_drafts
WHERE status = 'pending';

-- Compilation plans chờ duyệt
SELECT COUNT(*) AS plans_pending
FROM source_compilation_plans
WHERE status = 'pending';

-- Tổng quan sources theo status
SELECT status, COUNT(*) FROM sources GROUP BY status ORDER BY status;
```

---

## 10.2 Rate limit OpenAI

### Triệu chứng

Trong log `arkon_worker`:

```
RateLimitError: Error code: 429 - Rate limit reached for gpt-4o-mini
```

Queue depth tăng nhưng không giảm; sources mắc kẹt ở `processing` với `progress_message` kiểu `"Calling LLM..."`.

### Thông tin tier

Tier 1 của OpenAI cho `gpt-4o-mini`: **200 000 TPM** (tokens per minute). Bulk upload nhiều file lớn cùng lúc sẽ chạm limit này.

### Mitigation ngay lập tức

Script `tmp/bulk-upload.sh` đã tích hợp retry tự động: khi nhận HTTP 429, nó sleep 60 giây rồi thử lại, tối đa 5 lần. Đây là hành vi mặc định — không cần can thiệp thủ công khi đang chạy bulk.

Nếu worker gặp rate limit trong pipeline (không qua bulk script), nguồn gốc là các task arq đang xử lý song song:

1. Dừng tạm worker để queue không tiếp tục chạy: `docker stop arkon_worker`
2. Đợi 2-3 phút để TPM bucket reset.
3. Khởi động lại: `docker start arkon_worker`

### Dài hạn

Nếu volume upload định kỳ cao (> 500 file/ngày hoặc file lớn nhiều trang), nâng lên Tier 2 trên OpenAI dashboard. Không cần thay đổi code.

---

## 10.3 Xử lý source bị kẹt

### Source stuck ở trạng thái `processing`

Nếu một source ở `processing` hơn 5 phút mà không có progress update:

```bash
# Xem chi tiết source
docker exec arkon_postgres psql -U arkon -d arkon \
  -c "SELECT id, title, status, pipeline_phase, progress, progress_message, updated_at FROM sources WHERE status='processing';"
```

Dùng retry endpoint để enqueue lại (không cần vào DB):

```bash
curl -X POST http://localhost:5055/api/sources/<SOURCE_ID>/retry \
  -H "Authorization: Bearer <TOKEN>"
```

Retry policy của endpoint này:
- `error` hoặc `plan_ready` → luôn retry được
- `processing` / `pending` → chỉ retry khi stale (không có update >= 5 phút)
- `ready` → không retry (đã hoàn thành)

### Source ở trạng thái `error`

```bash
# Xem error message cụ thể
docker exec arkon_postgres psql -U arkon -d arkon \
  -c "SELECT id, title, progress_message, error_message FROM sources WHERE status='error' ORDER BY updated_at DESC LIMIT 10;"
```

- Nếu lỗi là rate limit → đợi rồi retry qua endpoint trên
- Nếu lỗi là file corrupt / unsupported format → xóa source và upload lại
- Nếu lỗi DB hoặc MinIO → kiểm tra container health trước, rồi retry

---

## 10.4 Force re-run REFINE phase (advanced)

Dùng khi một source đã qua MAP/REDUCE nhưng REFINE bị lỗi giữa chừng và retry thông thường không đủ vì plan đã có `_page_drafts` nửa vời.

**Bước 1 — Cập nhật DB trực tiếp** (thay `<SOURCE_ID>` bằng UUID thực):

```sql
-- Reset pipeline về đầu phase refine
UPDATE sources
SET pipeline_phase = 'refine',
    progress = 75,
    status = 'pending'
WHERE id = '<SOURCE_ID>';

-- Xóa partial drafts trong plan để REFINE chạy lại sạch
UPDATE source_compilation_plans
SET plan_json = plan_json - '_page_drafts',
    status = 'approved'
WHERE source_id = '<SOURCE_ID>';
```

**Bước 2 — Enqueue task** qua retry endpoint:

```bash
curl -X POST http://localhost:5055/api/sources/<SOURCE_ID>/retry \
  -H "Authorization: Bearer <TOKEN>"
```

Endpoint sẽ detect `pipeline_phase = 'refine'` và enqueue `ingest_refine_task` đúng.

Hoặc enqueue trực tiếp qua arq nếu cần bypass endpoint:

```python
# Chạy trong arkon_api container
docker exec -it arkon_api python3 -c "
import asyncio
from arq.connections import create_pool
from app.worker import _get_redis_settings
async def main():
    pool = await create_pool(_get_redis_settings())
    job = await pool.enqueue_job('ingest_refine_task', '<SOURCE_ID>')
    print('Job ID:', job.job_id)
asyncio.run(main())
"
```

---

## 10.5 Backup & restore

### Backup DB

```bash
# Tạo backup với timestamp
docker exec arkon_postgres pg_dump -U arkon arkon > backup-$(date +%F).sql
```

### Backup MinIO (file objects)

```bash
docker exec arkon_minio mc mirror --no-overwrite minio/arkon-files ./backup-files/
```

### Restore DB

```bash
# CẢNH BÁO: sẽ ghi đè dữ liệu hiện tại
docker exec -i arkon_postgres psql -U arkon -d arkon < backup-2026-05-27.sql
```

Trước khi restore, stop API và worker để tránh write conflict:

```bash
docker stop arkon_api arkon_worker
# restore
docker start arkon_api arkon_worker
```

### Lịch backup tự động

Thêm cron job trên host (crontab -e):

```cron
# Backup nightly 2:00 AM, giữ 30 ngày
0 2 * * * docker exec arkon_postgres pg_dump -U arkon arkon > /opt/arkon-backups/arkon-$(date +\%F).sql
0 3 * * * find /opt/arkon-backups -name "*.sql" -mtime +30 -delete
```

---

## 10.6 Scripts inventory

Tất cả scripts chạy bên trong container `arkon_api`. Cú pháp chung:

```bash
docker exec arkon_api python -m app.scripts.<tên_module>
```

### `seed_school_setup`

Tạo phòng ban và role template cho triển khai trường học tư thục Việt Nam. Idempotent — chỉ tạo khi chưa tồn tại, không ghi đè row đã có. Chạy một lần sau khi deploy lần đầu, hoặc sau khi reset database.

```bash
docker exec arkon_api python -m app.scripts.seed_school_setup
```

### `seed_school_knowledge_types`

Thay thế 5 knowledge type mặc định bằng 15 knowledge type dành cho trường học. Remap các reference hiện có sang slug mới trước khi xóa type cũ. Chạy sau `seed_school_setup`.

```bash
docker exec arkon_api python -m app.scripts.seed_school_knowledge_types
```

### `generate_employees_template`

Tạo file Excel template (`employees_import_template.xlsx`) cho phòng nhân sự điền danh sách nhân viên. File có 4 sheet: danh sách điền, hướng dẫn, danh mục phòng ban, danh mục vai trò (lấy live từ DB).

```bash
docker exec arkon_api python -m app.scripts.generate_employees_template
docker cp arkon_api:/app/employees_import_template.xlsx ./tmp/
```

### `import_employees`

Bulk import nhân viên từ file Excel do phòng nhân sự điền (theo template trên). Idempotent — email đã tồn tại thì bỏ qua. Output là file kết quả có cột trạng thái và mật khẩu đã tạo.

```bash
docker cp ./tmp/employees_import.xlsx arkon_api:/app/
docker exec arkon_api python -m app.scripts.import_employees
docker cp arkon_api:/app/employees_import_result.xlsx ./tmp/
```

File kết quả chứa mật khẩu plaintext — xóa sau khi đã chuyển credentials qua kênh bảo mật.

### `cleanup_role_permissions`

Migrate permissions của tất cả role hiện có qua `LEGACY_PERMISSION_MAP`. Dùng khi UI báo lỗi "Unknown permissions" khi cố sửa role — thường xảy ra sau khi nâng cấp từ deployment cũ.

```bash
docker exec arkon_api python -m app.scripts.cleanup_role_permissions
```

### `reset_employee_role`

Reset system role "Employee" về baseline `EMPLOYEE_DEFAULT_PERMISSIONS`. Dùng khi phát hiện role Employee có quá nhiều quyền (god-mode) từ deployment cũ — đây là lỗ hổng privilege escalation nghiêm trọng.

```bash
docker exec arkon_api python -m app.scripts.reset_employee_role
```

### `reset_wiki_and_sources` — NGUY HIỂM

Xóa toàn bộ sources, wiki pages, drafts, embeddings và MinIO objects dưới prefix `sources/`. Dữ liệu được giữ lại: departments, employees, roles, workspaces, knowledge types, audit log, org settings.

**Bắt buộc backup trước khi chạy:**

```bash
docker exec arkon_postgres pg_dump -U arkon arkon > backup-before-reset-$(date +%F-%H%M).sql
docker exec arkon_api python -m app.scripts.reset_wiki_and_sources
```

### Tools trong `tmp/`

| Script | Mô tả |
|---|---|
| `bulk-upload.sh` | Upload hàng loạt file `.md` từ folder, tự động poll pipeline và approve plan. Retry rate limit 60s × 5. |
| `bulk-reupload-4.sh` | Variant của bulk-upload dành cho re-upload batch thứ 4 (scope/params cố định). |

Cú pháp `bulk-upload.sh`:

```bash
./tmp/bulk-upload.sh <folder> <kt-slug> <dept-name> [start-idx] [end-idx]

# Ví dụ
./tmp/bulk-upload.sh /data/dao-tao-noi-bo tuyen-sinh 'Phòng Tuyển Sinh' 1 50
```

---

## 10.7 Lỗi thường gặp & cách fix

### "unknown permission: X" khi sửa role

Nguyên nhân: DB còn lưu aggregate legacy key (ví dụ `departments.manage`) mà validator mới không nhận. Chạy:

```bash
docker exec arkon_api python -m app.scripts.cleanup_role_permissions
```

Sau đó thử lại thao tác trên UI.

### 404 trên endpoint `/wiki/.../revisions` khi slug có dấu `/`

Đã fix bằng cách mount `wiki_revisions` router trước router wiki chính trong `app/main.py`. Nếu gặp lại sau update → kiểm tra thứ tự router trong `main.py`.

### Race condition khi tạo employee

Khi gọi API tạo employee rồi ngay lập tức gọi thêm operation liên quan (ví dụ gán role) có thể gặp lỗi 404 hoặc FK violation. Thêm delay 100ms giữa hai request từ phía client.

### Wiki page mồ côi sau khi xóa workspace

Source gắn với workspace bị xóa nhưng wiki page vẫn còn. Cascade thủ công:

```sql
-- Tìm wiki pages không còn source nào trỏ tới
SELECT wp.id, wp.title FROM wiki_pages wp
LEFT JOIN sources s ON s.id = wp.source_id
WHERE s.id IS NULL AND wp.source_id IS NOT NULL;

-- Xóa nếu xác nhận không cần giữ
DELETE FROM wiki_pages WHERE id IN ('<id1>', '<id2>');
```

### Source PATCH scope không trigger re-ingest

Khi sửa scope của source qua PATCH, pipeline không tự chạy lại nếu source đã ở trạng thái `ready`. Trigger thủ công:

```bash
curl -X POST http://localhost:5055/api/sources/<SOURCE_ID>/retry \
  -H "Authorization: Bearer <TOKEN>"
```

---

## 10.8 Performance tips

**pgvector HNSW index** — bật khi corpus > 10 000 wiki pages để giảm latency tìm kiếm:

```sql
CREATE INDEX ON wiki_page_embeddings_1536
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

**Tăng candidate pool** khi recall thấp — sửa `candidate_pool=50` trong config hybrid search (mặc định 20). Áp dụng khi kết quả tìm kiếm thiếu tài liệu liên quan rõ ràng.

**Embedding model** — hệ thống đang dùng `text-embedding-3-small` 1536 dimensions. Đủ cho tiếng Việt với corpus quy mô trường học (< 100K pages). Không cần upgrade trừ khi recall về ngữ nghĩa quá tệ sau khi đã tăng candidate pool.

---

## 10.9 Incident response flow

```
PHÁT HIỆN
    │
    ├─ Alert từ monitoring / user report / log error
    │
    ▼
TRIAGE (< 5 phút)
    │
    ├─ docker logs --since 1h arkon_api | arkon_worker
    ├─ curl http://localhost:5055/health
    ├─ LLEN arq:queue > ngưỡng?
    ├─ Sources stuck / error trong DB?
    │
    ▼
FIX
    │
    ├─ Rate limit     → stop worker, đợi 2-3 phút, restart
    ├─ Stuck source   → POST /sources/{id}/retry
    ├─ Error source   → xem progress_message → retry hoặc re-upload
    ├─ Container down → docker start <container>
    ├─ DB corruption  → restore từ backup gần nhất
    │
    ▼
VERIFY
    │
    ├─ curl /health trả OK
    ├─ Sources stuck giảm về 0
    ├─ Queue depth giảm
    ├─ Smoke test: upload 1 file thử
    │
    ▼
POSTMORTEM
    │
    └─ Ghi lại timeline, nguyên nhân gốc, action item
       vào incidents/<YYYY-MM-DD>-<title>.md
```

---

*Cập nhật lần cuối: 2026-05-27. Owner: @ops-team.*
