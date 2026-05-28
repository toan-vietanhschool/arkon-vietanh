<!-- Section 09 / 10 — Quy trình theo role. Một phần của Arkon SOP. -->

# 09 — Quy trình vận hành theo role

Section này mô tả **quy trình hàng ngày và hàng tuần** của từng vai trò trong Arkon. Không nhắc lại khái niệm RBAC (xem Section 03) hay hướng dẫn cài đặt ban đầu (xem Section 02).

---

## System Admin — flow hàng tuần

System Admin là tài khoản có `Employee.role = 'admin'` — bypass mọi permission check, tự động là admin của mọi workspace.

### Onboard nhân sự mới

1. Vào **Employees → Add Employee**, điền họ tên, email, phòng ban.
2. Chọn `System role: employee` (mặc định — không grant `admin` trừ khi thực sự cần).
3. Gán **Custom role** phù hợp với chức danh. Ví dụ: giáo viên Khối Tiểu Học → role `Giáo viên`, phòng ban `Khối Tiểu Học`.
4. Hệ thống tự sinh mật khẩu tạm. Chuyển credentials cho nhân viên qua kênh bảo mật (không qua email công khai).

Onboard hàng loạt (>10 người): dùng Excel template flow — xem Section 02 cho lệnh `import_employees`. Kết quả ghi ra file `employees_import_result.xlsx` chứa mật khẩu sinh tự động; xóa file sau khi đã phân phối credentials.

### Tạo workspace mới

Workspace (project) được tạo **theo sáng kiến** — không tạo sẵn cho mọi phòng ban. Ví dụ phù hợp: `ws-tuyensinh-2026`, `ws-le-khai-giang`, `ws-dao-tao-giao-vien`.

1. Vào **Projects → New Project**, đặt tên rõ nghĩa kèm năm học hoặc mùa vụ.
2. Add members, gán workspace role phù hợp (`viewer` / `contributor` / `editor` / `admin`).
3. Gán các source hiện có nếu workspace cần kế thừa tài liệu từ phòng ban.

### Cấp MCP token

1. Vào **Settings → MCP Tokens → Issue Token**.
2. Chọn **scope theo Knowledge Type slug** — ví dụ token cho giáo viên khối THCS chỉ cần scope `giao-duc`, không cần `ke-toan` hay `nhan-su`.
3. Chia sẻ token qua kênh bảo mật. Token không thể đọc lại sau khi đóng modal — nếu mất, thu hồi và phát lại.
4. Hướng dẫn nhân viên cấu hình Claude Desktop theo Section 07.

### Review hàng tuần

Mỗi thứ Hai kiểm tra:

| Hạng mục | Nơi xem | Hành động nếu có vấn đề |
|---|---|---|
| Source đang `pending` / `processing` > 24h | Sources → filter by status | Kiểm tra log worker, restart nếu cần |
| Draft wiki tồn đọng > 7 ngày | Wiki → Drafts queue | Nhắc editor phòng ban liên quan |
| Source status `error` | Sources → filter `error` | Xem error message, re-upload hoặc escalate lên IT |
| MCP token sắp hết hạn | Settings → MCP Tokens | Gia hạn hoặc phát token mới |

Backup DB: xem script và lịch cron ở Section 10.

---

## Migration đơn vị mới (ví dụ: thêm trường con)

Khi tổ chức mở rộng thêm một đơn vị học thuật hoặc chi nhánh mới:

1. **Tạo department** — Vào Organization → Departments → Add. Đặt tên khớp với tên chính thức của đơn vị.
2. **Copy role templates** — Chạy lại `seed_school_setup.py` nếu cần thêm role mẫu cho bộ phận đó; script idempotent, không ghi đè role đã tồn tại.
3. **Tạo workspace** nếu đơn vị mới có dự án riêng cần cách ly nguồn dữ liệu.
4. **Seed Knowledge Type slug** mới nếu đơn vị có loại tài liệu chưa có slug (xem Section 04 về quy tắc đặt slug).
5. Onboard nhân sự theo quy trình ở trên, gán đúng phòng ban mới.

---

## Editor — quy trình phòng ban (ví dụ: Phòng Tuyển Sinh)

Editor tương đương với role `Trưởng phòng / Tổ trưởng` hoặc `Chuyên viên hành chính` được giao quyền `wiki:write:own_dept` + workspace role `editor`.

### Upload tài liệu nội bộ

