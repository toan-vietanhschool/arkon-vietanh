<!-- Section 05 / 10 — Source pipeline MRP. Một phần của Arkon SOP. -->

# Section 05 — Source Pipeline và MRP

Tài liệu này mô tả toàn bộ vòng đời của một source từ lúc upload đến khi trở thành wiki pages có cấu trúc. Cơ chế cốt lõi là pipeline **MRP (Map–Reduce–Plan)**, gồm 6 phase chạy trên arq worker thông qua hai entry point tách biệt.

---

## Source lifecycle và pipeline phases

### Trạng thái `status` của source

| `status`      | Ý nghĩa |
|---------------|---------|
| `pending`     | Source vừa được tạo, chưa bắt đầu xử lý |
| `processing`  | Đang chạy pipeline (cả Phase 0–2 lẫn Phase 3–5) |
| `plan_ready`  | Phase 0–2 xong, đang chờ admin/editor duyệt plan |
| `ready`       | Pipeline hoàn tất, wiki pages đã được commit |
| `error`       | Một phase nào đó thất bại |

### `pipeline_phase` — vị trí hiện tại trong pipeline

`map` → `reduce` → `plan_review` → `refine` → `verify` → `commit`

Trường này được cập nhật sau mỗi phase và cho phép pipeline resume từ đúng vị trí sau crash thay vì chạy lại từ đầu.

---

## Sơ đồ flow: từ upload đến wiki pages

```
Upload file (PDF / MD / DOCX)
        │
        ▼
[ ingest_file_task ]         progress: 0 → 55%
  ├─ Download từ MinIO
  ├─ Extract text theo trang
  ├─ Extract + caption images
  └─ Build outline_json + full_text
        │
        ▼ (enqueue)
[ ingest_map_reduce_task ]   progress: 55 → 80%
  ├─ Phase 0: Triage (classify_strategy)
  ├─ Phase 1: MAP (extract_chunk × N, parallel)
  └─ Phase 2: REDUCE (dedup → KB reconcile → plan)
        │
        ├── mrp_auto_approve_plan=True
        │       └─ enqueue ingest_refine_task ngay
        │
        └── mrp_auto_approve_plan=False
                └─ source.status = "plan_ready"
                   Chờ human approve qua UI
                        │
                        ▼ (POST /sources/{id}/plan/approve)
[ ingest_refine_task ]       progress: 78 → 100%
  ├─ Phase 3: REFINE (write wiki pages, parallel)
  ├─ Phase 4: VERIFY (coverage + conflict check)
  └─ Phase 5: COMMIT (upsert wiki_pages + embed)
        │
        ▼
source.status = "ready"     progress: 100%
wiki pages sẵn sàng trong KB
```

---

## Phase 0 — Triage

**File:** `app/ai/mrp/mapper.py` — `classify_strategy()`

Dựa vào độ dài `full_text`, pipeline chọn một trong ba strategy:

| Strategy       | Điều kiện           |
|----------------|---------------------|
| `single_pass`  | < 30.000 ký tự      |
| `standard`     | 30.000 – 200.000 ký tự |
| `hierarchical` | > 200.000 ký tự     |

Strategy được lưu vào `source.pipeline_strategy` và ảnh hưởng đến số lượng trang mục tiêu ở Phase 2.

---

## Phase 1 — MAP

**File:** `app/ai/mrp/mapper.py` — `run_map_phase()`, `build_chunks()`, `extract_chunk()`

### Chunking

`build_chunks()` chia `full_text` thành các `DocumentChunk` dựa trên outline headings cấp 1–2 (`outline_json`). Mỗi chunk nhắm tới khoảng 20.000 ký tự (`CHUNK_TARGET_CHARS`), với 1.000 ký tự overlap từ chunk trước. Nếu không có outline, fallback sang sliding-window.

### Extraction

Mỗi chunk được gửi song song đến LLM (tối đa 6 goroutine đồng thời, `MAX_MAP_CONCURRENCY = 6`) qua `extract_chunk()`. LLM trả về JSON với 4 category:

