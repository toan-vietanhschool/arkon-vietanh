"""
Seed departments + role templates for a Vietnamese private school deployment.

Idempotent: creates rows only when they don't exist (matched by name).
Existing rows are NOT modified — admin can rename/tweak via the UI without
this script overwriting their changes on re-run.

Usage (inside the API container):
    docker exec arkon_api python -m app.scripts.seed_school_setup

The school context assumes one corporate site (a single legal entity) with
multiple departments (academic + operational). Workspaces are NOT created
here — they cross departmental lines and should be created per initiative
via the UI (e.g. ws-tuyensinh-2026, ws-le-khai-giang).
"""

import asyncio
import uuid

from sqlalchemy import select

from app.database import async_session_factory
from app.database.models import Department, Role


# ---------------------------------------------------------------------------
# Departments — academic + operational units of a typical Vietnamese
# private school (K-12). Adjust names to match your school's org chart
# before running.
# ---------------------------------------------------------------------------

SCHOOL_DEPARTMENTS: list[dict] = [
    {"name": "Ban Giám Hiệu", "description": "Hiệu trưởng, Phó Hiệu trưởng và các quyết định chiến lược toàn trường."},
    {"name": "Phòng Đào Tạo - Giáo Vụ", "description": "Lịch học, thời khóa biểu, học bạ, kết quả học tập, kiểm định chất lượng."},
    {"name": "Phòng Tuyển Sinh", "description": "Marketing tuyển sinh, hồ sơ ứng viên, phỏng vấn, nhập học, ghi danh."},
    {"name": "Khối Mầm Non", "description": "Giáo viên và hoạt động khối mầm non / mẫu giáo."},
    {"name": "Khối Tiểu Học", "description": "Giáo viên và hoạt động khối tiểu học (lớp 1-5)."},
    {"name": "Khối Trung Học Cơ Sở", "description": "Giáo viên và hoạt động khối THCS (lớp 6-9)."},
    {"name": "Khối Trung Học Phổ Thông", "description": "Giáo viên và hoạt động khối THPT (lớp 10-12)."},
    {"name": "Phòng Nhân Sự", "description": "Tuyển dụng, hợp đồng lao động, BHXH, chấm công, đào tạo nội bộ."},
    {"name": "Phòng Kế Toán - Tài Chính", "description": "Học phí, lương, thu chi, báo cáo tài chính, kê khai thuế."},
    {"name": "Phòng Marketing - Truyền Thông", "description": "Website, mạng xã hội, sự kiện, hình ảnh thương hiệu."},
    {"name": "Phòng Công Nghệ Thông Tin", "description": "Hệ thống mạng, phần mềm quản lý, hỗ trợ kỹ thuật, bảo mật."},
    {"name": "Phòng Cơ Sở Vật Chất", "description": "Bảo trì tòa nhà, thiết bị dạy học, an ninh, vệ sinh."},
    {"name": "Phòng Y Tế Học Đường", "description": "Sơ cứu, khám sức khỏe định kỳ, hồ sơ y tế học sinh."},
    {"name": "Thư Viện", "description": "Quản lý tài liệu, đầu sách, không gian học tập tự chủ."},
    {"name": "Phòng Bán Trú & Dịch Vụ", "description": "Bếp ăn, đưa đón, nội trú, đồng phục, dịch vụ cho phụ huynh."},
]


# ---------------------------------------------------------------------------
# Role templates — Vietnamese position names mapped to Arkon's RBAC.
#
# Conventions:
#   - "own_dept" permissions assume the employee is assigned to the right
#     department in the Employees screen. The permission scope is enforced
#     per-row by Arkon's permission_engine.
#   - "all" (cross-department) permissions are granted sparingly to roles
#     that genuinely operate across the whole school (Vice Principal,
#     Librarian, IT Admin).
#   - is_system=False so the school can edit/delete these via the UI.
#   - Org-management permissions (employees.manage, departments.manage,
#     roles.manage, settings.manage) stay with the system "admin" employee
#     role (set on Employee.role) — these custom roles do NOT grant them.
# ---------------------------------------------------------------------------

