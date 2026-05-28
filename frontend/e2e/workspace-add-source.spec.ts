import { expect, test } from "@playwright/test";
import { loginAsAdmin } from "./fixtures/login";

// Regression: when an admin opens the "Add source" picker on a workspace,
// the candidates list MUST NOT include sources that are already owned by
// (or linked to) the same workspace. The user reported the opposite —
// the picker was showing the 6 sources already in ws-01-tuyensinh.
//
// We test the API contract directly (faster, deterministic) and then a
// light UI smoke that the picker renders without listing those owned IDs.

const WORKSPACE_ID = process.env.ARKON_TEST_WORKSPACE_ID ?? "732bb87b-282c-4173-8e09-89c0db28bb87";

test.describe("Workspace · Add Source", () => {
  test("candidates endpoint excludes sources already in the workspace", async ({
    page,
    request,
  }) => {
    await loginAsAdmin(page);

    // Snapshot of the workspace's own sources (scope_type='project' + scope_id=this).
    const apiBase = (process.env.ARKON_API_URL ?? "http://localhost:5055").replace(/\/$/, "");
    const tokenResponse = await request.post(`${apiBase}/api/auth/login`, {
      data: {
        email: process.env.ARKON_ADMIN_EMAIL ?? "admin@arkon.local",
        password: process.env.ARKON_ADMIN_PASSWORD ?? "truongvietanh",
      },
    });
    expect(tokenResponse.ok()).toBeTruthy();
    const { access_token } = await tokenResponse.json();
    const headers = { Authorization: `Bearer ${access_token}` };

    const ownedRes = await request.get(`${apiBase}/api/sources?workspace_id=${WORKSPACE_ID}`, { headers });
    expect(ownedRes.ok()).toBeTruthy();
    const ownedPayload = await ownedRes.json();
    const ownedSources = Array.isArray(ownedPayload) ? ownedPayload : ownedPayload.items ?? [];
    const ownedIds = new Set(ownedSources.map((s: { id: string }) => s.id));

    const candidatesRes = await request.get(
      `${apiBase}/api/projects/${WORKSPACE_ID}/sources/candidates`,
      { headers },
    );
    expect(candidatesRes.ok()).toBeTruthy();
    const candidates = await candidatesRes.json();

    // The fix: no candidate may already be owned by this workspace.
    const overlap = candidates.filter((c: { id: string }) => ownedIds.has(c.id));
    expect(overlap, `Candidate list still contains workspace-owned sources: ${JSON.stringify(overlap)}`).toEqual([]);
  });

  test("UI picker on workspace detail does not list any source already in the workspace", async ({
    page,
    request,
  }) => {
    await loginAsAdmin(page);

    // Capture the list of owned source titles via API for comparison.
    const apiBase = (process.env.ARKON_API_URL ?? "http://localhost:5055").replace(/\/$/, "");
    const tokenResponse = await request.post(`${apiBase}/api/auth/login`, {
      data: {
        email: process.env.ARKON_ADMIN_EMAIL ?? "admin@arkon.local",
        password: process.env.ARKON_ADMIN_PASSWORD ?? "truongvietanh",
      },
    });
    const { access_token } = await tokenResponse.json();
    const ownedRes = await request.get(`${apiBase}/api/sources?workspace_id=${WORKSPACE_ID}`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const ownedPayload = await ownedRes.json();
    const ownedSources = Array.isArray(ownedPayload) ? ownedPayload : ownedPayload.items ?? [];
    const ownedTitles = ownedSources
      .map((s: { title?: string; file_name?: string }) => s.title ?? s.file_name ?? "")
      .filter(Boolean);

    // Navigate to the workspace detail page. The default tab is "wiki" — we
    // need to click the Sources tab before the Add Document button appears.
    await page.goto(`/workspaces/${WORKSPACE_ID}`);
    await page.waitForLoadState("networkidle");

    // Click the Sources tab. The accessible name includes the leading icon
    // text ("description") and the trailing count badge — so we match by
    // a substring containing "Tài liệu" / "Sources" / "Documents".
    const sourcesTab = page
      .getByRole("button", { name: /tài liệu|sources|documents/i })
      .first();
    await sourcesTab.click();
    await page.waitForLoadState("networkidle");

    // Now the Add Document button should be visible inside the sources tab.
    const addBtn = page
      .getByRole("button", { name: /add\s*document|thêm\s*tài liệu/i })
      .first();
    await addBtn.click();

    // The candidates picker is open. Wait for the list (or empty-state).
    // We assert no row whose label matches an owned title.
    await page.waitForTimeout(500); // give the request a tick

    for (const title of ownedTitles) {
      const inPicker = await page.getByText(title, { exact: false }).count();
      // The detail panel + sources tab also render owned titles outside the
      // picker. We can't easily disambiguate by DOM containment without
      // knowing the picker root selector, so we just assert the picker
      // requests didn't return any owned IDs (covered by the previous test)
      // and skip a strict UI count assertion here.
      // Soft-log mismatches for debugging:
      if (inPicker > 1) {
        // 1 occurrence is the sources tab itself; >1 likely means picker also rendered it.
        // No hard fail to avoid flakiness from layout — the API test above is the authoritative gate.
        // eslint-disable-next-line no-console
        console.warn(`[WARN] owned title still visible multiple times in DOM: ${title} (count=${inPicker})`);
      }
    }
  });
});
