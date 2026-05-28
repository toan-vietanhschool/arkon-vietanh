<!-- Section 08 / 10 — Frontend UI flows. Một phần của Arkon SOP. -->

# Section 08: Giao diện web Arkon — Hướng dẫn sử dụng

Tài liệu này mô tả các flow chính của giao diện web Arkon (Next.js, route group `(portal)`). Đối tượng: người dùng cuối, quản trị viên phòng ban, và admin hệ thống.

---

## 08.1 Tổng quan bố cục giao diện

Sau khi đăng nhập, mọi trang trong Arkon dùng chung một layout gồm hai vùng:

**Sidebar (trái)** — điều hướng chính, được chia thành ba nhóm:

| Nhóm | Mục |
|---|---|
| Tri thức tổ chức | Tài liệu (`/knowledge`), Wiki (`/wiki`), Bản nháp (`/wiki/review`), Kỹ năng AI (`/skills`) |
| Tổ chức | Phòng ban (`/departments`), Nhân viên (`/employees`), Vai trò (`/roles`) |
| Hệ thống | Thống kê, Nhật ký kiểm tra, Cài đặt |

Sidebar ẩn các mục mà user không có quyền — ví dụ người không có `org:employees:read` sẽ không thấy mục "Nhân viên".

Bên dưới sidebar là danh sách **Workspace** của user (nếu có), cho phép nhảy thẳng vào `/workspaces/{id}`.

**Main content (phải)** — vùng nội dung thay đổi theo route.

**Topbar** nằm trong sidebar, chứa:
- Logo và tên tổ chức
- Chuông thông báo (notification bell)
- Avatar + dropdown user menu: hồ sơ cá nhân, đổi ngôn ngữ (VI/EN), đăng xuất

**i18n** — Arkon hỗ trợ tiếng Việt (mặc định) và tiếng Anh. Chuyển ngôn ngữ qua `LocaleSwitcher` ở góc dưới sidebar hoặc user menu. Translations lưu tại `frontend/messages/vi/` và `frontend/messages/en/`.

---

## 08.2 Trang Knowledge — `/knowledge`

Trang quản lý tài liệu nguồn (source). Ai có quyền `doc:read:own_dept` trở lên sẽ thấy trang này.

### Xem và lọc danh sách

- Bảng hiển thị các cột: Tài liệu, Danh mục (Knowledge Type), Hiển thị (scope), Phòng ban, Số trang, Số trang Wiki, Đóng góp bởi, Trạng thái, Ngày tạo.
- Dùng ô tìm kiếm trên đầu bảng để lọc theo tên tài liệu.
- Tổng số tài liệu hiển thị góc phải ô tìm kiếm.
- Phân trang: tối đa 7 nút trang, cuộn theo vị trí trang hiện tại.

### Upload tài liệu mới

Quyền cần: `doc:create:own_dept` hoặc `doc:create:all`.

1. Nhấn nút "Tải lên" trên trang `/knowledge`.
2. Dialog "Tải lên tài liệu" mở ra. Kéo thả file hoặc nhấn vào vùng chấm chọn để chọn file.
3. Định dạng chấp nhận: PDF, DOCX, DOC, XLSX, CSV, TXT, MD, PPTX. Giới hạn 50 MB.
4. Chọn **Loại kiến thức** (Knowledge Type) — danh mục phân loại nội dung, có màu sắc phân biệt. Không bắt buộc.
5. Chọn **Phòng ban** — tick checkbox một hoặc nhiều phòng ban. Để trống = tài liệu toàn cục (hiển thị cho mọi người).
6. Chọn **Hiển thị**:
   - "Toàn cục" — nội dung sẽ được tổng hợp vào wiki chung. Có cảnh báo màu vàng: chỉ dùng khi nội dung không nhạy cảm.
   - "Workspace" — tổng hợp vào wiki của một workspace cụ thể; cần chọn workspace từ dropdown.
7. Nhấn "Tải lên". Sau khi hoàn tất, dialog đóng và bảng tự refresh.

### Actions trên từng tài liệu

Hover vào hàng, nhấn icon `⋮` bên phải để mở dropdown:

- **Sửa** — mở dialog chỉnh sửa tiêu đề, loại kiến thức, phòng ban, scope.
- **Xem kế hoạch** — chỉ xuất hiện khi trạng thái là `plan_ready`. Mở Plan Review Dialog (xem mục 08.9).
- **Thử lại** — xuất hiện khi trạng thái `error`, hoặc khi tài liệu bị treo ở `pending`/`processing` quá 5 phút (label đổi thành "Thử lại (đang treo)"). Gọi lại quá trình xử lý AI.
- **Xóa** — yêu cầu xác nhận. Không thể hoàn tác.

