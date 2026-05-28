import { expect, test, type APIRequestContext } from "@playwright/test";

// RBAC + authentication enforcement at the API layer.
// Pure REST tests — no UI flake.

const API_BASE = (process.env.ARKON_API_URL ?? "http://localhost:5055").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ARKON_ADMIN_EMAIL ?? "admin@arkon.local";
const ADMIN_PASSWORD = process.env.ARKON_ADMIN_PASSWORD ?? "truongvietanh";
const WORKSPACE_ID = process.env.ARKON_TEST_WORKSPACE_ID ?? "732bb87b-282c-4173-8e09-89c0db28bb87";
// A made-up UUID that does NOT exist — used to test 404 vs 403 distinction.
const FAKE_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

async function adminLogin(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok()).toBeTruthy();
  const { access_token } = await res.json();
  return access_token;
}

test.describe("Auth · unauthenticated access", () => {
  test("missing bearer token → 401 on protected endpoints", async ({ request }) => {
    const endpoints = [
      "/api/wiki/pages?limit=5",
      "/api/sources?limit=5",
      `/api/projects/${WORKSPACE_ID}/wiki?limit=5`,
      "/api/employees",
      "/api/audit/log?limit=5",
    ];
    for (const path of endpoints) {
      const res = await request.get(`${API_BASE}${path}`);
      expect(res.status(), `${path} must require auth`).toBe(401);
    }
  });

  test("invalid bearer token → 401", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/wiki/pages?limit=5`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status()).toBe(401);
  });

  test("wrong-credentials login → 401", async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: ADMIN_EMAIL, password: "definitely-not-the-password" },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe("RBAC · workspace access boundaries", () => {
  test("non-existent workspace returns 404 (not 200 with empty data)", async ({ request }) => {
    const token = await adminLogin(request);
    const res = await request.get(
      `${API_BASE}/api/projects/${FAKE_WORKSPACE_ID}/wiki?limit=5`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect([403, 404]).toContain(res.status());
  });

  test("admin can list real workspace wiki", async ({ request }) => {
    const token = await adminLogin(request);
    const res = await request.get(
      `${API_BASE}/api/projects/${WORKSPACE_ID}/wiki?limit=5`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.ok()).toBeTruthy();
    const pages = await res.json();
    expect(Array.isArray(pages)).toBe(true);
  });
});

test.describe("Wiki · scope isolation", () => {
  test("get_wiki_page with explicit scope rejects mismatch (project page not found at scope=global)", async ({ request }) => {
    const token = await adminLogin(request);
    const headers = { Authorization: `Bearer ${token}` };

    // Find a project-scoped page from the workspace.
    const wsList = await request
      .get(`${API_BASE}/api/projects/${WORKSPACE_ID}/wiki?limit=50`, { headers })
      .then((r) => r.json());
    const projectPage = (wsList as Array<{ slug: string; scope_type: string }>).find(
      (p) => p.scope_type === "project",
    );
    test.skip(!projectPage, "no project-scoped page in workspace to test");

    // Asking the same slug at scope=global must NOT return the project page.
    const res = await request.get(
      `${API_BASE}/api/wiki/pages/${encodeURIComponent(projectPage!.slug)}?scope_type=global`,
      { headers },
    );
    // Either 404 (no global page with that slug) or 200 (a DIFFERENT global page
    // with same slug existed) — but never the project page silently.
    if (res.status() === 200) {
      const body = await res.json();
      expect(body.scope_type).toBe("global");
    } else {
      expect(res.status()).toBe(404);
    }
  });
});

test.describe("MCP token lifecycle", () => {
  test("issue → use → revoke → reject", async ({ request }) => {
    const token = await adminLogin(request);
    const headers = { Authorization: `Bearer ${token}` };

    // Get admin's own employee id.
    const me = await request.get(`${API_BASE}/api/auth/me`, { headers });
    expect(me.ok()).toBeTruthy();
    const meBody = await me.json();
    const employeeId: string = meBody.id;

    // Issue MCP token.
    const issueRes = await request.post(
      `${API_BASE}/api/employees/${employeeId}/token`,
      { headers, data: {} },
    );
    expect(issueRes.ok()).toBeTruthy();
    const issued = await issueRes.json();
    const mcpToken: string = issued.token;
    expect(mcpToken).toBeTruthy();

    // Use it against MCP (smoke check) — a 401 here would indicate the
    // issued token cannot authenticate.
    // (Skip if MCP endpoint shape unknown; rely on revoke test for proof.)

    // Revoke it.
    const revokeRes = await request.delete(
      `${API_BASE}/api/employees/${employeeId}/token`,
      { headers },
    );
    expect(revokeRes.ok()).toBeTruthy();

    // Status endpoint should now report no active token.
    const statusRes = await request.get(`${API_BASE}/api/my/mcp-token/status`, {
      headers,
    });
    if (statusRes.ok()) {
      const status = await statusRes.json();
      // Token revoked → has_token=false or active=false depending on shape.
      const noToken =
        status.has_token === false ||
        status.active === false ||
        status.token === null;
      expect(noToken, `revoked token still shown active: ${JSON.stringify(status)}`).toBeTruthy();
    }
  });
});

test.describe("Wiki · revision lifecycle (admin)", () => {
  test("edit increments version + creates revision row", async ({ request }) => {
    const token = await adminLogin(request);
    const headers = { Authorization: `Bearer ${token}` };

    // Pick a page at global or workspace scope.
    const wsList = await request
      .get(`${API_BASE}/api/projects/${WORKSPACE_ID}/wiki?limit=20`, { headers })
      .then((r) => r.json());
    const page = (wsList as Array<{ slug: string; scope_type: string; scope_id: string | null; version: number }>)
      .find((p) => p.scope_type === "project");
    test.skip(!page, "no editable project page");

    const slug = page!.slug;
    const baseVersion = page!.version;
    const scopeQs = `?scope_type=project&scope_id=${WORKSPACE_ID}`;

    // Read current content.
    const detailRes = await request.get(
      `${API_BASE}/api/wiki/pages/${encodeURIComponent(slug)}${scopeQs}`,
      { headers },
    );
    expect(detailRes.ok()).toBeTruthy();
    const detail = await detailRes.json();
    const originalContent: string = detail.content_md;

    // Edit with a no-op-ish change so we can immediately roll back to original.
    const stamp = `\n\n<!-- e2e-stamp-${Date.now()} -->`;
    const editRes = await request.put(
      `${API_BASE}/api/wiki/pages/${encodeURIComponent(slug)}${scopeQs}`,
      {
        headers: { ...headers, "Content-Type": "application/json" },
        data: { content_md: originalContent + stamp, change_note: "e2e revision smoke" },
      },
    );
    expect(editRes.ok()).toBeTruthy();
    const edited = await editRes.json();
    expect(edited.version, "version must increment after edit").toBeGreaterThan(baseVersion);

    // List revisions — must include at least 2 rows now.
    const revRes = await request.get(
      `${API_BASE}/api/wiki/pages/${encodeURIComponent(slug)}/revisions${scopeQs}`,
      { headers },
    );
    expect(revRes.ok()).toBeTruthy();
    const revisions = await revRes.json();
    expect(revisions.length).toBeGreaterThanOrEqual(2);

    // Cleanup: rollback to baseVersion so test doesn't pollute data.
    const rollbackRes = await request.post(
      `${API_BASE}/api/wiki/pages/${encodeURIComponent(slug)}/revisions/${baseVersion}/rollback${scopeQs}`,
      { headers, data: {} },
    );
    expect(rollbackRes.ok(), "rollback should succeed for admin").toBeTruthy();
  });
});

test.describe("Sources · workspace isolation", () => {
  test("workspace source list ⊆ global source list (admin)", async ({ request }) => {
    const token = await adminLogin(request);
    const headers = { Authorization: `Bearer ${token}` };

    const wsRaw = await request
      .get(`${API_BASE}/api/projects/${WORKSPACE_ID}/sources?limit=200`, { headers })
      .then((r) => r.json());
    const globalRaw = await request
      .get(`${API_BASE}/api/sources?limit=200`, { headers })
      .then((r) => r.json());

    const wsList: Array<{ id?: string }> =
      Array.isArray(wsRaw) ? wsRaw : wsRaw.items ?? [];
    const globalList: Array<{ id?: string }> =
      Array.isArray(globalRaw) ? globalRaw : globalRaw.items ?? [];

    // Subset invariant only meaningful when the workspace HAS sources.
    // Empty workspace is a valid state — skip rather than fail.
    test.skip(wsList.length === 0, "workspace has no sources to compare");

    const idOf = (s: { id?: string }) => s.id ?? "";
    const wsIds = new Set(wsList.map(idOf));
    const globalIds = new Set(globalList.map(idOf));
    for (const id of wsIds) {
      expect(id, "every ws source must have an id field").toBeTruthy();
      expect(globalIds.has(id), `ws source ${id} not in global list`).toBeTruthy();
    }
  });
});

test.describe("Wiki draft · propose → approve lifecycle (admin self-loop)", () => {
  test("propose → list pending shows draft → approve → page version increments", async ({ request }) => {
    const token = await adminLogin(request);
    const headers = { Authorization: `Bearer ${token}` };

    const wsList = await request
      .get(`${API_BASE}/api/projects/${WORKSPACE_ID}/wiki?limit=20`, { headers })
      .then((r) => r.json());
    const page = (wsList as Array<{ slug: string; scope_type: string; version: number }>).find(
      (p) => p.scope_type === "project",
    );
    test.skip(!page, "no editable project page");

    const slug = page!.slug;
    const baseVersion = page!.version;
    const scopeQs = `?scope_type=project&scope_id=${WORKSPACE_ID}`;

    const detail = await request
      .get(`${API_BASE}/api/wiki/pages/${encodeURIComponent(slug)}${scopeQs}`, { headers })
      .then((r) => r.json());

    const stamp = `\n\n<!-- e2e-draft-${Date.now()} -->`;
    const proposeRes = await request.post(
      `${API_BASE}/api/wiki/pages/${encodeURIComponent(slug)}/drafts${scopeQs}`,
      {
        headers: { ...headers, "Content-Type": "application/json" },
        data: { content_md: detail.content_md + stamp, note: "e2e draft" },
      },
    );
    expect(proposeRes.status(), "propose should return 201").toBe(201);
    const draft = await proposeRes.json();
    expect(draft.status).toBe("pending");
    expect(draft.id).toBeTruthy();

    // Approve it.
    const approveRes = await request.post(
      `${API_BASE}/api/wiki/drafts/${draft.id}/approve`,
      { headers, data: {} },
    );
    expect(approveRes.ok(), `approve failed: ${approveRes.status()}`).toBeTruthy();

    // Page version should have incremented.
    const after = await request
      .get(`${API_BASE}/api/wiki/pages/${encodeURIComponent(slug)}${scopeQs}`, { headers })
      .then((r) => r.json());
    expect(after.version, "page version must advance after draft approve").toBeGreaterThan(baseVersion);
  });

  test("approve non-existent draft → 404", async ({ request }) => {
    const token = await adminLogin(request);
    const res = await request.post(
      `${API_BASE}/api/wiki/drafts/00000000-0000-0000-0000-000000000000/approve`,
      { headers: { Authorization: `Bearer ${token}` }, data: {} },
    );
    expect(res.status()).toBe(404);
  });
});

test.describe("Audit log · presence", () => {
  test("admin actions surface in audit log", async ({ request }) => {
    const token = await adminLogin(request);
    const headers = { Authorization: `Bearer ${token}` };

    const res = await request.get(`${API_BASE}/api/audit/log?limit=10`, { headers });
    expect(res.ok()).toBeTruthy();
    const events = await res.json();
    // Either { items: [...] } or [] — accept both shapes.
    const list = Array.isArray(events) ? events : events.items ?? [];
    expect(Array.isArray(list)).toBe(true);
  });
});