- **entities** — người, tổ chức, sản phẩm, hệ thống... (có `name`, `type`, `aliases`)
- **concepts** — thuật ngữ có định nghĩa hoặc topic section thematic
- **claims** — phát biểu sự thật có thể kiểm chứng, kèm `subject` và `confidence`
- **relations** — quan hệ giữa các entity

Kết quả của mỗi chunk được persist ngay vào bảng `SourceChunkExtract` (trạng thái `done`). Chunk nào lỗi được retry một lần tuần tự trước khi bỏ qua.

**Tiến độ tracker:** 10% → 50% trong giai đoạn này.

---

## Phase 2 — REDUCE

**File:** `app/ai/mrp/reducer.py` — `run_reduce_phase()`

Phase này gộp toàn bộ output của MAP, loại bỏ trùng lặp, đối chiếu với KB hiện có, rồi sinh ra `SourceCompilationPlan`.

### 2.1 Thu thập raw items

`collect_raw_items()` flatten tất cả `extract_json` từ các `SourceChunkExtract` thành ba list: entities, concepts, claims.

### 2.2 Exact deduplication

`exact_dedup_entities()` và `exact_dedup_concepts()` nhóm theo tên đã normalize (lowercase, bỏ dấu câu). Mỗi nhóm chọn tên xuất hiện nhiều nhất làm canonical, tích lũy aliases và `mention_count`.

### 2.3–2.4 Embedding deduplication

`embedding_dedup_entities()` embed tên entity rồi tính cosine similarity từng cặp cùng `type`:

| Ngưỡng | Hành động |
|--------|-----------|
| sim ≥ 0.90 | Auto-merge |
| 0.75 ≤ sim < 0.90 | Gửi LLM phân giải (batch boolean) |
| sim < 0.75 | Giữ tách biệt |

`resolve_ambiguous_entities()` gửi một lần duy nhất các cặp còn mơ hồ lên LLM để xác nhận.

### 2.5–2.6 KB reconciliation

`reconcile_with_kb()` embed tên entity/concept rồi tìm kiếm semantic trên wiki hiện có. Kết quả cho mỗi item:

| `action` | Điều kiện |
|----------|-----------|
| `UPDATE` | sim ≥ 0.85 với trang đã có |
| `MAYBE`  | 0.60 ≤ sim < 0.85 — gửi LLM xác nhận |
| `CREATE` | sim < 0.60 hoặc không tìm thấy |

### 2.7 Planning call

`run_planning_call()` gửi một LLM call tổng hợp: danh sách canonical entities + concepts (sắp xếp theo `mention_count` giảm dần) + kết quả reconciliation → LLM trả về `SourceCompilationPlan` JSON gồm danh sách pages với slug, title, `page_type`, `action`, `entity_names`, `priority`.

Số trang mục tiêu được tính từ tổng số items extracted và strategy (ví dụ `standard`: `max(8, min(30, total_items // 3))`).

### 2.8 Persist plan

Plan được upsert vào bảng `source_compilation_plans` với `status = "pending_review"` và `source.pipeline_phase = "plan_review"`.

**Tiến độ tracker:** 50% → 80%.

---

## Phase 2.5 — Plan Review

Sau khi REDUCE hoàn tất, pipeline dừng lại ở trạng thái `plan_ready` để chờ phê duyệt (trừ khi `mrp_auto_approve_plan=True`).

### Luồng phê duyệt

Admin hoặc editor mở plan review dialog trong UI và có ba lựa chọn:

1. **Approve** — gọi `POST /sources/{id}/plan/approve`, backend enqueue `ingest_refine_task`.
2. **Reject + comment** — ghi `review_note`, plan về trạng thái `rejected`; source dừng.
3. **Regenerate với feedback** — truyền `user_note` vào `run_planning_call()` lần hai; LLM tích hợp feedback vào plan mới.

