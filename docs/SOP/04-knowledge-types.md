<!-- Section 04 / 10 — Knowledge Types. Một phần của Arkon SOP. -->

# 04 — Knowledge Types

Knowledge Types (KT) là hệ thống tag phân loại tri thức trong Arkon. Mỗi source và wiki page có thể gắn 0 hoặc nhiều KT slug. Hệ thống dùng danh sách slug này làm gate truy cập: MCP token chỉ thấy nội dung có KT nằm trong phạm vi được cấp phép.

---

## Khái niệm cơ bản

Một KT có bốn trường chính:

| Trường | Kiểu | Ví dụ |
|---|---|---|
| `slug` | `varchar(50)`, unique | `tuyen-sinh` |
| `name` | `varchar(100)` | `Tuyển Sinh` |
| `color` | hex color | `#ec4899` |
| `description` | text, tuỳ chọn | "Brochure, hồ sơ ứng viên..." |

Slug là định danh kỹ thuật — được dùng trong database, API query, và MCP token scope. Name là nhãn hiển thị trên UI.

Một source được gán đúng một KT qua `knowledge_type_id` (foreign key). Khi source được index, các wiki page sinh ra từ source đó sẽ inherit slug của KT đó vào mảng `knowledge_type_slugs` (Postgres `text[]`). Wiki page có thể mang nhiều slug nếu được gán thêm về sau.

---

## KT mặc định và KT trường học

### Trước migration

Hệ thống khởi động với 5 KT mặc định:

| Slug | Tên |
|---|---|
| `general` | General |
| `sop` | SOP |
| `product` | Product |
| `project` | Project |
| `customer` | Customer |

Các slug này mang tính placeholder — không phản ánh nghiệp vụ thực tế của trường học.

### Sau khi chạy `seed_school_knowledge_types.py`

Script thay thế 5 KT mặc định bằng 15 KT nghiệp vụ trường học. Danh sách đầy đủ theo thứ tự `sort_order`:

| `sort_order` | Slug | Tên hiển thị | Màu |
|---|---|---|---|
| 0 | `tai-lieu-chung` | Tài liệu chung | `#64748b` |
| 10 | `quy-trinh-sop` | Quy trình SOP | `#0ea5e9` |
| 20 | `chinh-sach` | Chính sách | `#8b5cf6` |
| 30 | `bieu-mau` | Biểu mẫu | `#10b981` |
| 40 | `hop-dong` | Hợp đồng | `#f59e0b` |
| 50 | `phap-ly` | Pháp lý - Văn bản | `#dc2626` |
| 60 | `chuong-trinh-day` | Chương trình giảng dạy | `#3b82f6` |
| 70 | `ket-qua-hoc-tap` | Kết quả học tập | `#06b6d4` |
| 80 | `tai-chinh` | Tài chính - Học phí | `#eab308` |
| 90 | `tuyen-sinh` | Tuyển sinh | `#ec4899` |
| 100 | `marketing-truyen-thong` | Marketing - Truyền thông | `#f97316` |
| 110 | `su-kien` | Sự kiện - Tổ chức | `#a855f7` |
| 120 | `nhan-su` | Nhân sự - HR | `#14b8a6` |
| 130 | `y-te-an-toan` | Y tế - An toàn | `#22c55e` |
| 140 | `ky-thuat-it` | Kỹ thuật - IT | `#6366f1` |

Script remap các slug cũ sang slug mới trước khi xoá:

| Slug cũ | Slug mới |
|---|---|
| `general` | `tai-lieu-chung` |
| `sop` | `quy-trinh-sop` |
| `product` | `tai-lieu-chung` |
| `project` | `su-kien` |
| `customer` | `tai-lieu-chung` |

Remap được thực hiện trực tiếp trên `sources.knowledge_type_id` (FK) và `wiki_pages.knowledge_type_slugs` (Postgres `array_replace`). Script idempotent — chạy lại không gây lỗi.

---

## KT gating qua MCP token

Mỗi MCP token lưu một danh sách `allowed_knowledge_types` (có thể `null`). Logic gating trong `app/mcp/tools.py`:

- **`null`** — token không bị giới hạn theo KT (thường là admin hoặc token không có scope KT).
- **`[]` (danh sách rỗng)** — token không được phép đọc bất kỳ KT nào.
- **`['tuyen-sinh', 'tai-chinh']`** — token chỉ thấy sources và wiki pages có ít nhất một slug overlap với danh sách này.

