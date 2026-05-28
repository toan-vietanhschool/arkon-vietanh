<!-- Section 03 / 10 — RBAC & permissions. Một phần của Arkon SOP. -->

# Section 03 — RBAC & Phân quyền

Arkon dùng mô hình kiểm soát truy cập hai tầng (dual-realm): một tầng toàn tổ chức dựa trên phòng ban, một tầng workspace dựa trên membership. Hai tầng này độc lập nhau — permission toàn tổ chức không tự động cấp quyền vào workspace, và ngược lại.

---

## Mô hình dual-realm

### Department realm (global)

Mỗi nhân viên thuộc về đúng một phòng ban. Role được gắn trực tiếp lên hồ sơ nhân viên và áp dụng cho toàn hệ thống, trừ các workspace.

- **Scope `own_dept`**: tài nguyên của phòng ban mình + tài nguyên "global" (không thuộc phòng ban nào).
- **Scope `all`**: mọi tài nguyên bất kể phòng ban.

Định dạng permission: `{resource}:{action}:{scope}` — ví dụ `wiki:write:own_dept`, `doc:read:all`.

### Workspace realm (local)

Mỗi workspace có danh sách thành viên riêng. Workspace role quyết định những gì member có thể làm bên trong workspace đó, không ảnh hưởng đến tài nguyên phòng ban. Các workspace role theo thứ tự đặc quyền tăng dần:

| Workspace role | Level | Quyền |
|---|---|---|
| `viewer` | 0 | Đọc wiki, sources, danh sách member của workspace |
| `contributor` | 1 | + Đề xuất wiki draft cho trang workspace |
| `editor` | 2 | + Sửa trực tiếp wiki · Approve/reject draft · Thêm/xóa sources |
| `admin` | 3 | + Thêm/xóa member · Đổi role member · Đổi tên/archive workspace |

Workspace role có tính kế thừa (hierarchical): `editor` có thể làm mọi thứ `contributor` có thể làm, và cứ như vậy.

### Resolution rule

Permission cuối cùng của một request là **union** của cả hai tầng. Nếu department realm grant một quyền, workspace realm không cần phải grant thêm — và ngược lại.

---

## System admin

`Employee.role` là cột hệ thống, nhận giá trị `'admin'` hoặc `'employee'`. Nhân viên có `role='admin'`:

- Bypass mọi permission check (không cần có bất kỳ permission key nào trong role).
- Tự động có workspace admin role ở mọi workspace.
- Có thể tạo, archive, và xóa workspace.

System admin không cần và không nên được gắn thêm permission key nào — `system_admin` là flag, không phải role có thể tùy chỉnh.

---

## Catalog permission — Department realm

### Định dạng

```
{resource}:{action}:{scope}
  scope = own_dept  →  phòng ban mình + tài nguyên global
  scope = all       →  toàn bộ tài nguyên
```

### Documents

```
doc:read:own_dept      # Xem tài liệu phòng ban mình + global
doc:read:all           # Xem tài liệu mọi phòng ban
doc:create:own_dept    # Upload tài liệu vào phòng ban mình
doc:create:all         # Upload vào bất kỳ phòng ban
doc:edit:own_dept      # Sửa metadata tài liệu phòng ban mình
doc:edit:all           # Sửa metadata mọi tài liệu
doc:delete:own_dept    # Xóa tài liệu phòng ban mình
doc:delete:all         # Xóa mọi tài liệu (nguy hiểm)
```

### Wiki

```
wiki:read:own_dept     # Đọc wiki global + wiki phòng ban mình
wiki:read:all          # Đọc mọi wiki page
wiki:write:own_dept    # Đề xuất draft cho wiki global và phòng ban mình
wiki:write:all         # Sửa trực tiếp + approve/reject draft toàn hệ thống
wiki:delete:own_dept   # Xóa wiki phòng ban mình
wiki:delete:all        # Xóa mọi wiki page (nguy hiểm)
```

### AI Skills

```
skill:read:own_dept          # Dùng skill phòng ban mình + global
skill:read:all               # Dùng mọi skill
skill:create:own_dept        # Upload skill vào phòng ban mình
skill:create:all             # Upload skill vào bất kỳ phòng ban
skill:edit:own_dept          # Sửa metadata skill phòng ban mình
skill:edit:all               # Sửa metadata mọi skill
skill:delete:own_dept        # Xóa skill phòng ban mình
skill:delete:all             # Xóa mọi skill (nguy hiểm)
skill:contribution:review    # Duyệt/từ chối skill contribution request
```

