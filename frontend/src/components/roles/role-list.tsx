"use client";

import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import type { Role, PermissionInfo } from "./role-dialog";

type Props = {
  roles: Role[];
  loading: boolean;
  permissions: PermissionInfo[];
  onEdit: (role: Role) => void;
  onRefresh: () => void;
};

/** Convert a system role name (e.g. "Department Admin") to its i18n key. */
function toSystemRoleKey(name: string): string {
  return name.replace(/\s+/g, "");
}

export function RoleList({ roles, loading, permissions, onEdit, onRefresh }: Props) {
  const t = useTranslations("Roles");
  const tCommon = useTranslations("Common");
  // Fallback map: backend English label, used only if a permission key is not
  // yet present in the locale file (e.g., newly-added backend permission).
  const labelMap = Object.fromEntries(permissions.map((p) => [p.key, p.label]));

  const handleDelete = async (role: Role) => {
    if (!confirm(t("deleteConfirm", { name: role.name }))) return;
    try {
      await api(`/api/roles/${role.id}`, { method: "DELETE" });
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : t("deleteFailed"));
    }
  };

  if (loading) {
    return (
      <div className="bg-card rounded-xl border border-border flex items-center justify-center py-16">
        <span className="material-symbols-outlined text-3xl text-muted-foreground animate-spin">
          progress_activity
        </span>
      </div>
    );
  }

  if (roles.length === 0) {
    return (
      <div className="bg-card rounded-xl border border-border">
        <EmptyState
          icon="admin_panel_settings"
          title={t("noRoles.title")}
          description={t("noRoles.description")}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {roles.map((role) => (
        <div
          key={role.id}
          className="bg-card rounded-xl border border-border px-5 py-4 flex items-start justify-between gap-4"
        >
          <div className="flex flex-col gap-2 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">
                {(() => {
                  if (role.is_system) {
                    const key = `systemRoles.${toSystemRoleKey(role.name)}` as Parameters<typeof t>[0];
                    return t.has(key) ? t(key) : role.name;
                  }
                  // Custom roles: try schoolRoles map for VI/EN translation,
                  // fall back to the stored name (already in user's language
                  // for non-school deployments).
                  const schoolKey = `schoolRoles.${role.name}` as Parameters<typeof t>[0];
                  return t.has(schoolKey) ? t(schoolKey) : role.name;
                })()}
              </span>
              {role.is_system && (
                <Badge variant="secondary" className="text-xs">{t("systemBadge")}</Badge>
              )}
            </div>
            {role.description && (
              <p className="text-xs text-muted-foreground">{role.description}</p>
            )}
            <div className="flex flex-wrap gap-1.5 mt-1">
              {role.permissions.length === 0 ? (
                <span className="text-xs text-muted-foreground">{t("noPermissions")}</span>
              ) : (
                role.permissions.map((p) => {
                  const pKey = `permissions.${p}` as Parameters<typeof t>[0];
                  return (
                    <Badge key={p} variant="outline" className="text-xs font-normal">
                      {t.has(pKey) ? t(pKey) : (labelMap[p] ?? p)}
                    </Badge>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => onEdit(role)}>
              <span className="material-symbols-outlined text-base mr-1">edit</span>
              {tCommon("edit")}
            </Button>
            {!role.is_system && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => handleDelete(role)}
              >
                <span className="material-symbols-outlined text-base mr-1">delete</span>
                {tCommon("delete")}
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
