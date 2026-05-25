"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { DeptMembersDialog } from "@/components/departments/dept-members-dialog";

type Department = {
  id: string;
  name: string;
  description?: string;
  employee_count: number;
};

type Props = {
  departments: Department[];
  loading: boolean;
  onEdit: (dept: Department) => void;
  onRefresh: () => void;
};

export function DepartmentCards({ departments, loading, onEdit, onRefresh }: Props) {
  const t = useTranslations("Departments");
  const tCommon = useTranslations("Common");
  const [scopeDept, setScopeDept] = React.useState<Department | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm(t("deleteConfirm"))) return;
    await api(`/api/departments/${id}`, { method: "DELETE" });
    onRefresh();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <span className="material-symbols-outlined text-3xl text-muted-foreground animate-spin">
          progress_activity
        </span>
      </div>
    );
  }

  if (departments.length === 0) {
    return (
      <EmptyState
        icon="business"
        title={t("noDepartments.title")}
        description={t("noDepartments.description")}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      {departments.map((dept) => (
        <div
          key={dept.id}
          className="bg-card rounded-xl p-6 border border-border shadow-sahara flex flex-col gap-4 hover:border-primary/30 transition-colors"
        >
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-primary">
                  business
                </span>
              </div>
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  {dept.name}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t("employeeCount", { count: dept.employee_count })}
                </p>
              </div>
            </div>
          </div>

          {dept.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {dept.description}
            </p>
          )}

          <div className="flex flex-wrap gap-2 mt-auto pt-2 border-t border-border">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setScopeDept(dept)}
              className="text-xs"
            >
              <span className="material-symbols-outlined text-sm mr-1">group</span>
              {t("membersButton")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit(dept)}
              className="text-xs"
            >
              <span className="material-symbols-outlined text-sm mr-1">edit</span>
              {tCommon("edit")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDelete(dept.id)}
              className="text-xs text-destructive hover:text-destructive"
            >
              <span className="material-symbols-outlined text-sm mr-1">delete</span>
              {tCommon("delete")}
            </Button>
          </div>
        </div>
      ))}

      {scopeDept && (
        <DeptMembersDialog
          open={!!scopeDept}
          onOpenChange={(open) => { if (!open) setScopeDept(null); }}
          deptId={scopeDept.id}
          deptName={scopeDept.name}
        />
      )}
    </div>
  );
}
