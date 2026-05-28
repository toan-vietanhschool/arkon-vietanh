<!-- Section 01 / 10 — Tổng quan & thuật ngữ. Một phần của Arkon SOP. -->

# 01. Tổng quan Arkon

## Mục tiêu hệ thống

Arkon là nền tảng quản lý tri thức doanh nghiệp tự triển khai (self-hosted). Thay vì để nhân viên copy-paste tài liệu vào chatbot, Arkon biên dịch toàn bộ tài liệu nội bộ thành một wiki có cấu trúc — rồi phục vụ wiki đó cho Claude và các AI client khác qua một MCP server duy nhất, với phân quyền theo phòng ban và workspace.

Arkon phù hợp nhất với các tổ chức có **dữ liệu nội bộ cần kiểm soát truy cập theo vai trò**, ví dụ:
- Trường học (quy trình tuyển sinh, học bạ, quy định học vụ — phân theo phòng ban)
- SaaS nội bộ (runbook, SOP kỹ thuật, tài liệu sản phẩm — phân theo workspace)
- Doanh nghiệp có nhiều phòng ban với dữ liệu cần cách ly

---

## Kiến trúc tổng thể

```
┌──────────────────────────────────────────────────────────────────┐
│                         On-Premise Server                        │
│                                                                  │
│   ┌──────────────────┐          ┌──────────────────────────────┐ │
│   │  Admin Portal    │  REST    │       Arkon API (FastAPI)    │ │
│   │  (Next.js)       │ ──────►  │  /api/*   REST endpoints     │ │
│   └──────────────────┘          │  /mcp     MCP server         │ │
│                                 │  /docs    Swagger UI         │ │
│                                 └────────────┬─────────────────┘ │
│                                              │                   │
│   ┌─────────────────┐  ┌─────────────────┐  │                   │
│   │  Wiki Worker    │  │  Skill Worker   │  │                   │
│   │  (arq/Redis)    │  │  (arq/Redis)    │  │                   │
│   │  · ingest       │  │  · skill pkg    │  │                   │
│   │  · MRP pipeline │  │    processing   │  │                   │
│   └────────┬────────┘  └────────┬────────┘  │                   │
│            │                    │            │                   │
│   ┌────────▼──────────────────────────────▼─┴──┐  ┌──────────┐ │
│   │   PostgreSQL + pgvector    Redis (queue)    │  │  MinIO   │ │
│   │   (wiki, sources, users,   (job queue +     │  │  (files) │ │
│   │    embeddings, RBAC)        caching)        │  └──────────┘ │
│   └────────────────────────────────────────────┘               │
│                                                                  │
│   AI Providers (external): Anthropic / Google / OpenAI          │
│   ▲ LLM + Embedding + Vision calls                              │
└──────────────────────────┬───────────────────────────────────────┘
                           │ MCP (HTTPS / Bearer token)
          ┌────────────────┼────────────────┐
          │                │                │
   Claude Desktop    Claude.ai         Any MCP client
   (employees)       (web)             (API integrations)
```

**Luồng dữ liệu chính:**
1. Người dùng upload tài liệu qua Admin Portal → API lưu file vào MinIO, enqueue job vào Redis
2. Wiki Worker kéo job, chạy MRP pipeline → ghi wiki pages vào PostgreSQL, tạo embedding bằng pgvector
3. Nhân viên dùng Claude Desktop → Claude gọi MCP server → API tra cứu wiki theo scope của token → trả kết quả

---

## Bảng thuật ngữ cốt lõi

### Source (tài liệu nguồn)

Tài liệu gốc được nạp vào Arkon — có thể là file upload (PDF, DOCX, TXT) hoặc URL. Source là nguyên liệu đầu vào cho MRP pipeline; sau khi pipeline hoàn tất, nội dung được biên dịch thành wiki pages. Source không bị xóa hay thay thế — wiki pages có thể được cập nhật khi có source mới.

> Ví dụ: File `quy-trinh-tuyen-sinh-2025.pdf` là một source. Sau khi xử lý, nó sinh ra các wiki pages như `entity/truong-thpt-nguyen-du` và `concept/ho-so-tuyen-sinh`.

