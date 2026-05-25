import { expect, test } from "@playwright/test";
import { loginAsAdmin } from "./fixtures/login";

// Guards the multi-scope wiki-pin feature: workspace editors should be
// able to pin a global wiki page into their workspace, and the workspace's
// wiki listing should include it with `is_pinned=true` until unpinned.

const WORKSPACE_ID = process.env.ARKON_TEST_WORKSPACE_ID ?? "5f03d0ba-a12f-4383-bc55-b7674405157d";

async function getToken(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const apiBase = (process.env.ARKON_API_URL ?? "http://localhost:5055").replace(/\/$/, "");
  const res = await request.post(`${apiBase}/api/auth/login`, {
    data: {
      email: process.env.ARKON_ADMIN_EMAIL ?? "admin@arkon.local",
      password: process.env.ARKON_ADMIN_PASSWORD ?? "truongvietanh",
    },
  });
  expect(res.ok()).toBeTruthy();
  const { access_token } = await res.json();
  return access_token;
}

test.describe("Workspace · Pin global wiki page", () => {
  test("pin → list shows is_pinned=true → unpin → gone", async ({ request }) => {
    const token = await getToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    const apiBase = (process.env.ARKON_API_URL ?? "http://localhost:5055").replace(/\/$/, "");

    // 1. List pinnable global pages — there must be at least one to test.
    const pinnableRes = await request.get(
      `${apiBase}/api/projects/${WORKSPACE_ID}/wiki/pinnable?limit=5`,
      { headers },
    );
    expect(pinnableRes.ok()).toBeTruthy();
    const pinnable = await pinnableRes.json();
    test.skip(pinnable.length === 0, "no global pages available to pin");
    const target = pinnable[0];

    // 2. Pin it.
    const pinRes = await request.post(
      `${apiBase}/api/projects/${WORKSPACE_ID}/wiki/pinned`,
      {
        headers: { ...headers, "Content-Type": "application/json" },
        data: { page_id: target.id },
      },
    );
    expect(pinRes.status()).toBe(201);

    // 3. Workspace wiki list now includes it with is_pinned=true.
    const listRes = await request.get(`${apiBase}/api/projects/${WORKSPACE_ID}/wiki?limit=300`, {
      headers,
    });
    expect(listRes.ok()).toBeTruthy();
    const list: Array<{ slug: string; is_pinned?: boolean; scope_type: string }> = await listRes.json();
    const pinned = list.find((p) => p.slug === target.slug && p.is_pinned);
    expect(
      pinned,
      `expected to find pinned page ${target.slug} in workspace wiki list with is_pinned=true`,
    ).toBeTruthy();
    expect(pinned!.scope_type).toBe("global");

    // 4. Duplicate pin → 409.
    const dupRes = await request.post(
      `${apiBase}/api/projects/${WORKSPACE_ID}/wiki/pinned`,
      {
        headers: { ...headers, "Content-Type": "application/json" },
        data: { page_id: target.id },
      },
    );
    expect(dupRes.status()).toBe(409);

    // 5. Unpin.
    const unpinRes = await request.delete(
      `${apiBase}/api/projects/${WORKSPACE_ID}/wiki/pinned/${target.id}`,
      { headers },
    );
    expect(unpinRes.ok()).toBeTruthy();

    // 6. List no longer includes it.
    const listAfter = await request.get(`${apiBase}/api/projects/${WORKSPACE_ID}/wiki?limit=300`, {
      headers,
    });
    const arr: Array<{ slug: string }> = await listAfter.json();
    expect(arr.find((p) => p.slug === target.slug)).toBeUndefined();
  });

  test("UI: Pin global page button opens dialog and lists pinnable pages", async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto(`/workspaces/${WORKSPACE_ID}`);
    await page.waitForLoadState("networkidle");

    // Wiki tab is the default — locate the Pin button and click it.
    const pinBtn = page.getByRole("button", { name: /pin trang global|pin global page/i }).first();
    await expect(pinBtn).toBeVisible({ timeout: 10_000 });
    await pinBtn.click();

    // Dialog open: title + search box visible.
    await expect(
      page.getByRole("dialog").getByText(/pin a global wiki page|pin trang wiki global/i),
    ).toBeVisible();
    await expect(page.getByPlaceholder(/search by|tìm theo/i)).toBeVisible();

    // Close.
    await page.getByRole("button", { name: /^(close|đóng)$/i }).first().click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