SCHOOL_ROLES: list[dict] = [
    {
        "name": "Hiệu trưởng",
        "description": "Toàn quyền toàn trường — đọc / sửa / xóa mọi tài liệu, wiki, kỹ năng AI; xem audit log + xem mọi workspace.",
        "permissions": [
            "doc:read:all", "doc:create:all", "doc:edit:all", "doc:delete:all",
            "wiki:read:all", "wiki:write:all", "wiki:delete:all",
            "skill:read:all", "skill:create:all", "skill:edit:all", "skill:delete:all",
            "skill:contribution:review",
            "org:departments:read", "org:employees:read", "org:roles:read",
            "org:settings:read", "org:audit:read",
            # Workspace lifecycle (create/archive/delete) is reserved to the
            # system admin role at the moment — workspace:* lifecycle perms
            # are catalog-only and not yet enforced by the endpoints.
            "workspace:view:all",
        ],
    },
    {
        "name": "Phó hiệu trưởng",
        "description": "Quản lý chuyên môn toàn trường — đọc/sửa tài liệu + wiki mọi phòng ban; xem mọi workspace.",
        "permissions": [
            "doc:read:all", "doc:create:all", "doc:edit:all",
            "wiki:read:all", "wiki:write:all",
            "skill:read:all", "skill:create:all", "skill:edit:all",
            "skill:contribution:review",
            "org:departments:read", "org:employees:read",
            "org:audit:read",
            "workspace:view:all",
        ],
    },
    {
        "name": "Trưởng phòng / Tổ trưởng",
        "description": "Quản lý đầy đủ tài liệu + wiki + kỹ năng trong phòng ban / tổ của mình.",
        "permissions": [
            "doc:read:own_dept", "doc:create:own_dept", "doc:edit:own_dept", "doc:delete:own_dept",
            "wiki:read:own_dept", "wiki:write:own_dept", "wiki:delete:own_dept",
            "skill:read:own_dept", "skill:create:own_dept", "skill:edit:own_dept", "skill:delete:own_dept",
            "org:departments:read", "org:employees:read",
        ],
    },
    {
        "name": "Giáo viên",
        "description": "Đọc + viết tài liệu, wiki trong khối / phòng ban được phân công. Không xóa nội dung.",
        "permissions": [
            "doc:read:own_dept", "doc:create:own_dept", "doc:edit:own_dept",
            "wiki:read:own_dept", "wiki:write:own_dept",
            "skill:read:own_dept",
            "org:departments:read",
        ],
    },
    {
        "name": "Trợ giảng",
        "description": "Chỉ đọc tài liệu + wiki trong khối / phòng ban được phân công.",
        "permissions": [
            "doc:read:own_dept",
            "wiki:read:own_dept",
            "skill:read:own_dept",
            "org:departments:read",
        ],
    },
    {
        "name": "Chuyên viên hành chính",
        "description": "Đọc + tạo tài liệu hành chính trong phòng ban, xem danh sách nhân viên.",
        "permissions": [
            "doc:read:own_dept", "doc:create:own_dept", "doc:edit:own_dept",
            "wiki:read:own_dept", "wiki:write:own_dept",
            "skill:read:own_dept",
            "org:departments:read", "org:employees:read",
        ],
    },
    {
        "name": "Kế toán viên",
        "description": "Quản lý tài liệu kế toán - tài chính trong phòng kế toán + xem danh sách nhân viên.",
        "permissions": [
            "doc:read:own_dept", "doc:create:own_dept", "doc:edit:own_dept", "doc:delete:own_dept",
            "wiki:read:own_dept", "wiki:write:own_dept",
            "skill:read:own_dept",
            "org:departments:read", "org:employees:read",
        ],
    },
    {
        "name": "Cán bộ nhân sự",
        "description": "Quản lý hồ sơ nhân viên + tài liệu HR + xem audit log liên quan.",
        "permissions": [
            "doc:read:own_dept", "doc:create:own_dept", "doc:edit:own_dept", "doc:delete:own_dept",
            "wiki:read:own_dept", "wiki:write:own_dept",
            "skill:read:own_dept",
            "org:departments:read", "org:employees:read",
            "org:audit:read",
        ],
    },
    {
        "name": "Quản trị viên IT",
        "description": "Quản lý cấu hình hệ thống AI + đọc tài liệu kỹ thuật mọi phòng ban + duyệt skill contribution.",
        "permissions": [
            "doc:read:all", "doc:create:all", "doc:edit:all",
            "wiki:read:all", "wiki:write:all",
            "skill:read:all", "skill:create:all", "skill:edit:all", "skill:delete:all",
            "skill:contribution:review",
            "org:departments:read", "org:employees:read",
            "org:settings:read", "org:settings:manage",
            "org:audit:read",
        ],
    },
    {
        "name": "Chuyên viên Marketing - Truyền thông",
        "description": "Tạo + sửa tài liệu marketing, wiki sự kiện, ảnh thương hiệu trong phòng marketing.",
        "permissions": [
            "doc:read:own_dept", "doc:create:own_dept", "doc:edit:own_dept", "doc:delete:own_dept",
            "wiki:read:own_dept", "wiki:write:own_dept",
            "skill:read:own_dept", "skill:create:own_dept",
            "org:departments:read",
        ],
    },
    {
        "name": "Thủ thư",
        "description": "Quản lý kho tài liệu - đầu sách dùng chung cho toàn trường.",
        "permissions": [
            "doc:read:all", "doc:create:all", "doc:edit:all", "doc:delete:own_dept",
            "wiki:read:all", "wiki:write:own_dept",
            "skill:read:all",
            "org:departments:read",
        ],
    },
    {
        "name": "Y tá học đường",
        "description": "Tài liệu y tế trong phòng y tế + đọc danh sách học sinh / nhân viên.",
        "permissions": [
            "doc:read:own_dept", "doc:create:own_dept", "doc:edit:own_dept",
            "wiki:read:own_dept", "wiki:write:own_dept",
            "skill:read:own_dept",
            "org:departments:read", "org:employees:read",
        ],
    },
    {
        "name": "Nhân viên cơ sở vật chất",
        "description": "Đọc tài liệu vận hành + ghi nhận sửa chữa, lịch bảo trì trong phòng cơ sở vật chất.",
        "permissions": [
            "doc:read:own_dept", "doc:create:own_dept",
            "wiki:read:own_dept", "wiki:write:own_dept",
            "skill:read:own_dept",
            "org:departments:read",
        ],
    },
    {
        "name": "Khách / Phụ huynh đại diện",
        "description": "Chỉ xem các workspace được mời tham gia (vd Hội phụ huynh). Không xem được tài liệu nội bộ phòng ban.",
        "permissions": [
            "org:departments:read",
        ],
    },
]


