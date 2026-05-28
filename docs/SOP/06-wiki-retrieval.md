<!-- Section 06 / 10 — Wiki layer & hybrid retrieval. Một phần của Arkon SOP. -->

# Section 06 — Wiki Layer & Hybrid Retrieval

Wiki là lớp kiến thức được LLM biên soạn (LLM-compiled knowledge layer). Thay vì để Claude truy xuất trực tiếp các chunk từ source thô, hệ thống đọc source → biên soạn thành các trang wiki markdown có cấu trúc → lưu lại dưới dạng `WikiPage`. Khi MCP nhận query, nó tìm kiếm trên wiki trước, chỉ drill-down vào source khi cần trích dẫn chính xác.

---

## WikiPage — Model và các field chính

Model `WikiPage` (`app/database/models.py`, class `WikiPage`) là đơn vị lưu trữ trung tâm của wiki.

**Fields định danh:**

| Field | Type | Mô tả |
|---|---|---|
| `slug` | `String(300)` | Định danh dạng kebab-case, duy nhất trong một scope. Ví dụ: `pancake-crm`, `ky-nang-hen-gap-phu-huynh` |
| `title` | `String(500)` | Tiêu đề hiển thị |
| `page_type` | `String(30)` | Một trong: `entity`, `concept`, `source`, `topic`, `index`, `log` |

**Fields nội dung:**

| Field | Type | Mô tả |
|---|---|---|
| `content_md` | `Text` | Toàn bộ nội dung trang dạng Markdown |
| `summary` | `Text` | Tóm tắt 1-3 câu, dùng cho BM25 weight B và preview |
| `search_vector` | `TSVECTOR` | GENERATED column, tự động cập nhật bởi Postgres (xem migration 028) |

**Fields phân loại và liên kết:**

| Field | Type | Mô tả |
|---|---|---|
| `knowledge_type_slugs` | `ARRAY(String)` | Danh sách slug của knowledge types trang này thuộc về |
| `source_ids` | `ARRAY(UUID)` | Các source đã đóng góp vào nội dung trang |
| `version` | `Integer` | Tăng sau mỗi lần cập nhật nội dung; dùng để phát hiện mid-air collision |
| `orphaned` | `Boolean` | `True` khi tất cả source đã xóa nhưng trang chưa bị xóa |

**Reserved slugs:** `_index` (catalog toàn bộ wiki) và `_log` (log hoạt động theo thứ tự thời gian). Cả hai đều bị loại ra khỏi mọi kết quả tìm kiếm.

**Page types:**
- `entity` — tổ chức, sản phẩm, người, địa điểm cụ thể
- `concept` — khái niệm, quy trình, kỹ năng trừu tượng
- `source` — trang tổng hợp nội dung của một source cụ thể
- `topic` — chủ đề tổng hợp nhiều entity/concept liên quan
- `index` / `log` — dành riêng cho `_index` và `_log`

---

## WikiLink — Wikilink graph

### Cú pháp

Trong `content_md`, LLM compiler nhúng link giữa các trang bằng cú pháp:

```
[[slug]]                   — link đơn, hiển thị slug
[[slug|display text]]      — link có text hiển thị riêng
```

Regex parse (`_WIKILINK_RE`, `wiki_service.py` dòng 34):

```python
_WIKILINK_RE = re.compile(r"\[\[([^\]\|]+)(?:\|[^\]]*)?]]")
```

Pattern bắt phần slug trước `|` (hoặc toàn bộ nếu không có `|`), bỏ qua display text. Self-link (link về slug của chính trang đó) bị drop khi parse.

### Edge table `wiki_links`

| Column | Type | Ghi chú |
|---|---|---|
| `from_page_id` | UUID (FK → `wiki_pages.id` CASCADE) | Trang chứa wikilink |
| `to_slug` | `String(300)` | Slug đích — có thể là dangling (trang chưa tồn tại) |

Composite PK `(from_page_id, to_slug)`. Index trên cả hai chiều:
- `ix_wiki_links_from_page_id` — tra cứu outbound links từ một trang
- `ix_wiki_links_to_slug` — tra cứu backlinks

