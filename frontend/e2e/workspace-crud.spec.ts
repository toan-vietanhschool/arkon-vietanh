import { expect, test, type APIRequestContext } from "@playwright/test";

// Full workspace + member CRUD coverage.
// All tests create their own workspace + employees and clean up in finally.

const API_BASE = (process.env.ARKON_API_URL ?? "http://localhost:5055").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ARKON_ADMIN_EMAIL ?? "admin@arkon.local";
const ADMIN_PASSWORD = process.env.ARKON_ADMIN_PASSWORD ?? "truongvietanh";
const TEST_DEPT_NAME = process.env.ARKON_TEST_DEPT_NAME ?? "Ban Giám Hiệu";

const RUN_ID = Date.now();

// ---------------------------------------------------------------------------
// Shared helpers (5-retry login absorbs create_employee commit race; see
// school-rbac.spec.ts:32 for the full explanation).
// ---------------------------------------------------------------------------

async function login(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  let last = 0;
  for (let i = 0; i < 5; i++) {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email, password },
    });
    if (res.ok()) return (await res.json()).access_token;
    last = res.status();
    await new Promise((r) => setTimeout(r, 100 * (i + 1)));
  }
  expect(false, `login failed for ${email}: HTTP ${last}`).toBeTruthy();
  throw new Error("unreachable");
}

async function adminAuth(request: APIRequestContext): Promise<{
  token: string;
  headers: Record<string, string>;
  jsonHeaders: Record<string, string>;
  deptId: string;
}> {
  const token = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD);
  const headers = { Authorization: `Bearer ${token}` };
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };
  const deptRes = await request.get(`${API_BASE}/api/departments`, { headers });
  const deptBody = await deptRes.json();
  const list: Array<{ id: string; name: string }> = Array.isArray(deptBody)
    ? deptBody
    : deptBody.items ?? [];
  const dept = list.find((d) => d.name === TEST_DEPT_NAME);
  if (!dept) throw new Error(`Department "${TEST_DEPT_NAME}" missing`);
  return { token, headers, jsonHeaders, deptId: dept.id };
}

async function createTestEmployee(
  request: APIRequestContext,
  adminJsonHeaders: Record<string, string>,
  deptId: string,
  suffix: string,
): Promise<{ id: string; email: string; password: string }> {
  const email = `e2e-${suffix}-${RUN_ID}@arkon.local`;
  const password = "TestPass-12345";
  const res = await request.post(`${API_BASE}/api/employees`, {
    headers: adminJsonHeaders,
    data: {
      name: `E2E ${suffix}`,
      email,
      password,
      role: "employee",
      department_id: deptId,
    },
  });
  expect(res.status(), `create emp ${suffix} → ${res.status()}`).toBe(201);
  return { id: (await res.json()).id, email, password };
}

async function createWorkspace(
  request: APIRequestContext,
  jsonHeaders: Record<string, string>,
  name: string,
  description = "e2e",
): Promise<{ id: string }> {
  const res = await request.post(`${API_BASE}/api/projects`, {
    headers: jsonHeaders,
    data: { name, description },
  });
  expect(res.status(), `create ws → ${res.status()}`).toBe(201);
  return { id: (await res.json()).id };
}

async function cleanup(
  request: APIRequestContext,
  adminHeaders: Record<string, string>,
  resources: { wsIds?: string[]; empIds?: string[] },
): Promise<void> {
  for (const id of resources.wsIds ?? []) {
    await request.delete(`${API_BASE}/api/projects/${id}`, { headers: adminHeaders });
  }
  for (const id of resources.empIds ?? []) {
    await request.delete(`${API_BASE}/api/employees/${id}`, { headers: adminHeaders });
  }
}

// ---------------------------------------------------------------------------
// A. Workspace lifecycle CRUD
// ---------------------------------------------------------------------------