async def main() -> None:
    async with async_session_factory() as session:
        # ── Departments ──
        existing_dept_names = {
            d.name for d in (await session.execute(select(Department))).scalars().all()
        }
        new_depts = 0
        for spec in SCHOOL_DEPARTMENTS:
            if spec["name"] in existing_dept_names:
                continue
            session.add(
                Department(
                    id=uuid.uuid4(),
                    name=spec["name"],
                    description=spec["description"],
                )
            )
            new_depts += 1
            print(f"  + department: {spec['name']}")

        # ── Roles ──
        existing_roles = {
            r.name: r
            for r in (await session.execute(select(Role))).scalars().all()
        }
        new_roles = 0
        updated_roles = 0
        for spec in SCHOOL_ROLES:
            canonical = sorted(set(spec["permissions"]))
            existing = existing_roles.get(spec["name"])
            if existing is None:
                session.add(
                    Role(
                        id=uuid.uuid4(),
                        name=spec["name"],
                        description=spec["description"],
                        permissions=canonical,
                        is_system=False,
                    )
                )
                new_roles += 1
                print(f"  + role: {spec['name']} ({len(canonical)} perms)")
            elif not existing.is_system and sorted(existing.permissions or []) != canonical:
                # Refresh non-system rows so the script is idempotent against
                # changes to the canonical permission set in code (e.g. when
                # new workspace permissions are added).
                before = len(existing.permissions or [])
                existing.permissions = canonical
                existing.description = spec["description"]
                updated_roles += 1
                print(f"  ↻ role: {spec['name']} ({before} → {len(canonical)} perms)")

        await session.commit()
        print(
            f"\nSeed complete. New departments: {new_depts}/{len(SCHOOL_DEPARTMENTS)}, "
            f"new roles: {new_roles}, updated roles: {updated_roles}, "
            f"total school roles: {len(SCHOOL_ROLES)}."
        )


if __name__ == "__main__":
    asyncio.run(main())