**Dangling links được cho phép có chủ đích.** Khi LLM biên soạn một trang mới có thể link đến trang chưa tồn tại (sẽ được tạo sau). Hệ thống không validation `to_slug` tại write time.

### `refresh_links()`

```python
async def refresh_links(
    session: AsyncSession,
    from_page_id: uuid.UUID,
    from_slug: str,
    content_md: str,
) -> None
```

Được gọi tự động sau mỗi upsert (`apply_create`, `apply_update`, `approve_draft`, `direct_edit_page`, `rollback_to_revision`). Cơ chế:

1. DELETE toàn bộ edge cũ của `from_page_id`
2. Parse wikilinks mới từ `content_md` bằng `extract_wikilinks()`
3. INSERT lại với `ON CONFLICT DO NOTHING`

Nhờ vậy graph luôn phản ánh trạng thái nội dung hiện tại mà không cần trigger phức tạp phía database.

---

## Scope model

Mỗi `WikiPage` thuộc về đúng một scope, xác định bởi cặp `(scope_type, scope_id)`.

| `scope_type` | `scope_id` | Ý nghĩa |
|---|---|---|
| `global` | `NULL` | Hiển thị cho mọi người dùng |
| `department` | UUID của phòng ban | Chỉ hiển thị cho thành viên phòng ban đó |
| `project` | UUID của workspace | Chỉ hiển thị cho thành viên workspace đó |

**Cùng slug có thể tồn tại ở nhiều scope.** Ví dụ, trang `ky-nang-hen-gap-phu-huynh` có thể tồn tại ở scope `global` (phiên bản chung) và scope `project` của workspace Trường A (phiên bản tùy chỉnh). Hai trang này độc lập hoàn toàn — phân biệt bằng `(scope_type, scope_id)`, không phải slug.

**`_scope_filter_for_identity()`** là helper chính cho MCP read path: union global + own department + all joined workspaces. Hàm `_scope_filter_with_dept()` đã deprecated vì không bao gồm project-scoped pages.

---

## Retrieval — 3 channels độc lập

### Channel 1: BM25 Lexical (`search_pages_bm25`)

```python
async def search_pages_bm25(
    session: AsyncSession,
    query: str,
    top_k: int = 30,
    allowed_kt_slugs: Optional[list[str]] = None,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
    department_id: Optional[uuid.UUID] = None,
    project_ids: Optional[list[uuid.UUID]] = None,
    inverse_scope: bool = False,
    all_scopes: bool = False,
) -> list[tuple[WikiPage, float]]
```

Dựa trên cột `search_vector` — GENERATED ALWAYS AS STORED tsvector, thêm vào bởi migration 028:

```sql
setweight(to_tsvector('simple', coalesce(title,   '')), 'A') ||
setweight(to_tsvector('simple', coalesce(summary, '')), 'B') ||
setweight(to_tsvector('simple', coalesce(content_md, '')), 'C')
```

**Tại sao dùng `simple` thay vì `english`:** Nội dung wiki chủ yếu bằng tiếng Việt. Postgres không có dictionary tiếng Việt built-in; nếu dùng `english`, Porter stemming sẽ biến đổi token tiếng Việt thành vô nghĩa. Config `simple` chỉ lowercase và tokenize theo whitespace/punctuation — đúng behavior cần thiết cho tiếng Việt.

**Weights A/B/C** ưu tiên: title hit (A) > summary hit (B) > body hit (C) khi tính rank.

**Scoring:** `ts_rank_cd(search_vector, query, 32)` — flag `32` chuẩn hóa theo độ dài trang, trả về score trong (0, 1). Trang dài không thống trị chỉ vì chứa nhiều token hơn.

**Query parsing:** `plainto_tsquery('simple', query)` — query nhiều từ thành AND lexemes, không có rủi ro operator injection.

GIN index `ix_wiki_pages_search_vector` (tạo bởi migration 028) đảm bảo `@@` match chạy nhanh trên toàn bảng.