---

## 08.3 Trang Workspaces — `/workspaces` và `/workspaces/{id}`

Workspace là không gian làm việc có nhóm và tài liệu riêng. Loại gồm: "Khách hàng" và "Dự án".

### Tạo workspace mới

Quyền cần: `workspace:create`.

1. Vào `/workspaces`, nhấn "Workspace mới".
2. Điền tên, chọn loại (Khách hàng / Dự án), thêm mô tả (không bắt buộc).
3. Nhấn "Tạo".

### Trang chi tiết workspace

Nhấn vào một workspace trong danh sách để vào `/workspaces/{id}`. Trang này có ba tab:

**Tab Wiki** — xem các trang wiki thuộc workspace, cùng graph view.

**Tab Tài liệu** — danh sách source được liên kết với workspace. Có thể:
- Tải lên file mới trực tiếp vào workspace (upload sẽ tự set scope = workspace này).
- Liên kết tài liệu có sẵn từ kho toàn cục.
- Xem kế hoạch (khi source ở trạng thái `plan_ready`).
- Xóa source khỏi workspace.

**Tab Thành viên** — danh sách thành viên và vai trò workspace của họ (viewer / contributor / editor / admin). Admin workspace có thể thêm/xóa thành viên và thay đổi vai trò.

### Archive workspace

Quyền cần: `workspace:archive`, hoặc là admin workspace.

1. Ở trang chi tiết workspace, nhấn nút "Lưu trữ" (góc trên phải, cạnh tên workspace).
2. Workspace chuyển sang trạng thái "Đã lưu trữ" — thành viên mất quyền truy cập nhưng dữ liệu vẫn còn.
3. Để mở lại, nhấn "Mở lại" trên cùng trang.

---

## 08.4 Trang Wiki — `/wiki` và `/wiki/{slug}`

### Cây trang (page tree)

Sidebar trái của `/wiki` hiển thị cây trang wiki, được nhóm theo scope:
- **Toàn cục** — trang chung toàn tổ chức.
- **Phòng ban** — trang thuộc phòng ban cụ thể.
- **Workspace** — trang thuộc workspace.

Mỗi nhóm scope có thể thu gọn/mở rộng. Ô lọc trên đầu cây để tìm nhanh theo tên trang.

### Đọc trang wiki

1. Chọn trang từ cây hoặc dùng Search (`/wiki?search=...`).
2. Nội dung hiển thị ở vùng chính, render Markdown. Wikilink (`[[tên trang]]`) tự động resolve thành hyperlink.
3. Panel backlinks bên phải (nếu có) hiển thị danh sách trang khác đang liên kết đến trang này.

### Tạo trang mới (editor trở lên)

- Nhấn icon "+" bên cạnh nhóm scope trong page tree, hoặc nút "Trang mới" trên header.
- Với editor/admin: trang được tạo trực tiếp (draft kind = `create`, tự approve).
- Với contributor: tạo draft để duyệt (xem mục 08.10).

### Chỉnh sửa trang (editor trở lên)

- Mở trang wiki, nhấn nút "Sửa" trên header trang.
- Với contributor: nút đổi thành "Đề xuất chỉnh sửa" (xem mục 08.10).

---

## 08.5 Trang Nhân viên — `/employees`

Quyền cần: `org:employees:read` để xem, `org:employees:manage` để sửa.

### Xem danh sách

- Bảng nhân viên: tên, email, phòng ban, vai trò hệ thống, vai trò tùy chỉnh, trạng thái.
- Tìm kiếm theo tên hoặc email.
- Phân trang 20 người/trang.

### Tạo và sửa nhân viên

1. Nhấn "Thêm nhân viên" (hoặc icon sửa trên hàng).
2. Điền tên, email, mật khẩu (chỉ khi tạo mới), chọn phòng ban, chọn vai trò hệ thống.
3. Vai trò tùy chỉnh (custom role) — chọn thêm từ danh sách vai trò đã tạo ở `/roles`.
4. Nhấn "Lưu".

### Bulk import từ Excel

1. Nhấn "Import" trên trang `/employees`.
2. Tải file template Excel (nếu chưa có).
3. Điền dữ liệu nhân viên vào template, upload file.
4. Hệ thống xử lý và báo cáo số dòng thành công / bỏ qua / lỗi.

---

## 08.6 Trang Vai trò — `/roles`

Quyền cần: `org:roles:read` để xem, `org:roles:manage` để sửa.

### Xem danh sách vai trò

