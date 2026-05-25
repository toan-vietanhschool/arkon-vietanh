import { Page } from "@playwright/test";

// Login through the real UI flow so the session cookie + AuthProvider state
// are populated naturally. Tests that depend on an authenticated session
// call this once at the top of the spec.
export async function loginAsAdmin(page: Page): Promise<void> {
  const email = process.env.ARKON_ADMIN_EMAIL ?? "admin@arkon.local";
  const password = process.env.ARKON_ADMIN_PASSWORD ?? "truongvietanh";

  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password|mật khẩu/i).fill(password);
  await page.getByRole("button", { name: /sign in|đăng nhập/i }).click();
  // Successful login lands on a portal route — wait for sidebar to appear.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}