Khi plan được approve, `SourceCompilationPlan.status` chuyển sang `"approved"` và `reviewed_at` được ghi lại. `ingest_refine_task` được enqueue ngay sau đó.

---

## Phase 3 — REFINE (Write)

**File:** `app/ai/mrp/writer.py` — `run_refine_phase()`, `_write_page_simple()`, `_write_page_complex()`

Mỗi page trong compilation plan được viết song song (tối đa 4 goroutine, `MAX_WRITER_CONCURRENCY = 4`). Mỗi writer nhận evidence đã được pre-assemble từ claims, không phải scan lại full text.

### Chọn writer mode

| Mode | Điều kiện |
|------|-----------|
| Simple | ≤ 8 evidence items và existing content ≤ 3.000 ký tự |
| Complex | > 8 evidence items hoặc existing content > 3.000 ký tự |

**Simple writer** (`_write_page_simple`): 1 LLM call duy nhất với toàn bộ context (source text đã smart-budget, evidence checklist, danh sách slugs để cross-link).

**Complex writer** (`_write_page_complex`): mini agent loop tối đa 10 bước, có 3 tool: `read_kb_page`, `read_source_excerpt`, `finish`. Thích hợp cho page có nhiều thông tin hoặc cần đọc thêm từ KB hiện có.

### Cross-link policy (từ `_SIMPLE_WRITER_PROMPT`)

- **Sibling pages** (cùng plan): link tự do vì chúng share context.
- **`kb_neighbors`** (pages từ sources khác): chỉ link khi topic thực sự overlap. Bridging knowledge giữa các nguồn là tính năng, nhưng không ép link nếu overlap yếu.
- Chỉ dùng slug từ hai danh sách trên; **không bịa slug**.

### Quy tắc WRITER quan trọng nhất (từ `WRITER_SYSTEM`)

**PRESERVE QUANTITATIVE FACTS VERBATIM** — đây là rule #1, vi phạm là fail page.

Mọi số liệu có trong source phải xuất hiện y nguyên trong output: đếm/tối thiểu/tối đa, khoảng thời gian, phần trăm/tỷ lệ, tiền/giá, ngày tháng, số điện thoại/email.

Ví dụ từ prompt:

```
BAD:  "Cần duy trì liên lạc với khách hàng cho đến khi họ có nhu cầu."
GOOD: "Mỗi sale cần duy trì danh sách ≥ 200 khách hàng dự trữ,
       mỗi khách được chăm sóc kỹ trong 3 ngày đầu sau khi tiếp cận."
```

Các quy tắc khác:
- Không có mục Citations hoặc Footnotes.
- Không dùng `[^N]` footnote markers.
- Viết cùng ngôn ngữ với source, không dịch.
- Mỗi page phải có opening paragraph prose (không heading), rồi mới H2 sections.

Sau khi tất cả writers hoàn tất, drafts được persist vào `plan_json._page_drafts` để phase sau có thể resume mà không cần chạy lại REFINE.

**Tiến độ tracker:** 78% → 88%.

---

## Phase 4 — VERIFY

**File:** `app/ai/mrp/verifier.py` — `run_verify_phase()`

Hai kiểm tra, đều **non-blocking** — lỗi được log nhưng không dừng pipeline:

### 4.1 Coverage check

`check_coverage()` đếm mention_count của mỗi entity từ chunk extracts, so sánh với danh sách entity được cover bởi page results. Entity có ≥ 3 mentions mà không có page nào cover sẽ bị log warning.

### 4.2 Conflict check

`check_conflicts()` embed nội dung từng page mới, tìm KB neighbors có similarity ≥ 0.80, rồi gửi LLM xác nhận có mâu thuẫn factual không. Conflict được log nhưng không block commit.

**Tiến độ tracker:** 88% → 95%.

---

## Phase 5 — COMMIT

**File:** `app/ai/mrp/pipeline.py` — `run_commit_phase()`

