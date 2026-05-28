"""
One-shot cleanup: re-migrate every Role's permissions through
LEGACY_PERMISSION_MAP. Idempotent — safe to run multiple times.

Usage (inside the API container):
    docker exec arkon_api python -m app.scripts.cleanup_role_permissions

Why: older deployments stored aggregate legacy keys like `departments.manage`
that the new validator rejects. Updating a role through the UI fails with
"Unknown permissions". This script normalizes existing rows so subsequent
UPDATEs accept them.
"""

import asyncio

from sqlalchemy import select

from app.database import async_session_factory
from app.database.models import Role
from app.services.permissions import ALL_PERMISSIONS, LEGACY_PERMISSION_MAP


def _migrate(perms: list[str]) -> tuple[list[str], list[str]]:
    """Return (clean_sorted_list, dropped_unknown_keys)."""
    migrated: set[str] = set()
    dropped: list[str] = []
    for p in perms or []:
        if p in LEGACY_PERMISSION_MAP:
            migrated.update(LEGACY_PERMISSION_MAP[p])
        elif p in ALL_PERMISSIONS:
            migrated.add(p)
        else:
            dropped.append(p)
    return sorted(migrated), dropped


async def main() -> None:
    async with async_session_factory() as session:
        rows = (await session.execute(select(Role))).scalars().all()
        if not rows:
            print("No roles to clean.")
            return

        changed = 0
        for role in rows:
            cleaned, dropped = _migrate(role.permissions or [])
            current = sorted(role.permissions or [])
            if cleaned != current:
                role.permissions = cleaned
                changed += 1
                print(
                    f"  - {role.name}: {len(current)} → {len(cleaned)} perms"
                    + (f" (dropped unknown: {dropped})" if dropped else "")
                )

        await session.commit()
        print(f"\nDone. {changed}/{len(rows)} roles updated.")


if __name__ == "__main__":
    asyncio.run(main())
