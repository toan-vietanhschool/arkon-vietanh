"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Settings = Record<string, string | null>;

const SMTP_KEYS = [
  "smtp_enabled",
  "smtp_host",
  "smtp_port",
  "smtp_username",
  "smtp_password",
  "smtp_from",
  "smtp_use_tls",
] as const;

const WEBHOOK_KEYS = [
  "webhook_enabled",
  "webhook_url",
  "webhook_secret",
] as const;

export function NotificationChannelsCard() {
  const t = useTranslations("SettingsNotifications");

  const [settings, setSettings] = React.useState<Settings>({});
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    setLoading(true);
    api<Settings>("/api/admin-settings/settings")
      .then((s) => setSettings(s || {}))
      .catch(() => setSettings({}))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const update = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const save = async (keys: readonly string[]) => {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string> = {};
      for (const k of keys) {
        const v = settings[k];
        if (v != null) payload[k] = v;
      }
      await api("/api/admin-settings/settings", {
        method: "PUT",
        body: { settings: payload },
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const smtpEnabled = (settings.smtp_enabled || "false") === "true";
  const webhookEnabled = (settings.webhook_enabled || "false") === "true";

  return (
    <div className="rounded-xl border bg-card p-5 flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-muted-foreground" style={{ fontSize: 20 }}>
          campaign
        </span>
        <div>
          <h2 className="font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* SMTP */}
      <fieldset className="rounded-lg border border-border p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <legend className="text-sm font-medium px-1">{t("smtp.legend")}</legend>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={smtpEnabled}
              onChange={(e) => update("smtp_enabled", e.target.checked ? "true" : "false")}
              disabled={loading}
            />
            {t("smtp.enabled")}
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1">
            <Label htmlFor="smtp-host">{t("smtp.host")}</Label>
            <Input
              id="smtp-host"
              value={settings.smtp_host || ""}
              onChange={(e) => update("smtp_host", e.target.value)}
              placeholder="smtp.gmail.com"
              disabled={!smtpEnabled || loading}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="smtp-port">{t("smtp.port")}</Label>
            <Input
              id="smtp-port"
              value={settings.smtp_port || ""}
              onChange={(e) => update("smtp_port", e.target.value)}
              placeholder="587"
              disabled={!smtpEnabled || loading}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="smtp-user">{t("smtp.username")}</Label>
            <Input
              id="smtp-user"
              value={settings.smtp_username || ""}
              onChange={(e) => update("smtp_username", e.target.value)}
              disabled={!smtpEnabled || loading}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="smtp-pass">{t("smtp.password")}</Label>
            <Input
              id="smtp-pass"
              type="password"
              value={settings.smtp_password || ""}
              onChange={(e) => update("smtp_password", e.target.value)}
              placeholder={settings.smtp_password === "" ? t("smtp.passwordUnchanged") : ""}
              disabled={!smtpEnabled || loading}
            />
          </div>
          <div className="grid gap-1 col-span-2">
            <Label htmlFor="smtp-from">{t("smtp.fromAddress")}</Label>
            <Input
              id="smtp-from"
              value={settings.smtp_from || ""}
              onChange={(e) => update("smtp_from", e.target.value)}
              placeholder={t("smtp.fromPlaceholder")}
              disabled={!smtpEnabled || loading}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={(settings.smtp_use_tls || "true") === "true"}
            onChange={(e) => update("smtp_use_tls", e.target.checked ? "true" : "false")}
            disabled={!smtpEnabled || loading}
          />
          {t("smtp.useTls")}
        </label>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => save(SMTP_KEYS)} disabled={busy || loading}>
            {t("smtp.save")}
          </Button>
        </div>
      </fieldset>

      {/* Webhook */}
      <fieldset className="rounded-lg border border-border p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <legend className="text-sm font-medium px-1">{t("webhook.legend")}</legend>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={webhookEnabled}
              onChange={(e) => update("webhook_enabled", e.target.checked ? "true" : "false")}
              disabled={loading}
            />
            {t("webhook.enabled")}
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {t.rich("webhook.description", {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
        <div className="grid gap-1">
          <Label htmlFor="wh-url">{t("webhook.endpointUrl")}</Label>
          <Input
            id="wh-url"
            value={settings.webhook_url || ""}
            onChange={(e) => update("webhook_url", e.target.value)}
            placeholder="https://relay.example.com/arkon"
            disabled={!webhookEnabled || loading}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="wh-secret">{t("webhook.secret")}</Label>
          <Input
            id="wh-secret"
            type="password"
            value={settings.webhook_secret || ""}
            onChange={(e) => update("webhook_secret", e.target.value)}
            disabled={!webhookEnabled || loading}
          />
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => save(WEBHOOK_KEYS)} disabled={busy || loading}>
            {t("webhook.save")}
          </Button>
        </div>
      </fieldset>

      {savedAt && (
        <p className="text-xs text-muted-foreground">
          {t("savedAt", { time: new Date(savedAt).toLocaleTimeString() })}
        </p>
      )}
    </div>
  );
}