### Wiki Page (trang wiki)

Trang nội dung đã được biên dịch từ một hoặc nhiều sources. Mỗi wiki page có `slug` (định danh URL), `title`, `content_md` (nội dung Markdown), và `embedding` (vector cho tìm kiếm ngữ nghĩa).

Có sáu `page_type`:

| Loại | Ý nghĩa |
|------|---------|
| `entity` | Thực thể cụ thể: người, tổ chức, sản phẩm, địa điểm |
| `concept` | Quy trình, quy tắc, phương pháp, khung làm việc |
| `topic` | Chủ đề rộng tổng hợp nhiều entity/concept liên quan |
| `source` | Trang đại diện cho chính tài liệu nguồn |
| `index` | Danh mục tự động (`_index`) — tổng hợp toàn bộ wiki |
| `log` | Nhật ký ingestion tự động (`_log`) — lịch sử biên dịch |

> Ví dụ: `concept/fire-safety` là trang loại `concept` mô tả quy trình phòng cháy chữa cháy, tổng hợp từ nhiều văn bản nội bộ.

### Wikilink `[[slug]]`

Cú pháp liên kết chéo giữa các wiki page trong nội dung Markdown, dạng `[[slug-cua-trang]]`. Arkon tự động extract các wikilink thành bảng `wiki_links`, tạo đồ thị tri thức với backlink và outlink. Wikilink bị broken (slug không tồn tại) được phát hiện ở bước L2 AI pre-review.

> Ví dụ: Trang `concept/fire-safety` có thể chứa `[[entity/phong-bao-ve]]` để liên kết đến trang về phòng bảo vệ.

### Scope (phạm vi truy cập)

Mọi resource (source, wiki page, skill) đều có scope xác định ai được xem. Có hai giá trị:

- `global` — bất kỳ nhân viên nào có quyền phù hợp đều xem được
- `project` — chỉ thành viên của workspace đó mới xem được (kèm `scope_id` là ID của workspace)

> Ví dụ: Tài liệu "Quy chế nội bộ toàn công ty" có `scope_type=global`; tài liệu "Roadmap Q3 của team Product" có `scope_type=project`, `scope_id=<workspace-id>`.

### Department (phòng ban)

Đơn vị tổ chức thuộc **global realm**. Departments dùng để gán quyền truy cập tài liệu toàn tổ chức — một source có thể được gán cho một hoặc nhiều department; source không gán cho department nào được coi là global (mọi người đều xem được với quyền phù hợp).

> Ví dụ: Department "Phòng Nhân sự" — các tài liệu nội quy nhân sự chỉ gán cho department này.

### Workspace / Project (workspace)

Không gian làm việc thuộc **local realm**, dành cho nhóm liên chức năng. Mỗi workspace có wiki riêng, danh sách source riêng, và roster thành viên riêng với role (viewer / contributor / editor / admin). Workspace trong code được gọi là `project` (bảng `projects`, endpoint `/api/projects/`).

> Ví dụ: Workspace "Dự án Tái cấu trúc Hệ thống Điểm" gồm thành viên từ phòng CNTT và phòng Học vụ, có wiki và tài liệu kỹ thuật riêng.

### Knowledge Type (KT — loại tri thức)

Nhãn phân loại gán cho source và wiki page, dùng như "gate" truy cập khi tra cứu qua MCP. MCP token của mỗi nhân viên được phép truy cập một tập `allowed_knowledge_types`. Khi Claude gọi `search_wiki`, server chỉ trả về các trang có `knowledge_type_slugs` nằm trong tập được phép.

> Ví dụ: Knowledge Type `hr-policy` (Chính sách nhân sự), `sop-technical` (SOP kỹ thuật). Nhân viên phòng Kỹ thuật được cấp token với `allowed_knowledge_types=["sop-technical"]` — họ không thấy tài liệu HR khi hỏi Claude.

### Identity (danh tính nhân viên)

Tài khoản nhân viên trong hệ thống. Có ba "tầng" định danh liên quan đến quyền:

