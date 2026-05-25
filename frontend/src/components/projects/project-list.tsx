"use client";

import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/shared/empty-state";
import React from "react";

type Project = {
  id: string;
  name: string;
  description?: string;
  workspace_type: string;
  status: string;
  member_count: number;
  source_count: number;
  created_at: string;
};

type Props = {
  projects: Project[];
  loading: boolean;
  isAdmin: boolean;
  onEdit: (project: Project) => void;
  onOpen: (project: Project) => void;
  onRefresh: () => void;
};

export function ProjectList({ projects, loading, isAdmin, onEdit, onOpen, onRefresh }: Props) {
  const t = useTranslations("Projects");
  const tCommon = useTranslations("Common");
  const [error, setError] = React.useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm(t("deleteConfirm"))) return;
    setError(null);
    try {
      await api(`/api/projects/${id}`, { method: "DELETE" });
      window.dispatchEvent(new Event("workspaces-changed"));
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("deleteFailed"));
    }
  };

  if (loading) {
    return (
      <div className="bg-card rounded-xl border border-border shadow-sahara flex items-center justify-center py-16">
        <span className="material-symbols-outlined text-3xl text-muted-foreground animate-spin">
          progress_activity
        </span>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="bg-card rounded-xl border border-border shadow-sahara">
        <EmptyState
          icon="workspaces"
          title={t("noWorkspaces.title")}
          description={t("noWorkspaces.description")}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="text-sm text-destructive bg-destructive/10 px-4 py-2 rounded-lg flex items-center gap-2">
          <span className="material-symbols-outlined text-base">error</span>
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <div
            key={project.id}
            onClick={() => onOpen(project)}
            className="bg-card rounded-xl border border-border shadow-sahara p-5 flex flex-col gap-3 cursor-pointer hover:border-primary/20 hover:bg-accent/20 hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-col gap-1 flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-base">{project.workspace_type === 'customer' ? 'domain' : 'folder_special'}</span>
                  <h3 className="font-semibold text-sm truncate group-hover:text-primary transition-colors">{project.name}</h3>
                </div>
                {project.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{project.description}</p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge
                  variant="outline"
                  className={`text-xs ${
                    project.workspace_type === "customer"
                      ? "text-violet-600 border-violet-300"
                      : "text-sky-600 border-sky-300"
                  }`}
                >
                  {project.workspace_type === "customer"
                    ? t("workspaceType.customer")
                    : t("workspaceType.project")}
                </Badge>
                <Badge
                  variant="outline"
                  className={
                    project.status === "active"
                      ? "text-green-600 border-green-300"
                      : "text-muted-foreground border-muted"
                  }
                >
                  {project.status === "active"
                    ? t("status.active")
                    : t("status.archived")}
                </Badge>

                {isAdmin && (
                  <div onClick={(e) => e.stopPropagation()} className="ml-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent text-muted-foreground transition-colors">
                        <span className="material-symbols-outlined text-base">more_vert</span>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(project); }}>
                          <span className="material-symbols-outlined text-base mr-2">edit</span>
                          {tCommon("edit")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => { e.stopPropagation(); handleDelete(project.id); }}
                          className="text-destructive focus:text-destructive"
                        >
                          <span className="material-symbols-outlined text-base mr-2">delete</span>
                          {tCommon("delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">group</span>
                {t("memberCount", { count: project.member_count })}
              </span>
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">description</span>
                {t("docCount", { count: project.source_count })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