Filter được áp dụng ở tầng database: `knowledge_type_slugs && allowed_knowledge_types` (Postgres array overlap operator). Kết quả là những bản ghi có `knowledge_type_slugs` hoàn toàn trống (chưa phân loại) cũng sẽ bị lọc ra khi token có scope KT.

**Ví dụ thực tế:**

```
Token "Claude Tuyển Sinh"
  allowed_knowledge_types: ["tuyen-sinh"]
  → Đọc được: sources/wiki có tag "tuyen-sinh"
  → Không thấy: tài liệu "Kết quả học tập", "Tài chính - Học phí", v.v.

Token "Claude Kế Toán"
  allowed_knowledge_types: ["tai-chinh"]
  → Đọc được: hóa đơn, ngân sách, báo cáo thu chi

Token "Claude Admin"
  allowed_knowledge_types: null (hoặc is_admin: true)
  → Đọc được: tất cả
```

---

## Lifecycle của một KT

### 1. Tạo KT mới

**Qua API:**

```bash
curl -X POST https://<host>/api/knowledge-types \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Dinh Dưỡng",
    "slug": "dinh-duong",
    "color": "#84cc16",
    "description": "Thực đơn, tiêu chuẩn dinh dưỡng bếp ăn bán trú."
  }'
```

Endpoint `POST /api/knowledge-types` yêu cầu permission `documents.create`. Nếu không truyền `slug`, hệ thống tự sinh từ `name` bằng cách lowercase và strip ký tự đặc biệt.

**Qua seed script (môi trường staging/production mới):**

Thêm entry vào `SCHOOL_KTS` trong `app/scripts/seed_school_knowledge_types.py` rồi chạy:

```bash
docker exec arkon_api python -m app.scripts.seed_school_knowledge_types
```

### 2. Gán KT vào source

Khi upload source, chọn KT từ dropdown. Trường `knowledge_type_id` là UUID của KT đã chọn. Sau khi ingestion hoàn tất, các wiki page được sinh ra sẽ có `knowledge_type_slugs = ["{kt_slug}"]`.

### 3. Cập nhật KT trên source

`PUT /api/knowledge-types/{kt_id}` cho phép đổi `name`, `slug`, `color`, `description`. Thay đổi `slug` không tự cascade vào `wiki_pages.knowledge_type_slugs` — nếu cần đồng bộ, dùng câu lệnh `array_replace` tương tự trong seed script.

### 4. Xoá KT

`DELETE /api/knowledge-types/{kt_id}` — sources đang dùng KT này sẽ có `knowledge_type_id` set về `NULL`. Wiki pages giữ nguyên slug cũ trong mảng (orphaned slug). Nên remap trước khi xoá.

---

## Best practice đặt tên

**Slug** — kebab-case, không dấu, không khoảng trắng:

```
tuyen-sinh          ✓
Tuyển Sinh          ✗
tuyen_sinh          ✗ (dùng gạch ngang, không gạch dưới)
tuyensinh           ✗ (khó đọc khi slug dài)
```

**Name** — tiếng Việt có dấu, ngắn gọn, dưới 30 ký tự:

```
"Tuyển Sinh"               ✓
"Bộ phận Tuyển Sinh"       ✗ (quá dài, lẫn với tên phòng ban)
"tuyen-sinh"               ✗ (đây là slug, không phải name)
```

Mỗi KT nên phản ánh **loại tài liệu**, không phải tên phòng ban. Phòng Tài chính dùng KT `tai-chinh`; Phòng Nhân sự dùng KT `nhan-su` — nhưng một tài liệu về hợp đồng lao động nên dùng `hop-dong`, không phải `nhan-su`.

---

## Endpoints tham chiếu nhanh

| Method | Path | Permission | Mô tả |
|---|---|---|---|
| `GET` | `/api/knowledge-types` | Không cần | Liệt kê tất cả KT, kèm `source_count` |
| `POST` | `/api/knowledge-types` | `documents.create` | Tạo KT mới |
| `PUT` | `/api/knowledge-types/{id}` | `documents.edit` | Cập nhật KT |
| `DELETE` | `/api/knowledge-types/{id}` | `documents.delete` | Xoá KT |
| `PATCH` | `/api/knowledge-types/reorder` | `documents.edit` | Sắp xếp lại thứ tự hiển thị |
