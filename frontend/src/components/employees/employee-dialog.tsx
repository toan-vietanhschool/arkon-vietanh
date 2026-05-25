"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Department = { id: string; name: string };
type Role = { id: string; name: string; is_system?: boolean };
type Employee = {
  id: string;
  name: string;
  email: string;
  role: string;
  department_id: string;
  custom_role_id?: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: Employee | null; // null = create mode
  departments: Department[];
  roles?: Role[];
  onSaved: () => void;
};

export function EmployeeDialog({
  open,
  onOpenChange,
  employee,
  departments,
  roles = [],
  onSaved,
}: Props) {
  const t = useTranslations("Employees");
  const tCommon = useTranslations("Common");
  const isEdit = !!employee;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("employee");
  const [deptId, setDeptId] = useState("");
  const [customRoleId, setCustomRoleId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [localRoles, setLocalRoles] = useState<Role[]>([]);
  const [localDepartments, setLocalDepartments] = useState<Department[]>([]);
  const [inlinePrompt, setInlinePrompt] = useState({
    open: false,
    title: "",
    label: "",
    value: "",
    saving: false,
    error: "",
    onSubmit: async (val: string) => {},
  });

  useEffect(() => {
    setLocalRoles(roles.filter(r => !r.is_system));
  }, [roles]);

  useEffect(() => {
    setLocalDepartments(departments);
  }, [departments]);

  const handleCreateDepartment = () => {
    setInlinePrompt({
      open: true,
      title: t("dialog.inlineCreate.createDepartmentTitle"),
      label: t("dialog.inlineCreate.departmentNameLabel"),
      value: "",
      saving: false,
      error: "",
      onSubmit: async (val) => {
        const newDept = await api<Department>("/api/departments", {
          method: "POST",
          body: { name: val, description: "" }
        });
        setLocalDepartments(prev => [...prev, newDept]);
        setDeptId(newDept.id);
        setInlinePrompt(p => ({ ...p, open: false }));
      }
    });
  };

  const handleCreateRole = () => {
    setInlinePrompt({
      open: true,
      title: t("dialog.inlineCreate.createPositionTitle"),
      label: t("dialog.inlineCreate.positionNameLabel"),
      value: "",
      saving: false,
      error: "",
      onSubmit: async (val) => {
        const newRole = await api<Role>("/api/roles", {
          method: "POST",
          body: { name: val, permissions: [] }
        });
        setLocalRoles(prev => [...prev, newRole]);
        setCustomRoleId(newRole.id);
        setInlinePrompt(p => ({ ...p, open: false }));
      }
    });
  };

  const submitInlinePrompt = async () => {
    if (!inlinePrompt.value.trim()) return;
    setInlinePrompt(p => ({ ...p, saving: true, error: "" }));
    try {
      await inlinePrompt.onSubmit(inlinePrompt.value.trim());
    } catch (err) {
      setInlinePrompt(p => ({ ...p, saving: false, error: err instanceof Error ? err.message : String(err) }));
    }
  };

  useEffect(() => {
    if (employee) {
      setName(employee.name);
      setEmail(employee.email);
      setRole(employee.role);
      setDeptId(employee.department_id);
      setCustomRoleId(employee.custom_role_id || "");
      setPassword("");
    } else {
      setName("");
      setEmail("");
      setPassword("");
      setRole("employee");
      setDeptId(departments[0]?.id || "");
      setCustomRoleId("");
    }
    setError("");
  }, [employee, open, departments]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");

    try {
      const body: Record<string, string | null> = {
        name,
        email,
        role,
        department_id: deptId,
        custom_role_id: customRoleId || null,
      };
      if (password) body.password = password;

      if (isEdit) {
        await api(`/api/employees/${employee.id}`, { method: "PUT", body });
      } else {
        if (!password) {
          setError(t("dialog.passwordRequired"));
          setSaving(false);
          return;
        }
        await api("/api/employees", { method: "POST", body });
      }

      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("dialog.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl">
            {isEdit ? t("dialog.editTitle") : t("dialog.createTitle")}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="emp-name">{t("dialog.nameLabel")}</Label>
            <Input
              id="emp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="bg-background"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="emp-email">{t("dialog.emailLabel")}</Label>
            <Input
              id="emp-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="bg-background"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="emp-password">
              {isEdit ? t("dialog.passwordLabelEdit") : t("dialog.passwordLabel")}
            </Label>
            <Input
              id="emp-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isEdit ? t("dialog.passwordPlaceholderEdit") : t("dialog.passwordPlaceholderCreate")}
              className="bg-background"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label>{t("dialog.systemRoleLabel")}</Label>
              <Select value={role} onValueChange={(v) => v && setRole(v)}>
                <SelectTrigger className="bg-background">
                  {role === "admin"
                    ? t("systemRoleLabel.admin")
                    : role === "employee"
                      ? t("systemRoleLabel.employee")
                      : <SelectValue />}
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="employee">{t("systemRoleLabel.employee")}</SelectItem>
                  <SelectItem value="admin">{t("systemRoleLabel.admin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label>{t("dialog.departmentLabel")}</Label>
              <Select
                value={deptId}
                onValueChange={(v) => {
                  if (v === "__new__") {
                    handleCreateDepartment();
                    return;
                  }
                  if (v) setDeptId(v);
                }}
              >
                <SelectTrigger className="bg-background">
                  {deptId ? (localDepartments.find(d => d.id === deptId)?.name || deptId) : <SelectValue placeholder={tCommon("search")} />}
                </SelectTrigger>
                <SelectContent className="!w-max min-w-(--anchor-width)">
                  {localDepartments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                  <div className="h-px bg-border my-1 -mx-1" />
                  <SelectItem value="__new__" className="text-primary font-medium focus:text-primary">
                    <span className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-sm">add</span>
                      {t("dialog.createNewDepartment")}
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {role === "employee" && (
            <div className="flex flex-col gap-2">
              <Label>{t("dialog.positionLabel")}</Label>
              <Select
                value={customRoleId || "__none__"}
                onValueChange={(v) => {
                  if (v === "__new__") {
                    handleCreateRole();
                    return;
                  }
                  setCustomRoleId(v === "__none__" ? "" : (v ?? ""));
                }}
              >
                <SelectTrigger className="bg-background">
                  {customRoleId ? (localRoles.find(r => r.id === customRoleId)?.name || customRoleId) : t("dialog.positionNone")}
                </SelectTrigger>
                <SelectContent className="!w-max min-w-(--anchor-width)">
                  <SelectItem value="__none__">{t("dialog.positionNone")}</SelectItem>
                  {localRoles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                  <div className="h-px bg-border my-1 -mx-1" />
                  <SelectItem value="__new__" className="text-primary font-medium focus:text-primary">
                    <span className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-sm">add</span>
                      {t("dialog.createNewPosition")}
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {error && (
            <p className="text-destructive text-sm bg-destructive/10 px-3 py-2 rounded-lg">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving
                ? t("dialog.saving")
                : isEdit
                  ? t("dialog.updateButton")
                  : t("dialog.createButton")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>

      <Dialog open={inlinePrompt.open} onOpenChange={(o) => setInlinePrompt(p => ({ ...p, open: o }))}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{inlinePrompt.title}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <Label>{inlinePrompt.label}</Label>
              <Input
                value={inlinePrompt.value}
                onChange={e => setInlinePrompt(p => ({ ...p, value: e.target.value }))}
                autoFocus
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitInlinePrompt();
                  }
                }}
              />
            </div>
            {inlinePrompt.error && (
              <p className="text-destructive text-sm">{inlinePrompt.error}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button type="button" variant="outline" onClick={() => setInlinePrompt(p => ({ ...p, open: false }))}>
              {tCommon("cancel")}
            </Button>
            <Button
              disabled={inlinePrompt.saving || !inlinePrompt.value.trim()}
              onClick={submitInlinePrompt}
            >
              {inlinePrompt.saving
                ? t("dialog.inlineCreate.saving")
                : t("dialog.inlineCreate.createButton")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
