<!-- Section 07 / 10 — MCP server & skills. Một phần của Arkon SOP. -->

# Section 07 — MCP Server và Skills

Arkon cung cấp một MCP (Model Context Protocol) server để Claude Desktop và Claude Code truy cập trực tiếp vào knowledge base của tổ chức. Thay vì paste nội dung thủ công vào chat, bạn kết nối một lần rồi dùng ngôn ngữ tự nhiên để query — Claude sẽ tự gọi đúng tool.

---

## 7.1 MCP là gì và Arkon dùng nó ra sao

MCP là một protocol mở do Anthropic phát triển, cho phép Claude gọi "tools" và đọc "resources" từ một server bên ngoài. Thay vì nhét toàn bộ tài liệu vào context window, Claude hỏi server lúc cần và chỉ nhận phần thông tin liên quan.

Arkon implement server này bằng **FastMCP**, mount vào FastAPI tại path `/mcp`. Claude Desktop kết nối qua HTTP, xác thực bằng Bearer token, rồi nhận danh sách tools phù hợp với quyền của identity đó.

```
Claude Desktop ──Bearer token──► POST /mcp
                                        │
                                   identity resolve
                                   (MCPAuthService)
                                        │
                                   scope filter
                                   (knowledge_type_slugs,
                                    workspace memberships)
                                        │
                                   PostgreSQL / pgvector
                                        │
                                   ◄── response
```

Toàn bộ logic nằm trong `app/mcp/`. Server được khởi động cùng với FastAPI trong `app/main.py` và log sẵn `"Arkon MCP Server ready at /mcp"` khi startup thành công.

---

## 7.2 Authentication và cấp token

Mỗi lời gọi MCP phải kèm header:

```
Authorization: Bearer <token>
```

Server đọc header này, hash token và so sánh với `mcp_token_hash` lưu trong bảng `employees`. Token không được lưu plain-text — migration `027_hash_mcp_tokens` đã chuyển toàn bộ sang dạng hash một chiều.

### Cấp token cho bản thân (self-service)

Bất kỳ employee nào cũng tự lấy token của mình qua REST API:

| Action | Endpoint |
|--------|----------|
| Tạo hoặc reset token | `POST /api/my/mcp-token` |
| Kiểm tra token có tồn tại không | `GET /api/my/mcp-token/status` |
| Thu hồi token | `DELETE /api/my/mcp-token` |

Endpoint `POST /api/my/mcp-token` trả về token dạng plain-text **duy nhất một lần**. Lưu nó ngay — sau đó server chỉ lưu hash, không thể lấy lại giá trị gốc.

### Cấp token cho người khác (admin)

Admin có thể cấp và thu hồi token cho bất kỳ employee nào:

| Action | Endpoint |
|--------|----------|
| Cấp token cho employee | `POST /api/employees/{emp_id}/token` |
| Thu hồi token của employee | `DELETE /api/employees/{emp_id}/token` |

Yêu cầu permission `org:employees:manage`.

### Token scope

Token gắn với identity của employee — identity này xác định:

- **KnowledgeType scope**: `allowed_knowledge_types` (nếu không set thì truy cập mọi KT)
- **Workspace memberships**: các project mà employee là thành viên
- **Department**: wiki page của department của employee
- **Role**: `admin` bypass mọi scope filter

Scope được enforce tại server — không có cách nào ở client override điều này.

---

## 7.3 Danh sách 21 tools

Tools hiển thị với Claude phụ thuộc vào role của identity trong token. Middleware `ScopedToolsMiddleware` ẩn các tool mà identity không đủ quyền ngay từ bước `tools/list` để Claude không "thấy" những tool không dùng được.

### Wiki Read (any authenticated)

| Tool | Mô tả |
|------|-------|
| `search_wiki` | Hybrid search (semantic + full-text) trên wiki pages. Dùng đây trước tiên cho mọi câu hỏi. Trả về slug, title, similarity score, summary. |
| `read_wiki_page` | Đọc full content một page theo slug, kèm danh sách backlinks. |
| `read_wiki_index` | Đọc trang catalog `_index` — liệt kê toàn bộ wiki pages theo type. |
| `list_wiki_pages` | Browse wiki pages với filter theo `page_type` và `knowledge_type`. |