- **Admin** — quản trị toàn bộ hệ thống, cấu hình AI provider, quản lý role
- **Member** — nhân viên có tài khoản, được gán role với permission set cụ thể trong global realm và/hoặc là thành viên workspace
- **Non-member** — không phải thành viên của workspace cụ thể, không truy cập được resource scope `project` của workspace đó dù là admin tổ chức

### MCP Server / MCP Token

**MCP server** là endpoint `/mcp` của Arkon API — phục vụ các AI client (Claude Desktop, Claude.ai) theo giao thức Model Context Protocol. **MCP token** là bearer token gắn với mỗi nhân viên, dùng để xác thực khi Claude gọi MCP. Token xác định danh tính nhân viên và scope được phép truy cập; plaintext không bao giờ lưu trong DB (chỉ lưu hash).

> Ví dụ: Nhân viên kết nối Claude Desktop với URL `https://arkon.truong.edu.vn/mcp` — Claude tự động xác thực qua OAuth 2.1 + PKCE, không cần copy-paste token thủ công.

### MRP Pipeline

Pipeline biên dịch tài liệu cốt lõi, tên đầy đủ: **MAP — REDUCE — PLAN-review — REFINE — VERIFY — COMMIT**. Chạy trong background worker (arq), gồm 6 phase (đánh số 0–5):

| Phase | Tên | Công việc |
|-------|-----|-----------|
| 0 | Triage | Phân loại chiến lược xử lý: `single_pass` / `standard` / `hierarchical` |
| 1 | MAP | Chia chunk theo heading → parallel LLM extraction từng chunk |
| 2 | REDUCE | Dedup entity → reconcile với KB → sinh Compilation Plan |
| 2.5 | Plan review | Editor duyệt plan trước khi viết trang |
| 3 | REFINE | Parallel page writers — viết nội dung wiki từng trang |
| 4 | VERIFY | Kiểm tra citation, coverage, conflict (non-blocking) |
| 5 | COMMIT | Ghi toàn bộ trang vào DB trong một atomic transaction |

Chi tiết từng phase — xem Section 05.

### RRF (Reciprocal Rank Fusion)

Thuật toán kết hợp kết quả từ nhiều phương pháp tìm kiếm song song (full-text search qua `tsvector` và semantic search qua `pgvector`) thành một danh sách xếp hạng duy nhất. Thay vì chọn một phương pháp, RRF cho điểm mỗi kết quả dựa trên vị trí của nó trong từng danh sách riêng lẻ, rồi cộng điểm lại.

> Mục tiêu: kết quả vừa khớp từ khóa vừa khớp ngữ nghĩa được đẩy lên đầu.

### tsvector / pgvector

Hai cơ chế tìm kiếm song song trong PostgreSQL:

- **tsvector** — kiểu dữ liệu PostgreSQL cho full-text search. Nội dung wiki page được lập chỉ mục dạng tsvector để tìm kiếm theo từ khóa nhanh.
- **pgvector** — PostgreSQL extension lưu trữ và tìm kiếm vector embedding (dense float array). Mỗi wiki page có một embedding vector; tìm kiếm ngữ nghĩa dùng cosine similarity trên cột này.

Cả hai được dùng kết hợp trong `search_wiki`, với RRF để hợp nhất kết quả.

---

## Glossary viết tắt

| Viết tắt | Ý nghĩa |
|----------|---------|
| **MCP** | Model Context Protocol — giao thức chuẩn để AI client giao tiếp với tool server |
| **MRP** | MAP-REDUCE-PLAN — tên gắn liền với pipeline biên dịch của Arkon |
| **KT** | Knowledge Type — loại tri thức, dùng như gate truy cập qua MCP |
| **RBAC** | Role-Based Access Control — phân quyền theo vai trò |
| **RRF** | Reciprocal Rank Fusion — thuật toán kết hợp xếp hạng tìm kiếm |
| **SO** | Student Officer — vai trò nhân viên học vụ trong triển khai trường học |
| **MA** | Management Admin — quản trị viên cấp tổ chức |
| **arq** | Thư viện Python job queue dựa trên Redis, dùng cho background workers của Arkon |