test.describe("Workspace · CRUD lifecycle (admin)", () => {
  test("create → list → update (name/desc/type/status) → delete", async ({ request }) => {
    const { headers, jsonHeaders } = await adminAuth(request);
    const name = `ws-crud-${RUN_ID}`;

    // CREATE
    const created = await createWorkspace(request, jsonHeaders, name);
    const wsId = created.id;

    try {
      // READ list — must include the new workspace
      const listRes = await request.get(`${API_BASE}/api/projects`, { headers });
      expect(listRes.ok()).toBeTruthy();
      const list: Array<{ id: string; name: string; status: string; workspace_type: string }> =
        await listRes.json();
      const found = list.find((p) => p.id === wsId);
      expect(found, "new workspace must appear in list").toBeTruthy();
      expect(found!.name).toBe(name);
      expect(found!.status).toBe("active");
      expect(found!.workspace_type).toBe("project");

      // UPDATE name
      const renamed = `${name}-renamed`;
      const renameRes = await request.put(`${API_BASE}/api/projects/${wsId}`, {
        headers: jsonHeaders,
        data: { name: renamed },
      });
      expect(renameRes.ok()).toBeTruthy();
      expect((await renameRes.json()).name).toBe(renamed);

      // UPDATE description
      const newDesc = `updated-desc-${RUN_ID}`;
      const descRes = await request.put(`${API_BASE}/api/projects/${wsId}`, {
        headers: jsonHeaders,
        data: { description: newDesc },
      });
      expect(descRes.ok()).toBeTruthy();
      expect((await descRes.json()).description).toBe(newDesc);

      // UPDATE workspace_type project → customer
      const typeRes = await request.put(`${API_BASE}/api/projects/${wsId}`, {
        headers: jsonHeaders,
        data: { workspace_type: "customer" },
      });
      expect(typeRes.ok()).toBeTruthy();
      expect((await typeRes.json()).workspace_type).toBe("customer");

      // UPDATE status to archived
      const archiveRes = await request.put(`${API_BASE}/api/projects/${wsId}`, {
        headers: jsonHeaders,
        data: { status: "archived" },
      });
      expect(archiveRes.ok()).toBeTruthy();
      expect((await archiveRes.json()).status).toBe("archived");

      // Archived workspace still appears in list
      const list2: Array<{ id: string; status: string }> = await request
        .get(`${API_BASE}/api/projects`, { headers })
        .then((r) => r.json());
      expect(list2.find((p) => p.id === wsId)?.status).toBe("archived");
    } finally {
      // DELETE
      const delRes = await request.delete(`${API_BASE}/api/projects/${wsId}`, { headers });
      expect(delRes.ok()).toBeTruthy();

      // List no longer includes it
      const list3: Array<{ id: string }> = await request
        .get(`${API_BASE}/api/projects`, { headers })
        .then((r) => r.json());
      expect(list3.find((p) => p.id === wsId)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// B. Update validation
// ---------------------------------------------------------------------------

test.describe("Workspace · update validation", () => {
  test("invalid workspace_type → 400", async ({ request }) => {
    const { headers, jsonHeaders } = await adminAuth(request);
    const ws = await createWorkspace(request, jsonHeaders, `ws-valid-type-${RUN_ID}`);
    try {
      const res = await request.put(`${API_BASE}/api/projects/${ws.id}`, {
        headers: jsonHeaders,
        data: { workspace_type: "not-a-type" },
      });
      expect(res.status()).toBe(400);
    } finally {
      await cleanup(request, headers, { wsIds: [ws.id] });
    }
  });

  test("invalid status → 400", async ({ request }) => {
    const { headers, jsonHeaders } = await adminAuth(request);
    const ws = await createWorkspace(request, jsonHeaders, `ws-valid-status-${RUN_ID}`);
    try {
      const res = await request.put(`${API_BASE}/api/projects/${ws.id}`, {
        headers: jsonHeaders,
        data: { status: "trashed" },
      });
      expect(res.status()).toBe(400);
    } finally {
      await cleanup(request, headers, { wsIds: [ws.id] });
    }
  });

  test("non-existent workspace → 404", async ({ request }) => {
    const { jsonHeaders } = await adminAuth(request);
    const res = await request.put(`${API_BASE}/api/projects/00000000-0000-0000-0000-000000000000`, {
      headers: jsonHeaders,
      data: { name: "ghost" },
    });
    expect(res.status()).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// C. Member CRUD
// ---------------------------------------------------------------------------

test.describe("Workspace · member CRUD", () => {
  test("creator auto-added as workspace admin", async ({ request }) => {
    const { headers, jsonHeaders } = await adminAuth(request);
    const ws = await createWorkspace(request, jsonHeaders, `ws-member-creator-${RUN_ID}`);
    try {
      const res = await request.get(`${API_BASE}/api/projects/${ws.id}/members`, { headers });
      expect(res.ok()).toBeTruthy();
      const members: Array<{ employee_email: string; role: string }> = await res.json();
      expect(members.length).toBe(1);
      expect(members[0].employee_email).toBe(ADMIN_EMAIL);
      expect(members[0].role).toBe("admin");
    } finally {
      await cleanup(request, headers, { wsIds: [ws.id] });
    }
  });

  test("add → change role → remove member; last-admin protection blocks last admin", async ({
    request,
  }) => {
    const { headers, jsonHeaders, deptId } = await adminAuth(request);
    const ws = await createWorkspace(request, jsonHeaders, `ws-member-flow-${RUN_ID}`);
    const emp = await createTestEmployee(request, jsonHeaders, deptId, "member-flow");

    try {
      // ADD member as viewer
      const addRes = await request.post(`${API_BASE}/api/projects/${ws.id}/members`, {
        headers: jsonHeaders,
        data: { employee_id: emp.id, role: "viewer" },
      });
      expect(addRes.status()).toBe(201);

      // List now has 2 members
      const members1: Array<{ employee_id: string; role: string }> = await request
        .get(`${API_BASE}/api/projects/${ws.id}/members`, { headers })
        .then((r) => r.json());
      expect(members1.length).toBe(2);
      const newMember = members1.find((m) => m.employee_id === emp.id);
      expect(newMember?.role).toBe("viewer");

      // Duplicate add → 409
      const dupRes = await request.post(`${API_BASE}/api/projects/${ws.id}/members`, {
        headers: jsonHeaders,
        data: { employee_id: emp.id, role: "viewer" },
      });
      expect(dupRes.status()).toBe(409);

      // Invalid role on update → 400
      const badRoleRes = await request.patch(
        `${API_BASE}/api/projects/${ws.id}/members/${emp.id}`,
        { headers: jsonHeaders, data: { role: "godmode" } },
      );
      expect(badRoleRes.status()).toBe(400);

      // Update role viewer → editor (legitimate)
      const updRes = await request.patch(
        `${API_BASE}/api/projects/${ws.id}/members/${emp.id}`,
        { headers: jsonHeaders, data: { role: "editor" } },
      );
      expect(updRes.ok()).toBeTruthy();

      // LAST ADMIN PROTECTION: admin is the only admin — try to remove → 400
      // (need admin's employee id — fetch via /api/auth/me)
      const meRes = await request.get(`${API_BASE}/api/auth/me`, { headers });
      const adminEmpId: string = (await meRes.json()).id;

      const removeAdminRes = await request.delete(
        `${API_BASE}/api/projects/${ws.id}/members/${adminEmpId}`,
        { headers },
      );
      expect(removeAdminRes.status(), "removing last admin must 400").toBe(400);

      // Demote last admin → 400
      const demoteAdminRes = await request.patch(
        `${API_BASE}/api/projects/${ws.id}/members/${adminEmpId}`,
        { headers: jsonHeaders, data: { role: "editor" } },
      );
      expect(demoteAdminRes.status(), "demoting last admin must 400").toBe(400);

      // Promote test employee to admin → now there are 2 admins, can demote first
      const promoteRes = await request.patch(
        `${API_BASE}/api/projects/${ws.id}/members/${emp.id}`,
        { headers: jsonHeaders, data: { role: "admin" } },
      );
      expect(promoteRes.ok()).toBeTruthy();

      // Now demote original admin → allowed
      const demoteOk = await request.patch(
        `${API_BASE}/api/projects/${ws.id}/members/${adminEmpId}`,
        { headers: jsonHeaders, data: { role: "viewer" } },
      );
      expect(demoteOk.ok(), `expected demote OK now, got ${demoteOk.status()}`).toBeTruthy();

      // Remove now-viewer original — still allowed (no longer the last admin)
      const removeOk = await request.delete(
        `${API_BASE}/api/projects/${ws.id}/members/${adminEmpId}`,
        { headers },
      );
      expect(removeOk.ok()).toBeTruthy();

      // Final state: only test employee remains, as admin
      const finalMembers: Array<{ employee_id: string; role: string }> = await request
        .get(`${API_BASE}/api/projects/${ws.id}/members`, { headers })
        .then((r) => r.json());
      expect(finalMembers.length).toBe(1);
      expect(finalMembers[0].employee_id).toBe(emp.id);
      expect(finalMembers[0].role).toBe("admin");
    } finally {
      await cleanup(request, headers, { wsIds: [ws.id], empIds: [emp.id] });
    }
  });

  test("add non-existent employee → 404", async ({ request }) => {
    const { headers, jsonHeaders } = await adminAuth(request);
    const ws = await createWorkspace(request, jsonHeaders, `ws-add-ghost-${RUN_ID}`);
    try {
      const res = await request.post(`${API_BASE}/api/projects/${ws.id}/members`, {
        headers: jsonHeaders,
        data: {
          employee_id: "00000000-0000-0000-0000-000000000000",
          role: "viewer",
        },
      });
      expect(res.status()).toBe(404);
    } finally {
      await cleanup(request, headers, { wsIds: [ws.id] });
    }
  });

  test("add with invalid role → 400", async ({ request }) => {
    const { headers, jsonHeaders, deptId } = await adminAuth(request);
    const ws = await createWorkspace(request, jsonHeaders, `ws-bad-role-${RUN_ID}`);
    const emp = await createTestEmployee(request, jsonHeaders, deptId, "bad-role");
    try {
      const res = await request.post(`${API_BASE}/api/projects/${ws.id}/members`, {
        headers: jsonHeaders,
        data: { employee_id: emp.id, role: "ninja" },
      });
      expect(res.status()).toBe(400);
    } finally {
      await cleanup(request, headers, { wsIds: [ws.id], empIds: [emp.id] });
    }
  });
});

// ---------------------------------------------------------------------------
// D. Archive lifecycle (canonical soft-remove)
// ---------------------------------------------------------------------------

test.describe("Workspace · archive lifecycle (data preservation)", () => {
  test("archive preserves members + supports unarchive", async ({ request }) => {
    // Policy: school workspaces are NEVER hard-deleted by regular roles.
    // Archive is the canonical "remove from active view" — members, wiki,
    // and sources stay intact. Unarchive must return them.
    const { headers, jsonHeaders, deptId } = await adminAuth(request);
    const ws = await createWorkspace(request, jsonHeaders, `ws-archive-${RUN_ID}`);
    const emp = await createTestEmployee(request, jsonHeaders, deptId, "archive-target");

    try {
      // Add a second member so we can assert members survive archival.
      await request.post(`${API_BASE}/api/projects/${ws.id}/members`, {
        headers: jsonHeaders,
        data: { employee_id: emp.id, role: "editor" },
      });

      const membersBefore: Array<{ employee_id: string }> = await request
        .get(`${API_BASE}/api/projects/${ws.id}/members`, { headers })
        .then((r) => r.json());
      expect(membersBefore.length).toBe(2);

      // ARCHIVE
      const archiveRes = await request.put(`${API_BASE}/api/projects/${ws.id}`, {
        headers: jsonHeaders,
        data: { status: "archived" },
      });
      expect(archiveRes.ok()).toBeTruthy();
      expect((await archiveRes.json()).status).toBe("archived");

      // Members still intact
      const membersAfter: Array<{ employee_id: string; role: string }> = await request
        .get(`${API_BASE}/api/projects/${ws.id}/members`, { headers })
        .then((r) => r.json());
      expect(membersAfter.length, "archive must NOT remove members").toBe(2);
      const editor = membersAfter.find((m) => m.employee_id === emp.id);
      expect(editor?.role).toBe("editor");

      // Workspace still appears in list (archive is filterable, not hidden)
      const list: Array<{ id: string; status: string }> = await request
        .get(`${API_BASE}/api/projects`, { headers })
        .then((r) => r.json());
      const found = list.find((p) => p.id === ws.id);
      expect(found?.status).toBe("archived");

      // UNARCHIVE (recovery flow)
      const unarchiveRes = await request.put(`${API_BASE}/api/projects/${ws.id}`, {
        headers: jsonHeaders,
        data: { status: "active" },
      });
      expect(unarchiveRes.ok()).toBeTruthy();
      expect((await unarchiveRes.json()).status).toBe("active");

      // Members STILL intact after unarchive
      const membersRestored: Array<{ employee_id: string }> = await request
        .get(`${API_BASE}/api/projects/${ws.id}/members`, { headers })
        .then((r) => r.json());
      expect(membersRestored.length).toBe(2);
    } finally {
      await cleanup(request, headers, { wsIds: [ws.id], empIds: [emp.id] });
    }
  });
});

// ---------------------------------------------------------------------------
// E. Update access control (workspace admin only)
// ---------------------------------------------------------------------------

test.describe("Workspace · update access control", () => {
  test("workspace editor CANNOT rename — must be workspace admin", async ({ request }) => {
    const { headers, jsonHeaders, deptId } = await adminAuth(request);
    const ws = await createWorkspace(request, jsonHeaders, `ws-editor-rename-${RUN_ID}`);
    const editor = await createTestEmployee(request, jsonHeaders, deptId, "ws-editor");

    try {
      // Promote editor to workspace-editor (not admin)
      await request.post(`${API_BASE}/api/projects/${ws.id}/members`, {
        headers: jsonHeaders,
        data: { employee_id: editor.id, role: "editor" },
      });

      const editorToken = await login(request, editor.email, editor.password);
      const editorHeaders = {
        Authorization: `Bearer ${editorToken}`,
        "Content-Type": "application/json",
      };

      const res = await request.put(`${API_BASE}/api/projects/${ws.id}`, {
        headers: editorHeaders,
        data: { name: "renamed-by-editor" },
      });
      expect(res.status(), `expected 403, got ${res.status()}`).toBe(403);
    } finally {
      await cleanup(request, headers, { wsIds: [ws.id], empIds: [editor.id] });
    }
  });

  test("non-member CANNOT update workspace → 403", async ({ request }) => {
    const { headers, jsonHeaders, deptId } = await adminAuth(request);
    const ws = await createWorkspace(request, jsonHeaders, `ws-outsider-${RUN_ID}`);
    const outsider = await createTestEmployee(request, jsonHeaders, deptId, "outsider");

    try {
      const outToken = await login(request, outsider.email, outsider.password);
      const res = await request.put(`${API_BASE}/api/projects/${ws.id}`, {
        headers: { Authorization: `Bearer ${outToken}`, "Content-Type": "application/json" },
        data: { name: "renamed-by-outsider" },
      });
      expect(res.status()).toBe(403);
    } finally {
      await cleanup(request, headers, { wsIds: [ws.id], empIds: [outsider.id] });
    }
  });
});