1. Chuẩn bị file: PDF, DOCX, hoặc TXT. Tên file nên gợi nhớ nội dung — hệ thống dùng tên file làm title mặc định.
2. Vào **Sources → Upload**, chọn **Knowledge Type** phù hợp (ví dụ `tuyen-sinh`), chọn phòng ban `Phòng Tuyển Sinh`.
3. Hệ thống enqueue job vào worker. Trạng thái chuyển: `pending` → `processing` → `indexed` (hoặc `error`).
4. Khi status = `indexed`: vào **Wiki** kiểm tra các trang vừa được tạo từ source đó. Đọc lướt để xác nhận pipeline không sinh ra nội dung sai lệch trước khi thông báo cho team.

### Review draft từ contributor

Contributor (giáo viên, chuyên viên) đề xuất sửa wiki qua draft. Flow:

```
[Contributor propose] → draft "pending"
        ↓
[Editor review_draft(draft_id)]  — đọc diff proposed vs current
        ↓
   ┌────────────────────────────────────┐
   │ Approve?  → approve_draft(...)    │
   │ Cần sửa?  → request_changes(...)  │  → draft "needs_revision" → contributor resubmit
   │ Reject?   → reject_draft(...)     │  (cần lý do rõ ràng)
   └────────────────────────────────────┘
```

Dùng Claude với skill `arkon-review` để duyệt nhanh: prompt `"review drafts cho phòng Tuyển Sinh"` sẽ trigger `list_pending_drafts` lọc theo workspace hoặc phòng ban.

**Quy tắc:** không self-approve (server chặn). Nếu chỉ có một editor trong phòng ban, nhờ editor phòng khác hoặc admin duyệt.

### Maintain wiki tree

Hàng tháng hoặc sau mỗi đợt upload lớn:

- **Rename page**: sửa title trực tiếp qua `edit_wiki_page` (giữ nguyên slug để không gãy backlink).
- **Fix dangling link**: dùng `search_wiki` tìm trang có wikilink `[[slug]]` trỏ đến slug không tồn tại; sửa hoặc xóa link.
- **Regenerate index**: wiki index (`_index`) được pipeline tự cập nhật — nếu thấy lỗi thời, re-index bằng cách upload lại source hoặc nhờ admin trigger re-process.

---

## Contributor — quy trình hàng ngày

Contributor tương đương role `Giáo viên`, `Chuyên viên hành chính`, hoặc bất kỳ role nào có `wiki:write:own_dept` nhưng không có quyền approve draft.

### Đọc wiki và propose edit

1. Dùng Claude Desktop với MCP token — trigger skill `arkon-query`:
   - `"what do we know about phẩm chất SO"` → Claude gọi `search_wiki`, đọc pages liên quan.
2. Khi thấy thông tin sai hoặc cần bổ sung, trigger skill `arkon-edit`:
   - `"đề xuất sửa wiki concept/quy-tac-vang"` → Claude đọc trang hiện tại, draft edit, xin xác nhận, gọi `propose_wiki_edit`.
3. Theo dõi draft ID được trả về. Khi editor gửi `request_changes`, Claude có thể resubmit sau khi bạn xác nhận nội dung sửa đổi.

### Upload source vào workspace

Contributor có thể upload source vào workspace mà mình là member (workspace role `contributor` trở lên) — không upload lên global hoặc phòng ban khác:

1. Vào **Projects → [Workspace] → Sources → Add Source**.
2. Chọn file và Knowledge Type. Source chỉ visible trong workspace đó.
3. Chờ status `indexed` trước khi dùng nội dung trong Claude.

---

## Reader — quy trình tra cứu

Reader tương đương role `Trợ giảng`, `Khách / Phụ huynh đại diện`, hoặc bất kỳ tài khoản nào chỉ có `doc:read:own_dept` + `wiki:read:own_dept`.

### Tra cứu qua Claude Desktop

Với MCP token đã cấu hình (xem Section 07):

| Mục tiêu | Prompt mẫu | Skill kích hoạt |
|---|---|---|
| Tìm thông tin cụ thể | `"what do we know about lịch tuyển sinh 2026"` | `arkon-query` |
| Duyệt theo chủ đề | `"find in KB: quy định học bổng"` | `arkon-query` |
| Tìm văn bản gốc | `"query deep: tiêu chí xét tuyển lớp 10"` | `arkon-query` (deep mode) |

**Best practice:** dùng từ khóa tiếng Việt nếu tài liệu gốc bằng tiếng Việt — search_wiki xử lý tốt hơn với ngôn ngữ khớp với nội dung. Câu hỏi càng cụ thể, kết quả càng chính xác.

### Khi gặp "Access denied" hoặc "Out-of-scope"