### Source Drill-Down (any authenticated)

| Tool | Mô tả |
|------|-------|
| `get_source` | Metadata của một source document: title, knowledge type, số trang, contributor, status. |
| `get_source_outline` | Table of contents dựa trên heading của source. Dùng trước khi đọc source dài. |
| `get_source_pages` | Đọc text raw của các trang cụ thể trong source. Nhận page range như `"5-7"`, `"3,8"`. |

### Browsing và Directory (any authenticated)

| Tool | Mô tả |
|------|-------|
| `list_sources` | Danh sách source documents, có thể filter theo `status` và `knowledge_type`. |
| `list_knowledge_types` | Danh sách KnowledgeType accessible với identity hiện tại, kèm số doc. |
| `get_knowledge_type_docs` | Danh sách documents thuộc một KnowledgeType cụ thể. |

### Wiki Write — Contribute (wiki:write:\* hoặc workspace contributor+)

| Tool | Mô tả |
|------|-------|
| `propose_wiki_edit` | Đề xuất chỉnh sửa một page đã tồn tại. Tạo draft chờ editor duyệt. |
| `propose_wiki_create` | Đề xuất tạo page mới. Draft cần được editor approve thì page mới xuất hiện. |
| `resubmit_draft` | Nộp lại draft sau khi reviewer gửi về yêu cầu sửa (`needs_revision`). Tăng `revision_round`. |
| `withdraw_draft` | Rút draft của chính mình khỏi hàng đợi review. Không thể hoàn tác. |

### Wiki Write — Direct (wiki:write:all hoặc workspace editor+)

| Tool | Mô tả |
|------|-------|
| `edit_wiki_page` | Chỉnh sửa trực tiếp page đã tồn tại — không qua review. Tạo revision trong lịch sử. |
| `create_wiki_page` | Tạo page mới trực tiếp — không qua review. |

### Wiki Review (wiki:write:all hoặc workspace editor+)

| Tool | Mô tả |
|------|-------|
| `list_pending_drafts` | Liệt kê drafts đang chờ duyệt. Có thể filter theo workspace. |
| `review_draft` | Đọc nội dung draft để so sánh với page hiện tại. |
| `approve_draft` | Approve draft (có thể kèm sửa nhỏ). Viết thẳng vào wiki, tạo revision. |
| `request_changes_on_draft` | Gửi draft về cho tác giả sửa — ưu tiên hơn reject khi draft còn cứu được. |
| `reject_draft` | Từ chối draft. `reviewer_note` bắt buộc. |

---

## 7.4 Out-of-scope hint

Khi `search_wiki` tìm thấy kết quả nhưng nằm ngoài scope của token (department hoặc workspace khác), server trả về một section **"Out-of-scope matches"** kèm thông báo:

```
Out-of-scope matches — matching page(s) exist outside your access:
- 3 page(s) in department **Finance** — contact the Finance department admin to request access.
- 1 page(s) in workspace **Q1 Planning** — contact the workspace admin to be added as a member.
```

Server chỉ tiết lộ **số lượng** và **tên scope** — không leak title hay summary của page — để tránh rò rỉ thông tin nhạy cảm. Khi thấy hint này, hướng dẫn người dùng liên hệ đúng admin để xin quyền thay vì kết luận knowledge không tồn tại.

---

## 7.5 Cấu hình Claude Desktop