### Organization (tác vụ quản trị)

```
org:departments:read     # Xem danh sách phòng ban
org:departments:manage   # Tạo/sửa/xóa phòng ban
org:employees:read       # Xem danh sách nhân viên
org:employees:manage     # Tạo/sửa/vô hiệu hóa nhân viên; bao gồm gán role
org:roles:read           # Xem danh sách role và quyền của role
org:roles:manage         # Tạo/sửa/xóa role (nhạy cảm cao)
org:settings:read        # Xem cấu hình hệ thống (AI provider, key đã che)
org:settings:manage      # Sửa cấu hình hệ thống
org:audit:read           # Xem audit log
```

### Workspaces (cấp tổ chức)

```
workspace:view:all       # Xem mọi workspace dù không phải member
workspace:create         # Tạo workspace mới
workspace:archive        # Archive/unarchive workspace (soft-remove, không mất data)
workspace:delete         # Xóa vĩnh viễn workspace (chỉ emergency, thường không cấp)
workspace:members:manage # Thêm/xóa member bất kỳ workspace mà không cần là workspace admin
```

**Lưu ý `workspace:delete`**: không giống `workspace:archive`. Workspace bị archive vẫn còn toàn bộ dữ liệu và có thể tìm kiếm. Workspace bị delete thì mất toàn bộ. Triển khai trường học thông thường không cấp permission này cho bất kỳ role nào.

### Default permissions (không gán role)

Nhân viên chưa có custom role nào sẽ nhận bộ quyền tối thiểu:

```
doc:read:own_dept
doc:create:own_dept
wiki:read:own_dept
wiki:write:own_dept
skill:read:own_dept
org:departments:read
```

---

## Legacy permission map

Các hệ thống hoặc token cũ có thể dùng key theo format cũ. Backend tự ánh xạ sang key hiện tại:

| Legacy key | Ánh xạ sang |
|---|---|
| `documents.read` | `doc:read:own_dept` |
| `documents.edit` | `doc:edit:own_dept` |
| `kb.read` | `wiki:read:own_dept` |
| `kb.edit` | `wiki:write:own_dept` |
| `roles.manage` | `org:roles:manage` |
| `employees.manage` | `org:employees:manage` |
| `departments.manage` | `org:departments:manage` |
| `settings.manage` | `org:settings:manage` |
| `audit.read` | `org:audit:read` |
| `projects.read` | `workspace:view:all` |
| `workspaces.create` | _(không ánh xạ — workspace creation nay chỉ dành cho admin)_ |
| `scopes.read` | _(đã xóa)_ |

Danh sách đầy đủ xem tại `app/services/permissions.py::LEGACY_PERMISSION_MAP`.

---

## Scope-aware query — Wiki

Backend filter wiki theo identity của caller thông qua `_scope_filter_for_identity(department_id, project_ids)`:

- **System admin**: thấy mọi page (`all_scopes`).
- **Member bình thường**: thấy pages thuộc `scope=global` + `scope=department` của phòng ban mình + `scope=project` của các workspace mình là member.
- **Không phải member**: chỉ thấy `scope=global`.

Khi caller tìm kiếm một slug tồn tại nhưng nằm ngoài scope của mình, Arkon trả về **hint** thay vì 404:

- `search_wiki`: thêm section "Out-of-scope matches" liệt kê `(scope_type, scope_name, count)` — không lộ title hay nội dung.
- `read_wiki_page`: trả về thông báo "page này tồn tại trong phòng ban X / workspace Y nhưng bạn không có quyền, liên hệ scope admin".

Thiết kế này cân bằng giữa discoverability (người dùng biết page tồn tại để escalate) và bảo mật (title và content không bao giờ bị rò ra qua ranh giới permission).

---

## Knowledge Type gating

Mỗi source (tài liệu) được gán một Knowledge Type (KT) slug. MCP token của nhân viên chứa danh sách `allowed_knowledge_types` — chỉ những KT nằm trong danh sách này mới hiển thị qua MCP query.

KT gating hoạt động **độc lập** với department/workspace permission: ngay cả khi nhân viên có `doc:read:all`, MCP vẫn chỉ trả về source của KT token cho phép. Điều này cho phép tổ chức kiểm soát luồng thông tin theo chủ đề thay vì chỉ theo cấu trúc phòng ban.

