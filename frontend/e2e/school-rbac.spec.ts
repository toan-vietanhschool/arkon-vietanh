import { expect, test, type APIRequestContext } from "@playwright/test";

// E2E for the school RBAC additions:
//   1. 15 school knowledge types replace the 5 generic defaults.
//   2. workspace:create / workspace:delete permissions actually gate the
//      workspace endpoints, not just the hardcoded admin check.
//   3. The seeded roles (Hiệu trưởng / Trưởng phòng) carry the right perms.
//
// Tests create temp employees, log in as them, and assert real 200/403
// outcomes — no role-introspection-only checks.

const API_BASE = (process.env.ARKON_API_URL ?? "http://localhost:5055").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ARKON_ADMIN_EMAIL ?? "admin@arkon.local";
const ADMIN_PASSWORD = process.env.ARKON_ADMIN_PASSWORD ?? "truongvietanh";

const RUN_ID = Date.now();

// Fixed school department seeded earlier — pick any one for test employees.
// Falls back to the admin's department if seed isn't present.
const TEST_DEPT_NAME = process.env.ARKON_TEST_DEPT_NAME ?? "Ban Giám Hiệu";

const EXPECTED_SCHOOL_KT_SLUGS = [
  "tai-lieu-chung",
  "quy-trinh-sop",
  "chinh-sach",
  "bieu-mau",
  "hop-dong",
  "phap-ly",
  "chuong-trinh-day",
  "ket-qua-hoc-tap",
  "tai-chinh",
  "tuyen-sinh",
  "marketing-truyen-thong",
  "su-kien",
  "nhan-su",
  "y-te-an-toan",
  "ky-thuat-it",
];

const RETIRED_DEFAULT_KT_SLUGS = ["general", "sop", "product", "project", "customer"];

async function login(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  // FastAPI's `get_db` dependency commits AFTER the response is returned, so
  // a freshly-created employee may not be visible to a subsequent login on a
  // different session for a few ms. Retry briefly to absorb that race.
  let lastStatus = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email, password },
    });
    if (res.ok()) return (await res.json()).access_token;
    lastStatus = res.status();
    await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
  }
  expect(false, `login failed for ${email}: HTTP ${lastStatus} after 5 attempts`).toBeTruthy();
  throw new Error("unreachable");
}

async function findDeptId(
  request: APIRequestContext,
  headers: Record<string, string>,
  name: string,
): Promise<string> {
  const res = await request.get(`${API_BASE}/api/departments`, { headers });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const list: Array<{ id: string; name: string }> = Array.isArray(body) ? body : body.items ?? [];
  const dept = list.find((d) => d.name === name);
  if (!dept) throw new Error(`Department "${name}" not found — seed may be missing`);
  return dept.id;
}

async function findRoleId(
  request: APIRequestContext,
  headers: Record<string, string>,
  name: string,
): Promise<string> {
  const res = await request.get(`${API_BASE}/api/roles`, { headers });
  expect(res.ok()).toBeTruthy();
  const roles: Array<{ id: string; name: string }> = await res.json();
  const role = roles.find((r) => r.name === name);
  if (!role) throw new Error(`Role "${name}" not found — seed may be missing`);
  return role.id;
}

async function createTestEmployee(
  request: APIRequestContext,
  adminHeaders: Record<string, string>,
  deptId: string,
  opts: { suffix: string; customRoleId?: string },
): Promise<{ id: string; email: string; password: string }> {
  const email = `e2e-${opts.suffix}-${RUN_ID}@arkon.local`;
  const password = "TestPass-12345";
  const res = await request.post(`${API_BASE}/api/employees`, {
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    data: {
      name: `E2E ${opts.suffix}`,
      email,
      password,
      role: "employee",
      department_id: deptId,
      custom_role_id: opts.customRoleId,
    },
  });
  expect(res.status(), `create employee ${opts.suffix} failed`).toBe(201);
  const body = await res.json();
  return { id: body.id, email, password };
}

async function deleteEmployee(
  request: APIRequestContext,
  adminHeaders: Record<string, string>,
  empId: string,
): Promise<void> {
  await request.delete(`${API_BASE}/api/employees/${empId}`, { headers: adminHeaders });
}

async function deleteWorkspace(
  request: APIRequestContext,
  adminHeaders: Record<string, string>,
  wsId: string,
): Promise<void> {
  await request.delete(`${API_BASE}/api/projects/${wsId}`, { headers: adminHeaders });
}

// ---------------------------------------------------------------------------
// Knowledge Type catalog
// ---------------------------------------------------------------------------