### Channel 2: Vector Semantic (`search_pages_semantic`)

```python
async def search_pages_semantic(
    session: AsyncSession,
    query_embedding: list[float],
    top_k: int = 10,
    allowed_kt_slugs: Optional[list[str]] = None,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
    spec_id: Optional[str] = None,
    department_id: Optional[uuid.UUID] = None,
    project_ids: Optional[list[uuid.UUID]] = None,
    inverse_scope: bool = False,
    all_scopes: bool = False,
) -> list[tuple[WikiPage, float]]
```

Embedding 1536 chiều (model `text-embedding-3-small`), lưu trong bảng `wiki_page_embeddings_1536` (schema per-dimension). Tìm kiếm bằng cosine distance qua pgvector:

```python
(1 - Emb.embedding.cosine_distance(query_embedding)).label("similarity")
```

Trả về `(page, similarity)` sorted descending. Khi không có active embedding spec, trả về list rỗng thay vì raise exception.

### Channel 3: Graph Walk (`expand_via_graph_walk`)

```python
async def expand_via_graph_walk(
    session: AsyncSession,
    seed_page_ids: list[uuid.UUID],
    seed_scores: dict[uuid.UUID, float],
    max_hops: int = 2,
    decay: float = 0.5,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
    department_id: Optional[uuid.UUID] = None,
    project_ids: Optional[list[uuid.UUID]] = None,
    all_scopes: bool = False,
    include_backlinks: bool = False,
) -> dict[uuid.UUID, float]
```

BFS tối đa `max_hops` bước (mặc định 2) qua bảng `wiki_links`. Score của trang được khám phá:

```
score(p) += decay^hop * seed_score_of_source
```

Với `decay=0.5`: hop 1 mang 50% score của seed, hop 2 mang 25%. Nhiều path từ nhiều seed SUM lại (thưởng cho trang được nhiều seed trỏ đến). Scope filter áp dụng ở JOIN target — trang ngoài scope không reachable dù link tồn tại.

---

## Hybrid Orchestrator (`search_pages_hybrid`)

```python
async def search_pages_hybrid(
    session: AsyncSession,
    query: str,
    query_embedding: list[float],
    top_k: int = 10,
    ...
    candidate_pool: int = 30,
    rrf_k: int = 60,
    graph_hops: int = 2,
    graph_decay: float = 0.5,
    graph_weight: float = 0.0,
) -> list[tuple[WikiPage, float]]
```

### Pipeline chi tiết

```
┌─────────────────────────────────────────────────────────────┐
│                       User query                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
   ┌─────────────────┐       ┌──────────────────────┐
   │  BM25 lexical   │       │  Vector semantic      │
   │  plainto_tsquery│       │  cosine distance      │
   │  top-30 hits    │       │  top-30 hits          │
   │  ts_rank_cd     │       │  pgvector (1536-dim)  │
   └────────┬────────┘       └──────────┬────────────┘
            │                           │
            └───────────┬───────────────┘
                        │
                        ▼
           ┌────────────────────────┐
           │  Reciprocal Rank Fusion│
           │  score(p) = Σ 1/(60+r) │
           │  across both channels  │
           └────────────┬───────────┘
                        │
           graph_weight > 0? ─── NO ──────────────────┐
                        │                              │
                       YES                             │
                        │                              │
                        ▼                              │
           ┌────────────────────────┐                  │
           │  Graph walk (optional) │                  │
           │  BFS 2-hop wikilinks   │                  │
           │  decay=0.5, sum paths  │                  │
           │  rerank only — không   │                  │
           │  thêm trang mới        │                  │
           └────────────┬───────────┘                  │
                        │                              │
                        └──────────────┬───────────────┘
                                       │
                                       ▼
                        ┌──────────────────────────┐
                        │  Normalize top → ~1.0    │
                        │  (UX: hiển thị %)        │
                        └──────────────┬───────────┘
                                       │
                                       ▼
                              Final ranked list
```

### RRF fusion