- Mỗi role hiển thị tên, badge "Hệ thống" (nếu là role mặc định), và danh sách quyền đã gán.
- Role hệ thống (Viewer, Contributor, DepartmentAdmin, KnowledgeAdmin) không thể xóa.

### Tạo / Sửa vai trò

1. Nhấn "Tạo vai trò" hoặc icon sửa trên hàng.
2. Điền tên và mô tả (không bắt buộc).
3. Chọn quyền từ ma trận permission, được nhóm theo chủ đề: Tài liệu, Wiki, Kỹ năng AI, Tổ chức, Workspace. Hiển thị "X / Y quyền được chọn".
4. Nhấn "Tạo" hoặc "Cập nhật".

### Xóa vai trò

Nhấn icon xóa, xác nhận trong dialog. Nhân viên đang được gán vai trò này sẽ mất vai trò đó.

---

## 08.7 Trang Phòng ban — `/departments`

Quyền cần: `org:departments:read` để xem, `org:departments:manage` để sửa.

- Xem danh sách phòng ban và số lượng nhân viên.
- Tạo phòng ban: nhấn "Thêm phòng ban", nhập tên.
- Sửa tên phòng ban: nhấn icon sửa trên hàng.
- Xóa phòng ban: chỉ được khi không còn nhân viên nào thuộc phòng ban đó.

Gán role template cho phòng ban (nếu có trong settings): nhân viên mới của phòng ban sẽ tự nhận role mặc định của phòng ban.

---

## 08.8 MCP Token — trang hồ sơ `/profile`

MCP token dùng để kết nối Claude Desktop / Claude Code với knowledge base Arkon. Token nằm ở tab hồ sơ cá nhân, không có trang riêng.

### Tạo token

1. Vào trang hồ sơ (nhấn avatar trên sidebar → "Hồ sơ").
2. Tìm card "MCP Token".
3. Nhấn "Tạo token".
4. Token hiển thị một lần duy nhất trong ô có nền tối. **Sao chép ngay** — sau khi đóng hoặc rời trang, token không hiển thị lại.
5. Nhấn "Sao chép" để copy vào clipboard.

### Thu hồi token

- Nhấn "Thu hồi", xác nhận trong dialog.
- Token cũ lập tức mất hiệu lực. Cần tạo token mới nếu muốn dùng lại.

Lưu ý: mỗi user chỉ có một token tại một thời điểm. Token được scoped theo quyền của user — chỉ truy cập được những gì user có quyền đọc.

---

## 08.9 Plan Review Dialog — duyệt kế hoạch biên soạn Wiki

Sau khi tài liệu được xử lý xong, AI tạo ra một "kế hoạch biên soạn" liệt kê các trang wiki sẽ được tạo mới (CREATE) hoặc cập nhật (UPDATE). Admin/editor cần duyệt kế hoạch này trước khi AI viết nội dung.

**Trigger:** tài liệu ở trạng thái `plan_ready`. Nhấn icon `⋮` → "Xem kế hoạch".

### Đọc kế hoạch

- Phần tóm tắt: số trang sẽ tạo mới (màu xanh lá) và số trang sẽ cập nhật (màu vàng).
- Ghi chú của AI ("Ghi chú AI"): nhận xét ngắn về chiến lược biên soạn.
- Danh sách trang, mỗi trang hiển thị: badge CREATE/UPDATE, tiêu đề, slug, loại trang, danh sách entity liên quan.

### Các action

- **Xác nhận & Biên soạn** — chấp thuận kế hoạch, AI bắt đầu viết nội dung wiki. Source chuyển sang trạng thái processing → completed.
- **Từ chối** — nhấn "Từ chối", sau đó nhấn "Xác nhận từ chối" (hai bước để tránh nhầm). Source dừng lại, không tạo wiki.
- **Tạo lại** — nếu kế hoạch chưa phù hợp, nhập góp ý vào ô phản hồi (bắt buộc có nội dung) rồi nhấn "Tạo lại". AI tạo lại kế hoạch dựa trên góp ý (30–90 giây). Dialog tự cập nhật khi xong.

Trong khi đang tạo lại, danh sách trang bị mờ và có banner tiến trình. Sau khi hoàn tất, kế hoạch mới hiển thị để tiếp tục duyệt.

---

## 08.10 Draft flow — Contributor đề xuất chỉnh sửa Wiki

Contributor không có quyền ghi trực tiếp vào wiki. Mọi thay đổi phải qua luồng draft.

### Tạo draft chỉnh sửa

1. Mở trang wiki muốn chỉnh sửa.
2. Nhấn "Đề xuất chỉnh sửa" (thay vì "Sửa" của editor).
3. Chỉnh sửa nội dung trong editor Markdown.
4. Điền ghi chú giải thích lý do thay đổi (không bắt buộc nhưng giúp reviewer hiểu nhanh hơn).
5. Nhấn "Gửi đề xuất".

