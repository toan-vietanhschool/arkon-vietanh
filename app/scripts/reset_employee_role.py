"""
Reset the system 'Employee' role to the canonical EMPLOYEE_DEFAULT_PERMISSIONS
baseline. Idempotent.

Background: older deployments stored the Employee role with full god-mode
permissions (including `org:settings:manage`, `org:roles:manage`, etc.).
Since every non-admin employee inherits this role's permissions when no
custom role is assigned, that is a critical privilege-escalation hole.

The canonical baseline is defined in `app/services/permissions.py` and
gives just enough access for staff to do their day-to-day work in their
own department (read/create docs + read/write wiki + read skills + view
department list).

Anything beyond baseline (delete, cross-department, org-management) MUST
be granted via an explicit custom role.

Usage (inside the API container):
    docker exec arkon_api python -m app.scripts.reset_employee_role
"""

import asyncio

from sqlalchemy import select

from app.database import async_session_factory
from app.database.models import Role
from app.services.permissions import EMPLOYEE_DEFAULT_PERMISSIONS


async def main() -> None:
    baseline = sorted(set(EMPLOYEE_DEFAULT_PERMISSIONS))

    async with async_session_factory() as session:
        row = (
            await session.execute(select(Role).where(Role.name == "Employee"))
        ).scalar_one_or_none()

        if row is None:
            print("No 'Employee' role found — nothing to do.")
            return

        before = sorted(row.permissions or [])
        if before == baseline:
            print(f"'Employee' already at baseline ({len(baseline)} perms). No change.")
            return

        removed = [p for p in before if p not in baseline]
        added = [p for p in baseline if p not in before]

        row.permissions = baseline
        await session.commit()

        print(f"'Employee' role permissions: {len(before)} → {len(baseline)}")
        if removed:
            print(f"  removed ({len(removed)}):")
            for p in removed:
                print(f"    - {p}")
        if added:
            print(f"  added ({len(added)}):")
            for p in added:
                print(f"    + {p}")
        print("\nFinal baseline permissions:")
        for p in baseline:
            print(f"  • {p}")


if __name__ == "__main__":
    asyncio.run(main())