BM25 và vector similarity sống trên hai scale khác nhau (`ts_rank_cd` ≈ 0.0–1.0 normalized, cosine ≈ 0.7–1.0 cho good matches). Weighted sum trực tiếp thiên vị bất kỳ channel nào có giá trị tuyệt đối lớn hơn. RRF làm việc trong rank space:

```
rrf_score(page) = Σ_channel  1 / (60 + rank_in_channel)
```

`rrf_k=60` là giá trị chuẩn từ Cormack et al. 2009 — đủ lớn để làm phẳng độ biến thiên ở top ranks mà không xóa mờ tín hiệu.

### Normalize score

Raw RRF scores xấp xỉ `1/(60 + rank)` ≈ 0.016 cho top result. Hiển thị thẳng dưới dạng phần trăm ("2% match") gây hiểu lầm. Sau khi sort, scale tất cả scores bằng `1/top_score` để top result ≈ 1.0 (100%). Thứ tự tương đối không thay đổi.

### Tại sao `graph_weight=0` là default

Trên corpus dày (> 20 sources với nhiều cross-source link), graph re-ranking tạo ra **hub bias**: các trang được nhiều candidate khác link đến (ví dụ trang tổng quan) luôn nổi lên top, bất kể query cụ thể là gì. Điều này làm giảm topical precision — khi user hỏi về một kỹ năng cụ thể, hệ thống trả về trang overview thay vì trang chi tiết nhất.

Graph walk vẫn là primitive độc lập, caller tự quyết định khi nào cần:

| Tình huống | `graph_weight` | Lý do |
|---|---|---|
| Main search, corpus dày (> 20 sources) | `0.0` (default) | Tránh hub bias |
| "Related pages" sidebar | `0.05` | Cần bridge awareness |
| Corpus nhỏ (< 20 sources) | `0.05` | Hub bias ít ảnh hưởng hơn |

---

## Migration 028 — `search_vector` GENERATED column

File: `alembic/versions/028_wiki_search_vector.py`

```sql
ALTER TABLE wiki_pages
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(content_md, '')), 'C')
) STORED;

CREATE INDEX ix_wiki_pages_search_vector ON wiki_pages USING GIN (search_vector);
```

`GENERATED ALWAYS AS ... STORED` — Postgres tự cập nhật cột này sau mỗi INSERT/UPDATE, không cần trigger phía application. Cột được khai báo `deferred` trong ORM (`app/database/models.py`) để `SELECT WikiPage` thông thường không kéo toàn bộ lexeme blob vào Python.

---

## Ví dụ thực tế từ test A/B

| Query | Channel hiệu quả | Kết quả |
|---|---|---|
| `"Pancake CRM"` | BM25 | Exact match tên sản phẩm — BM25 bắt được ngay, hybrid top-1 đúng source |
| `"cách giúp con cái đi học vui vẻ"` | Vector | Paraphrase của "kỹ năng tạo động lực cho học sinh" — semantic embedding bắt được synonym, BM25 miss |
| `"kỹ năng hẹn gặp phụ huynh"` | Hybrid | Topical query — vector surface concept, BM25 reinforce bằng title match → hybrid ưu tiên đúng source HoangYen |

Pattern tổng quát: query keyword chính xác → BM25 dẫn đầu; query paraphrase/câu hỏi tự nhiên → vector dẫn đầu; query topical → hybrid thắng cả hai.

---

## Checklist vận hành

- Sau khi thêm source mới, kiểm tra `wiki_pages.search_vector IS NOT NULL` cho các trang được tạo từ source đó — nếu NULL nghĩa là trang được tạo trước migration 028 và cần `UPDATE wiki_pages SET content_md = content_md WHERE id = ...` để trigger regeneration.
- Khi enable `graph_weight > 0` cho production, monitor xem top results có bị dominated bởi một vài hub pages không. Nếu có, đưa về `0.0`.
- `expand_via_graph_walk` trả về cả seed pages trong kết quả — caller không cần merge thủ công.
- `search_pages_bm25` trả về list rỗng khi query toàn stopword hoặc punctuation — đây là behavior đúng, không phải lỗi.