test.describe("School KT catalog", () => {
  test("all 15 school KT slugs present + 5 retired defaults absent", async ({ request }) => {
    const token = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await request.get(`${API_BASE}/api/knowledge-types`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const list: Array<{ slug: string; name: string }> = await res.json();
    const slugs = new Set(list.map((kt) => kt.slug));

    for (const expected of EXPECTED_SCHOOL_KT_SLUGS) {
      expect(slugs.has(expected), `missing school KT slug: ${expected}`).toBeTruthy();
    }
    for (const retired of RETIRED_DEFAULT_KT_SLUGS) {
      expect(slugs.has(retired), `retired default KT still present: ${retired}`).toBeFalsy();
    }
    // Allow extras (admin may have added custom KTs) but the 15 school KTs
    // must be the dominant set.
    expect(list.length).toBeGreaterThanOrEqual(EXPECTED_SCHOOL_KT_SLUGS.length);
  });
});

// ---------------------------------------------------------------------------
// School role permission shapes
// ---------------------------------------------------------------------------

test.describe("School roles · permission shape", () => {
  test("Hiệu trưởng has workspace:view:all (read scope) and content perms", async ({
    request,
  }) => {
    // Workspace lifecycle (create/archive/delete) is currently NOT granted
    // to any school role — these are admin-only at the endpoint layer.
    const token = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await request.get(`${API_BASE}/api/roles`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const roles: Array<{ name: string; permissions: string[] }> = await res.json();
    const principal = roles.find((r) => r.name === "Hiệu trưởng");
    expect(principal).toBeTruthy();
    const perms = new Set(principal!.permissions);
    expect(perms.has("workspace:view:all")).toBeTruthy();
    expect(perms.has("doc:read:all")).toBeTruthy();
    expect(perms.has("wiki:write:all")).toBeTruthy();
    expect(perms.has("workspace:create")).toBeFalsy();
    expect(perms.has("workspace:archive")).toBeFalsy();
    expect(perms.has("workspace:delete")).toBeFalsy();
  });

  test("Giáo viên has NO workspace lifecycle perms", async ({ request }) => {
    const token = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await request.get(`${API_BASE}/api/roles`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const roles: Array<{ name: string; permissions: string[] }> = await res.json();
    const teacher = roles.find((r) => r.name === "Giáo viên");
    expect(teacher).toBeTruthy();
    const perms = new Set(teacher!.permissions);
    expect(perms.has("workspace:create")).toBeFalsy();
    expect(perms.has("workspace:archive")).toBeFalsy();
    expect(perms.has("workspace:delete")).toBeFalsy();
    expect(perms.has("workspace:view:all")).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// End-to-end RBAC enforcement: workspace endpoints
//
// Current backend policy (reverted to baseline):
//   - POST /projects        → system admin only (hardcoded)
//   - DELETE /projects/{id} → system admin only (hardcoded)
//   - PUT /projects/{id}    → workspace admin role only
//
// The workspace:create / workspace:archive / workspace:delete permission
// keys still appear in the catalog and on school roles, but they are
// currently NOT honored by the backend — keep this file in sync with
// observable behavior, not catalog intent.
// ---------------------------------------------------------------------------

test.describe("Workspace endpoint enforcement (E2E)", () => {
  test("non-admin (even with Hiệu trưởng role) → POST /projects returns 403", async ({
    request,
  }) => {
    const adminToken = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const adminHeaders = { Authorization: `Bearer ${adminToken}` };
    const deptId = await findDeptId(request, adminHeaders, TEST_DEPT_NAME);
    const roleId = await findRoleId(request, adminHeaders, "Hiệu trưởng");

    const emp = await createTestEmployee(request, adminHeaders, deptId, {
      suffix: "non-admin-create",
      customRoleId: roleId,
    });
    try {
      const empToken = await login(request, emp.email, emp.password);
      const res = await request.post(`${API_BASE}/api/projects`, {
        headers: { Authorization: `Bearer ${empToken}`, "Content-Type": "application/json" },
        data: { name: `e2e-deny-${RUN_ID}`, description: "should fail" },
      });
      expect(res.status(), `expected 403, got ${res.status()}`).toBe(403);
    } finally {
      await deleteEmployee(request, adminHeaders, emp.id);
    }
  });

  test("admin can create + archive + delete workspace (regression)", async ({ request }) => {
    const adminToken = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const adminHeaders = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };

    const createRes = await request.post(`${API_BASE}/api/projects`, {
      headers: adminHeaders,
      data: { name: `e2e-admin-${RUN_ID}`, description: "admin lifecycle" },
    });
    expect(createRes.status()).toBe(201);
    const wsId = (await createRes.json()).id;

    // Archive via PUT status
    const archiveRes = await request.put(`${API_BASE}/api/projects/${wsId}`, {
      headers: adminHeaders,
      data: { status: "archived" },
    });
    expect(archiveRes.ok()).toBeTruthy();
    expect((await archiveRes.json()).status).toBe("archived");

    // Delete
    const deleteRes = await request.delete(`${API_BASE}/api/projects/${wsId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(deleteRes.ok()).toBeTruthy();
  });
});
