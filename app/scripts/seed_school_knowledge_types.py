"""
Replace the 5 default knowledge types (General/SOP/Product/Project/Customer)
with 15 school-specific knowledge types.

Strategy:
  1. Insert 15 new school KTs (idempotent on slug).
  2. For unused default KTs (sop, product, project, customer — 0 source refs),
     hard-delete the row.
  3. For 'general' (which has source + wiki page references), REMAP the
     references to 'tai-lieu-chung' instead of deleting, then delete the
     old row.

Why remap vs cascade: wiki_pages.knowledge_type_slugs is a string array,
not a FK. Cascading wouldn't touch it. Manual remap keeps wiki searchable
under the new canonical slug.

Usage (inside the API container):
    docker exec arkon_api python -m app.scripts.seed_school_knowledge_types

Safe to re-run.
"""

import asyncio
import uuid

from sqlalchemy import delete, select, text, update

from app.database import async_session_factory
from app.database.models import KnowledgeType, Source


# ---------------------------------------------------------------------------
# School knowledge type catalog
# ---------------------------------------------------------------------------

SCHOOL_KTS: list[dict] = [
    # Bản chất — tag theo loại tài liệu, không theo phòng ban
    {"slug": "tai-lieu-chung", "name": "Tài liệu chung", "color": "#64748b",
     "description": "Tài liệu áp dụng toàn trường (nội quy, sơ đồ tổ chức, tầm nhìn).", "sort_order": 0},
    {"slug": "quy-trinh-sop", "name": "Quy trình SOP", "color": "#0ea5e9",
     "description": "Quy trình vận hành chuẩn — checklist, hướng dẫn từng bước.", "sort_order": 10},
    {"slug": "chinh-sach", "name": "Chính sách", "color": "#8b5cf6",
     "description": "Chính sách, nội quy, quy định nội bộ.", "sort_order": 20},
    {"slug": "bieu-mau", "name": "Biểu mẫu", "color": "#10b981",
     "description": "Form, template, đơn từ — tài liệu trắng để điền.", "sort_order": 30},
    {"slug": "hop-dong", "name": "Hợp đồng", "color": "#f59e0b",
     "description": "Hợp đồng lao động, hợp đồng phụ huynh, hợp đồng đối tác.", "sort_order": 40},
    {"slug": "phap-ly", "name": "Pháp lý - Văn bản", "color": "#dc2626",
     "description": "Công văn, quyết định, văn bản pháp luật từ cơ quan quản lý giáo dục.", "sort_order": 50},

    # Học thuật
    {"slug": "chuong-trinh-day", "name": "Chương trình giảng dạy", "color": "#3b82f6",
     "description": "Giáo trình, syllabus, lesson plan, đề kiểm tra.", "sort_order": 60},
    {"slug": "ket-qua-hoc-tap", "name": "Kết quả học tập", "color": "#06b6d4",
     "description": "Bảng điểm, học bạ, báo cáo tiến độ học sinh.", "sort_order": 70},

    # Vận hành
    {"slug": "tai-chinh", "name": "Tài chính - Học phí", "color": "#eab308",
     "description": "Học phí, lương, ngân sách, báo cáo thu chi, hóa đơn.", "sort_order": 80},
    {"slug": "tuyen-sinh", "name": "Tuyển sinh", "color": "#ec4899",
     "description": "Brochure, hồ sơ ứng viên, kết quả test đầu vào, chính sách học bổng.", "sort_order": 90},
    {"slug": "marketing-truyen-thong", "name": "Marketing - Truyền thông", "color": "#f97316",
     "description": "Content, ảnh, video, kế hoạch truyền thông, brand guideline.", "sort_order": 100},
    {"slug": "su-kien", "name": "Sự kiện - Tổ chức", "color": "#a855f7",
     "description": "Kịch bản, timeline, danh sách khách mời, tư liệu sự kiện đã/sẽ tổ chức.", "sort_order": 110},

    # Hỗ trợ
    {"slug": "nhan-su", "name": "Nhân sự - HR", "color": "#14b8a6",
     "description": "Hồ sơ nhân viên, BHXH, đào tạo nội bộ, đánh giá hiệu suất.", "sort_order": 120},
    {"slug": "y-te-an-toan", "name": "Y tế - An toàn", "color": "#22c55e",
     "description": "Hồ sơ y tế học sinh, sơ cứu, an toàn trường học, phòng dịch.", "sort_order": 130},
    {"slug": "ky-thuat-it", "name": "Kỹ thuật - IT", "color": "#6366f1",
     "description": "Tài liệu kỹ thuật, hướng dẫn IT, cấu hình hệ thống, bảo trì.", "sort_order": 140},
]

# Mapping default slug → school slug for safe remap of existing data
REMAP_SLUGS: dict[str, str] = {
    "general": "tai-lieu-chung",
    "sop":     "quy-trinh-sop",
    "product": "tai-lieu-chung",
    "project": "su-kien",
    "customer": "tai-lieu-chung",
}


async def main() -> None:
    async with async_session_factory() as session:
        # ── Step 1: Insert 15 school KTs (idempotent on slug) ──
        existing_slugs = {
            r.slug
            for r in (await session.execute(select(KnowledgeType))).scalars().all()
        }
        inserted = 0
        for spec in SCHOOL_KTS:
            if spec["slug"] in existing_slugs:
                continue
            session.add(KnowledgeType(id=uuid.uuid4(), **spec))
            inserted += 1
            print(f"  + KT: {spec['slug']} — {spec['name']}")
        await session.flush()

        # ── Step 2: Remap source FK + wiki array refs ──
        remapped_sources = 0
        for old_slug, new_slug in REMAP_SLUGS.items():
            old = (await session.execute(
                select(KnowledgeType).where(KnowledgeType.slug == old_slug)
            )).scalar_one_or_none()
            if not old:
                continue
            new = (await session.execute(
                select(KnowledgeType).where(KnowledgeType.slug == new_slug)
            )).scalar_one_or_none()
            if not new:
                print(f"  ! cannot remap '{old_slug}' → '{new_slug}': target KT not found")
                continue

            # Remap sources.knowledge_type_id
            res = await session.execute(
                update(Source)
                .where(Source.knowledge_type_id == old.id)
                .values(knowledge_type_id=new.id)
            )
            remapped_sources += res.rowcount or 0

            # Remap wiki_pages.knowledge_type_slugs (Postgres array_replace)
            await session.execute(
                text("""
                    UPDATE wiki_pages
                    SET knowledge_type_slugs = array_replace(knowledge_type_slugs, :old, :new)
                    WHERE :old = ANY(knowledge_type_slugs)
                """),
                {"old": old_slug, "new": new_slug},
            )

            print(f"  ↻ remap KT: {old_slug} → {new_slug}")

        # ── Step 3: Delete the 5 default KTs ──
        deleted = await session.execute(
            delete(KnowledgeType).where(
                KnowledgeType.slug.in_(list(REMAP_SLUGS.keys()))
            )
        )
        await session.commit()

        print(
            f"\nDone. Inserted {inserted}/{len(SCHOOL_KTS)} school KTs, "
            f"remapped {remapped_sources} sources, "
            f"deleted {deleted.rowcount or 0} default KTs."
        )


if __name__ == "__main__":
    asyncio.run(main())