### Wiki scope resolution

`_resolve_wiki_scopes()` xác định đích commit:

1. Source thuộc workspace → commit vào scope `project`.
2. Source global → commit vào department scope (nếu có `SourceDepartment` rows); nếu không có department → scope `global`.
3. Bất kỳ workspace nào đã link source qua `ProjectSource` cũng nhận bản copy (scope `project`).

Kết quả là list `(scope_type, scope_id)` deduplicated. Mỗi scope được commit độc lập, tránh race condition qua `pg_advisory_xact_lock` per `(slug, scope)`.

### Upsert logic

Với action `CREATE`: gọi `wiki_service.apply_create()`. Nếu phát hiện page đã tồn tại (concurrent pipeline), tự động chuyển sang `UPDATE`.

Với action `UPDATE`: gọi `wiki_service.apply_update()`. Nếu source mới và existing content > 100 ký tự, gọi `merge_page_content()` để LLM merge nội dung thay vì ghi đè.

Sau mỗi page, embedding được tính và upsert qua `upsert_page_embedding()`. Cuối mỗi scope, `wiki_service.regenerate_index()` được gọi.

Khi tất cả scopes xong:
- `source.status = "ready"`
- `source.pipeline_phase = "commit"`
- `source.progress = 100`
- `source.progress_message = "Done"`

---

## Ví dụ thực tế

**Input:** Upload `5_Ms_HoangYen_Chien_luoc_hen_gap.md` vào department "Tuyển Sinh".

| Bước | Kết quả |
|------|---------|
| ingest_file_task | full_text = ~18.000 ký tự, strategy = `single_pass` |
| Phase 1 MAP | 1 chunk → LLM extract 12 entities/concepts + 8 claims |
| Phase 2 REDUCE | Exact dedup: 3 entity trùng gộp → còn 9 canonical items |
| KB reconciliation | 2 item → UPDATE (đã có trong KB), 7 item → CREATE |
| Planning call | Plan với 12 pages (1 source page + 11 entity/concept pages) |
| Plan review | Admin approve, enqueue ingest_refine_task |
| Phase 3 REFINE | 12 writers chạy parallel (3 complex, 9 simple) |
| Phase 4 VERIFY | Coverage ok, 0 conflict detected |
| Phase 5 COMMIT | +10 pages created, ~2 pages updated trong scope `department` Tuyển Sinh |
| Kết quả | source.status = "ready", progress = 100% |

---

## Chi phí và thời gian

| Chỉ số | Giá trị điển hình |
|--------|-------------------|
| Chi phí LLM | ~$0.025/source với gpt-4o-mini |
| Thời gian end-to-end | 60–120 giây/source |
| Rate limit OpenAI Tier 1 | 200.000 TPM với gpt-4o-mini |
| Concurrency MAP | 6 chunk calls song song |
| Concurrency REFINE | 4 writer calls song song |

---

## Retry và recovery

### Source bị lỗi (`status = "error"`)

Gọi retry endpoint để re-enqueue `ingest_map_reduce_task`. Pipeline tự resume từ phase cuối cùng thành công nhờ `pipeline_phase` field.

### Source stuck ở `processing` > 5 phút

Kiểm tra arq worker có đang chạy không. Nếu worker crash giữa chừng, set `source.status = "pending"` và re-enqueue thủ công.

### Re-run chỉ REFINE phase (bỏ qua MAP + REDUCE)

Khi plan đã được approve nhưng cần viết lại nội dung pages (ví dụ thay đổi prompt):

1. Set `source.pipeline_phase = "refine"` trong DB.
2. Xóa `plan_json._page_drafts` (set về `null` hoặc `{}`).
3. Re-enqueue `ingest_refine_task` — pipeline sẽ chạy lại từ Phase 3, không đụng đến MAP/REDUCE.

### Plan bị reject

Source dừng lại. Có thể call regenerate API với `user_note` chứa feedback, sau đó approve plan mới.
