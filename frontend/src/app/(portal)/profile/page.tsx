"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { McpTokenCard } from "@/components/profile/mcp-token-card";

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const t = useTranslations("Profile");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");

    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: {
          current_password: currentPassword,
          new_password: newPassword,
        },
      });
      setMessage(t("changePassword.successMessage"));
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("changePassword.failedFallback"));
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          <Button variant="destructive" onClick={logout}>
            <span className="material-symbols-outlined text-base mr-1">logout</span>
            {t("logout")}
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Profile Info */}
        <div className="bg-card rounded-xl p-6 border border-border shadow-sahara">
          <h3 className="text-lg font-semibold text-foreground mb-4">
            {t("accountInfo.title")}
          </h3>

          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xl font-bold">
                {user.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="text-lg font-semibold">{user.name}</p>
                <p className="text-sm text-muted-foreground">{user.email}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-3 border-t border-border">
              <div>
                <p className="text-xs text-muted-foreground">{t("accountInfo.roleLabel")}</p>
                <Badge variant="outline" className="mt-1 capitalize">
                  {user.role}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("accountInfo.departmentLabel")}</p>
                <p className="text-sm font-medium mt-1">{user.department_name}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Change Password */}
        <div className="bg-card rounded-xl p-6 border border-border shadow-sahara">
          <h3 className="text-lg font-semibold text-foreground mb-4">
            {t("changePassword.title")}
          </h3>

          <form onSubmit={handleChangePassword} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="current-pw" className="text-xs">{t("changePassword.currentPassword")}</Label>
              <Input
                id="current-pw"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                className="bg-background"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-pw" className="text-xs">{t("changePassword.newPassword")}</Label>
              <Input
                id="new-pw"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={6}
                placeholder={t("changePassword.newPasswordPlaceholder")}
                className="bg-background"
              />
            </div>

            {error && (
              <p className="text-destructive text-sm bg-destructive/10 px-3 py-2 rounded-lg">
                {error}
              </p>
            )}
            {message && (
              <p className="text-green-700 text-sm bg-green-50 px-3 py-2 rounded-lg">
                {message}
              </p>
            )}

            <Button
              type="submit"
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90 self-start"
            >
              {saving ? t("changePassword.saving") : t("changePassword.updateButton")}
            </Button>
          </form>
        </div>

        {/* MCP Token (self-service) */}
        <div className="lg:col-span-2">
          <McpTokenCard />
        </div>
      </div>
    </>
  );
}