Mở file `claude_desktop_config.json` (thường ở `~/Library/Application Support/Claude/` trên macOS, hoặc `%APPDATA%\Claude\` trên Windows) và thêm:

```json
{
  "mcpServers": {
    "arkon": {
      "url": "http://localhost:8000/mcp",
      "headers": {
        "Authorization": "Bearer <your-mcp-token>"
      }
    }
  }
}
```

Thay `<your-mcp-token>` bằng token lấy từ `POST /api/my/mcp-token`. Nếu Arkon deploy trên server thay vì localhost, đổi URL thành domain tương ứng, ví dụ `https://ai.company.internal/mcp`.

Sau khi lưu file, restart Claude Desktop. Tools sẽ xuất hiện trong thanh công cụ của Claude.

---

## 7.6 Cấu hình Claude Code

Thêm MCP server bằng lệnh sau trong terminal (chạy một lần):

```bash
claude mcp add arkon \
  --transport http \
  --url http://localhost:8000/mcp \
  --header "Authorization: Bearer <your-mcp-token>"
```

Hoặc thêm thủ công vào file settings của Claude Code (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "arkon": {
      "url": "http://localhost:8000/mcp",
      "headers": {
        "Authorization": "Bearer <your-mcp-token>"
      }
    }
  }
}
```

Để kiểm tra kết nối:

```bash
claude mcp list
```

Nếu thấy `arkon` trong danh sách và status `connected`, setup thành công.

---

## 7.7 Skills built-in

Skills là các workflow có cấu trúc được load vào Claude Code tự động. Arkon ship ba skills built-in, seed vào DB khi khởi động server (idempotent — không seed lại nếu content không đổi).

### arkon-query

**Role required:** Any authenticated  
**Trigger phrases:** "what do we know about X", "find in KB", "query:", "look up", "tell me about", "search the wiki"

Workflow mặc định để query knowledge base:

1. `search_wiki` — tìm kiếm và đọc summary
2. `read_wiki_page` — đọc 2-4 page liên quan nhất
3. Tổng hợp câu trả lời với cite slug

Có ba chế độ:
- **Quick** (`query quick: ...`): chỉ `search_wiki`, trả lời nhanh nếu similarity cao
- **Standard** (mặc định): search + đọc 2-4 pages
- **Deep** (`query deep: ...` hoặc "thorough"): traverse toàn bộ wiki liên quan + drill-down vào raw sources

### arkon-edit

**Role required:** Contributor+ (workspace) hoặc wiki:write:* (global)  
**Trigger phrases:** "update wiki", "propose edit", "fix this page", "correct the KB", "create new wiki page"

Workflow đề xuất và ghi trực tiếp vào wiki:
- Contributor: `propose_wiki_edit` / `propose_wiki_create` → vào hàng đợi review
- Editor/Admin: `edit_wiki_page` / `create_wiki_page` → viết thẳng, không review

Skill luôn yêu cầu đọc page hiện tại trước và xác nhận với người dùng trước khi submit.

### arkon-review

**Role required:** Editor+ (workspace) hoặc wiki:write:all  
**Trigger phrases:** "review drafts", "pending reviews", "approve draft", "reject draft", "request changes"

Workflow xử lý hàng đợi review:

```
list_pending_drafts()
  → review_draft(draft_id)         ← đọc side-by-side proposed vs current
  → approve_draft(draft_id)         ← hoặc
  → request_changes_on_draft(...)   ← hoặc
  → reject_draft(...)
```

Không thể tự approve draft của chính mình — server block ở tầng API.

---

## 7.8 Best practice prompts

Các cách diễn đạt trigger skill hiệu quả nhất:

| Mục tiêu | Prompt ví dụ |
|----------|-------------|
| Tìm kiếm nhanh | `"what do we know about the onboarding process?"` |
| Deep research | `"query deep: find everything about Q1 budget planning"` |
| Đọc page cụ thể | `"read the wiki page concept/fire-safety"` |
| Đề xuất sửa | `"propose an edit to entity/jane-doe — update her role to Engineering Lead"` |
| Tạo page mới | `"propose a new wiki page for the incident response process"` |
| Review queue | `"show me pending drafts in the HR workspace"` |
| Approve draft | `"approve draft abc-123 with note: looks good, minor formatting fixed"` |

Khi Claude không trả lời từ KB mà dùng general knowledge, nhắc lại: `"search arkon first"` hoặc thêm `"based on our KB"` vào câu hỏi.