### Theo dõi trạng thái draft

- Vào `/wiki/review?mine=true` để xem tất cả draft đã tạo.
- Trạng thái: `pending` (chờ duyệt) → `approved` (được duyệt, đã cập nhật wiki) hoặc `rejected` (bị từ chối) hoặc `needs_revision` (cần sửa lại theo góp ý reviewer).
- Khi `needs_revision`: đọc nhận xét của reviewer, sửa lại và gửi lại.
- Có thể **rút lại** (withdraw) draft đang `pending` hoặc `needs_revision` nếu muốn hủy.

---

## 08.11 Draft Review — Editor/Admin duyệt bản nháp

Route: `/wiki/review` (tab "Cần duyệt"). Giao diện 3 cột.

### Cột trái — Hàng đợi

- Toggle "Cần duyệt" / "Của tôi" để chuyển giữa xem tất cả draft chờ duyệt và draft bản thân đã tạo.
- Lọc theo trạng thái: pending, needs_revision, approved, rejected.
- Lọc theo scope (phòng ban / workspace) khi có nhiều scope khác nhau.
- Mỗi item hiển thị tiêu đề trang, slug, tên tác giả, thời gian, vòng revision, trạng thái AI review.

### Cột giữa — Nội dung

- Tab **Diff** — so sánh thay đổi so với phiên bản hiện tại (màu xanh = thêm, màu đỏ = xóa).
- Tab **Đề xuất** — xem nội dung draft như trang wiki thực.
- Tab **Hiện tại** — nội dung trang wiki hiện đang published (chỉ có khi draft là chỉnh sửa, không phải tạo mới).
- Với draft tạo trang mới, chỉ có tab "Đề xuất".

### Cột phải — Thông tin và action

- Thông tin tác giả: tên, thống kê tỉ lệ approve.
- Thời gian gửi, vòng revision.
- Ghi chú của tác giả; nhận xét reviewer trước (nếu `needs_revision`).
- Panel AI Review: trạng thái kiểm tra tự động (passed / warned / failed).

**Các action:**

- **Duyệt** — nội dung draft được merge vào wiki ngay lập tức.
- **Yêu cầu sửa** — nhập nhận xét (tối thiểu 20 ký tự), draft trả về tác giả với trạng thái `needs_revision`.
- **Từ chối** — nhập lý do (tối thiểu 20 ký tự), draft kết thúc với trạng thái `rejected`.

**Phím tắt** (khi không đang gõ trong ô nhập liệu):

| Phím | Hành động |
|---|---|
| `j` / Xuống | Draft tiếp theo |
| `k` / Lên | Draft trước |
| `a` | Duyệt draft hiện tại |
| `r` | Mở form từ chối |
| `c` | Mở form yêu cầu sửa |
| `Esc` | Hủy action đang mở |
| `?` | Bật/tắt bảng phím tắt |

---

## 08.12 Sơ đồ user journey — từ đăng nhập đến wiki published

```
[User đăng nhập]
       │
       ▼
[Dashboard / Sidebar]
       │
       ├──► [/knowledge] ──► Upload file
       │                          │
       │                    [AI xử lý]
       │                          │
       │                   [status: plan_ready]
       │                          │
       │         ┌────────────────┘
       │         ▼
       │   [Plan Review Dialog]
       │         │
       │    ┌────┴─────────────┐
       │    │                  │
       │  Approve           Từ chối / Tạo lại
       │    │
       │    ▼
       │  [AI viết wiki pages]
       │         │
       │         ▼
       │  [/wiki — trang được published]
       │
       └──► [Contributor: Đề xuất chỉnh sửa]
                      │
               [Draft pending]
                      │
            ┌─────────┴──────────┐
            │                    │
     [Editor duyệt]       [Yêu cầu sửa / Từ chối]
   /wiki/review                  │
            │              [Contributor sửa lại]
            ▼
    [Wiki cập nhật]
```

**Checkpoint theo role:**

- **Viewer** — chỉ đọc wiki và tài liệu phòng ban mình.
- **Contributor** — upload tài liệu phòng ban, đề xuất chỉnh sửa wiki (cần duyệt).
- **Editor** — upload, tạo/sửa wiki trực tiếp, duyệt draft của contributor.
- **Department Admin** — tất cả quyền của editor + quản lý nhân viên trong phòng ban.
- **Knowledge Admin / System Admin** — duyệt kế hoạch biên soạn, quản lý toàn bộ hệ thống.