Nội dung tồn tại nhưng ngoài phạm vi MCP token của bạn. Liên hệ System Admin để:
- Mở rộng scope token (thêm KT slug), hoặc
- Được add vào workspace chứa nội dung đó.

---

## Use case: Claude qua MCP

Setup Claude Desktop: xem Section 07. Các skill sau được kích hoạt tự động theo trigger phrase:

### arkon-query

Tra cứu tri thức từ wiki. Không cần quyền đặc biệt — mọi tài khoản có MCP token đều dùng được trong phạm vi scope.

```
"what do we know about phẩm chất SO"
"find in KB: quy trình nhập học"
"query deep: toàn bộ quy định về học bổng"
```

### arkon-edit

Đề xuất (contributor) hoặc ghi trực tiếp (editor/admin) chỉnh sửa wiki.

```
"đề xuất sửa wiki concept/quy-tac-vang"
"update wiki page tuyen-sinh/ho-so-yeu-cau: bổ sung điểm mới"
"propose new page cho topic lịch-khai-giang-2027"
```

Skill luôn xin xác nhận trước khi submit — không tự ý đẩy thay đổi.

### arkon-review

Duyệt draft trong queue. Chỉ dành cho editor và admin.

```
"review drafts cho phòng Tuyển Sinh"
"approve draft abc-123"
"send draft xyz back với ghi chú cần bổ sung nguồn"
```

---

## Use case: Bulk operations

### Import 100+ nhân viên

Xem Section 02 cho lệnh đầy đủ. Tóm tắt:

1. Tải template Excel từ `app/scripts/generate_employees_template.py`.
2. Điền sheet "Nhân viên" — tên phòng ban và tên role phải **khớp chính xác** (case-sensitive) với dữ liệu trong hệ thống.
3. Copy file vào container và chạy script:
   ```bash
   docker cp ./tmp/employees_import.xlsx arkon_api:/app/
   docker exec arkon_api python -m app.scripts.import_employees
   docker cp arkon_api:/app/employees_import_result.xlsx ./tmp/
   ```
4. Mở file kết quả — dòng màu đỏ cần xử lý tay, dòng vàng đã bỏ qua (email trùng), dòng xanh thành công.
5. Xóa file kết quả sau khi đã phân phối credentials — file chứa mật khẩu plaintext.

### Bulk upload tài liệu đào tạo

Dùng script `tmp/bulk-upload.sh` (nếu IT team đã chuẩn bị). Nếu chưa có, upload thủ công theo lô không quá 20 file mỗi lần để dễ theo dõi trạng thái index.

---

## Lifecycle tài liệu — sơ đồ tổng thể

```
Tài liệu mới
     │
     ▼
[Upload source] ──────────────────── permission: doc:create:own_dept
     │
     ▼
[MAP] Phân loại, trích xuất cấu trúc
     │
     ▼
[PLAN] Lập kế hoạch wiki pages sẽ tạo
     │
     ▼
[REFINE] Sinh nội dung wiki, tạo embedding
     │
     ▼
[indexed] → Wiki pages available ──── reader/contributor có thể tra cứu
     │
     │── Contributor thấy nội dung sai
     │         │
     │         ▼
     │   [propose_wiki_edit] ─── draft "pending"
     │         │
     │         ▼
     │   [Editor review] ─────── approve / request_changes / reject
     │         │
     │         ▼ (approve)
     │   [Wiki updated] ── revision ghi vào history
     │
     │── Tài liệu lỗi thời
     │         │
     │         ▼
     │   [Contributor propose edit] → Editor approve → wiki cập nhật
     │
     └── Tài liệu obsolete
               │
               ▼
         [Archive source] ──── KHÔNG xóa (policy bảo toàn dữ liệu)
               │               source status = "archived"
               ▼               wiki pages giữ nguyên, có thể ẩn khỏi
         [Thông báo team]      index nếu cần bằng cách untag KT slug
```

### Permission gates tại mỗi bước

```
Upload source       ← doc:create:own_dept  (contributor, editor, admin)
View indexed wiki   ← wiki:read:own_dept   (reader và trên)
Propose edit        ← wiki:write:own_dept  (contributor và trên)
Approve draft       ← workspace editor+ hoặc wiki:write:all
Delete wiki page    ← wiki:delete:own_dept (editor của phòng ban)
Archive source      ← doc:delete:own_dept  (department admin trở lên)
View all sources    ← doc:read:all         (admin, Hiệu trưởng, Thủ thư)
```

---

> Section tiếp theo: **Section 10 — Backup, monitoring và maintenance.**
