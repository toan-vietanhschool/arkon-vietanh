<!-- Master index. Một phần của Arkon SOP. -->

# Arkon — Tài liệu vận hành chuẩn (SOP)

> **Mục đích**: Tài liệu này là quy trình chuẩn (Standard Operating Procedure) hoàn chỉnh cho hệ thống Arkon — knowledge management cho doanh nghiệp/trường học Việt Nam. Bao trùm từ kiến trúc, cài đặt, RBAC, pipeline biên soạn, retrieval hybrid, MCP với Claude, frontend, đến vận hành ngày thường.
>
> **Đối tượng đọc**:
> - **System Admin / DevOps**: Section 02, 03, 10
> - **Editor / Content Owner**: Section 04, 05, 09
> - **Contributor / Reader**: Section 06, 08, 09
> - **Developer integrating with Claude**: Section 07
> - **Người mới hoàn toàn**: bắt đầu từ Section 01

Tổng ~75 trang, ~19.000 từ. Đọc tuần tự để hiểu hệ thống đầy đủ; tham chiếu theo nhu cầu khi đã quen.

---

## Mục lục

| # | Section | Nội dung | Đối tượng chính |
|---|---------|----------|-----------------|
| 01 | [Tổng quan & thuật ngữ](01-tong-quan.md) | Mục tiêu Arkon, kiến trúc tổng thể, 13 thuật ngữ cốt lõi (Source, Wiki Page, Scope, KT, MCP, MRP…), glossary viết tắt. | Tất cả |
| 02 | [Cài đặt & setup](02-cai-dat.md) | Prerequisites, `.env.docker` config, `docker compose up`, alembic, admin đầu tiên, seed dữ liệu trường học, MCP token, smoke test, troubleshooting setup. | DevOps, Admin |
| 03 | [RBAC & permissions](03-rbac.md) | Dual-realm (department + workspace), 36 permission keys, `LEGACY_PERMISSION_MAP`, scope-aware queries, KT gating, decision tree, 3 ví dụ thực tế. | Admin |
| 04 | [Knowledge Types](04-knowledge-types.md) | KT là gì, 15 KT trường học từ seed, lifecycle, MCP gate qua token, best practice đặt tên, endpoints. | Admin, Editor |
| 05 | [Source pipeline (MRP)](05-source-pipeline.md) | 6 phase: MAP → REDUCE → PLAN review → REFINE → VERIFY → COMMIT. Function refs, cost ~$0.025/source, WRITER prompt rules (preserve quantitative facts), retry/recovery. | Admin, Editor |
| 06 | [Wiki layer & hybrid retrieval](06-wiki-retrieval.md) | `WikiPage`/`WikiLink`/scope model, 3 retrieval channels (BM25 + Vector + Graph walk), `search_pages_hybrid` (RRF k=60, graph_weight=0), migration 028, A/B test results. | Developer, Admin |
| 07 | [MCP server & skills](07-mcp-server.md) | 21 tools chia 7 nhóm, token auth, mount `/mcp`, out-of-scope hint, Claude Desktop/Code config, 3 skills (`arkon-query`, `arkon-edit`, `arkon-review`), best practice prompts. | Developer, Power user |
| 08 | [Frontend UI flows](08-frontend-flows.md) | 12 trang/flow: Knowledge, Workspaces, Wiki, Employees, Roles, Departments, Profile (MCP token), Plan Review Dialog, Draft submission/review, user journey ASCII. | End user |
| 09 | [Quy trình theo role](09-quy-trinh-theo-role.md) | SOP hàng ngày/tuần cho Admin, Editor, Contributor, Reader. Use case Claude qua MCP với prompt mẫu, bulk operations, migration đơn vị mới, lifecycle tài liệu. | Tất cả |
| 10 | [Vận hành & sự cố](10-van-hanh-su-co.md) | Monitoring, rate limit OpenAI, stuck sources, force re-run REFINE, backup/restore, scripts inventory (7 admin scripts), 8 lỗi thường gặp, performance tips, incident response. | DevOps, Admin |

---

## Tham chiếu chéo

Một số chủ đề trải dài nhiều section. Bảng dưới gom điểm vào để tra cứu nhanh:

| Chủ đề | Section chính | Tham chiếu thêm |
|--------|--------------|-----------------|
| MCP token (cấp, dùng, scope) | 07 | 02 (cấp lần đầu), 09 (use case) |
| Knowledge Type | 04 | 03 (gating), 07 (MCP filter) |
| Plan review dialog | 08 | 05 (pipeline phase 2.5) |
| Draft contribution flow | 09 | 07 (MCP `arkon-edit`), 08 (UI) |
| Backup & disaster recovery | 10 | 02 (initial DB schema) |
| Embedding & vector search | 06 | 05 (embed sau REFINE) |
| Bulk upload tài liệu | 09 | 10 (`tmp/bulk-upload.sh`) |
| Bulk import nhân viên | 02 | 10 (scripts inventory) |

---

## Đọc nhanh theo tình huống

**Tôi mới deploy lần đầu**: Section 02 → 03 → 04 → 09 (admin daily flow).

**Tôi muốn user team mình dùng Claude Desktop kết nối Arkon**: Section 07 → 09 (Reader use case + Claude prompts).

**Tôi muốn hiểu tài liệu của tôi được biên soạn ra wiki như thế nào**: Section 01 → 05.

**Hệ thống gặp lỗi**: Section 10 trước (troubleshooting + scripts), section 03 nếu là lỗi permission, section 05 nếu là lỗi pipeline.

**Tôi là dev muốn extend hybrid retrieval**: Section 06 (full chi tiết function), section 01 (terminology).

**Tôi cần đào tạo nhân sự mới về Arkon**: Section 01 → 08 → 09.

---

## Convention thuật ngữ

Tài liệu giữ các thuật ngữ kỹ thuật bằng tiếng Anh khi đó là chuẩn ngành (vd `scope`, `wikilink`, `embedding`, `tsvector`, `RRF`, `BM25`, `pgvector`, `MCP`, `MRP`). Phần giải thích, ví dụ, văn cảnh dùng tiếng Việt tự nhiên.

Permission key dùng định dạng `noun.verb` (vd `documents.create`, `wiki.approve`) — viết liền không dấu cách, giữ nguyên format từ code.

Slug dùng kebab-case không dấu (vd `tuyen-sinh`, `pham-chat-cua-so`) — đây cũng là format Arkon yêu cầu.

---

## Version & Updates

- **Version 1.0** (2026-05-27): bản đầu tiên, được biên soạn tự động bởi 10 subagent đọc trực tiếp codebase, sau đó review/consolidate bởi main agent.
- Mỗi section khi thay đổi, cập nhật ghi chú ở chân file đó. File index này cập nhật theo khi thêm/đổi section.
- Nếu thấy thông tin lỗi thời hoặc sai với code thực tế, mở issue hoặc đề xuất sửa qua flow Section 09 (Editor — wiki maintain).

---

*Để bắt đầu, mở [01-tong-quan.md](01-tong-quan.md).*