Chi tiết về KT operations (tạo, seed, gán slug) xem Section 04.

---

## Sơ đồ quyết định (Decision tree)

```
REQUEST
    │
    ▼
Is system admin? (Employee.role = 'admin')
    │ YES → GRANT (bypass all checks)
    │
    ▼ NO
Is this a workspace resource?
    │
    ├─ YES ──► Is user a workspace member?
    │              │ NO  → 403 Forbidden
    │              │ YES → Does workspace role satisfy required level?
    │                          │ NO  → 403 Forbidden
    │                          │ YES → GRANT
    │
    └─ NO (global / department resource)
            │
            ▼
        Does user's role include the required permission key?
            │ NO  → 403 Forbidden
            │ YES → Does scope match?
                        │ own_dept: resource in user's dept OR global → GRANT
                        │ own_dept: resource in other dept            → 403
                        │ all:      any resource                      → GRANT
```

Nếu request là MCP call, thêm bước sau khi GRANT:

```
        ▼ GRANT (permission passed)
    Is this a source read via MCP?
        │ YES → KT slug in token's allowed_knowledge_types? → YES: return · NO: filter out
        │ NO  → return normally
```

---

## Ví dụ thực tế

### Cô A — Contributor phòng Tuyển Sinh, member workspace ws-tuyensinh-2026

Role phòng ban: `Chuyên viên Marketing - Truyền thông` hoặc tương đương với permissions:

```
doc:read:own_dept   doc:create:own_dept   doc:edit:own_dept
wiki:read:own_dept  wiki:write:own_dept
skill:read:own_dept
org:departments:read
```

Workspace role trong `ws-tuyensinh-2026`: `contributor`.

**Cô A có thể:**
- Đọc tài liệu và wiki của phòng Tuyển Sinh + tài nguyên global.
- Upload tài liệu mới cho phòng Tuyển Sinh.
- Đề xuất wiki draft cho workspace `ws-tuyensinh-2026`.
- Xem danh sách thành viên workspace.

**Cô A không thể:**
- Đọc tài liệu của phòng Đào Tạo - Giáo Vụ (không có `doc:read:all`).
- Approve/reject draft trong workspace (cần `editor`+).
- Thêm source vào workspace (cần `editor`+).
- Xem wiki của phòng Kế Toán hay workspace khác mà cô không phải member.

---

### Anh B — Editor workspace ws-tuyensinh-2026, Reader phòng Đào Tạo

Role phòng ban: `Trợ giảng` với permissions:

```
doc:read:own_dept   wiki:read:own_dept   skill:read:own_dept
org:departments:read
```

Workspace role trong `ws-tuyensinh-2026`: `editor`.

**Anh B approve draft — flow cụ thể:**

1. Một member với workspace role `contributor` đề xuất edit wiki page `[[ke-hoach-tuyen-sinh-2026]]`.
2. Draft được tạo trong bảng `wiki_page_drafts` với `status=pending`.
3. Anh B nhận thông báo (hoặc vào trang wiki của workspace) và thấy draft.
4. Anh B có workspace role `editor` (level 2) — đủ điều kiện approve/reject.
5. Anh B click Approve → page được cập nhật trực tiếp.

**Anh B không thể approve draft wiki global** (scope=global): đó là trang thuộc department realm, cần permission `wiki:write:all` — anh B không có.

---

### MCP token scoped vào KT 'tuyen-sinh'

Token được cấp cho Claude Desktop/Code với `allowed_knowledge_types = ["tuyen-sinh"]`.

**Có thể:**
- `search_wiki` — tìm wiki pages mà token owner được phép xem (theo department + workspace membership của nhân viên đó).
- `read_wiki_page` — đọc nội dung page nếu trong scope.
- `search_sources` — trả về sources có `knowledge_type.slug = "tuyen-sinh"`.

**Không thể:**
- Đọc source có KT `dao-tao` hay `ke-toan`, dù nhân viên có `doc:read:own_dept` trong phòng ban mình.
- Propose edit wiki page (cần `wiki:write:own_dept` trong phòng ban hoặc workspace role `contributor`+ — tùy scope của page).

KT filter áp dụng ở tầng MCP, không ảnh hưởng đến truy cập qua web app.
