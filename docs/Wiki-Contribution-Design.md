Wiki Contribution & Edit
2.1 Pivot: No Re-ingestion for Updates
Re-ingestion is a batch reset operation, not an update mechanism.
Originally we considered using re-ingestion to merge user contributions,
but this is wrong:

LLM rewrites approved contributions on next compile → user loses trust
Token cost and non-deterministic output
Hard to debug when content disappears
Defeats the purpose of human review

New principle: Wiki is a stateful artifact that humans and LLMs
co-edit. Re-ingestion is reserved for:

Retry on failure — initial ingest failed (timeout, parse error)
Manual rebuild — admin explicitly chooses to rebuild, accepting that
manual edits will be overwritten (with confirmation dialog)

2.2 Source-of-Truth Clarification
Post-pivot, the data model has two sources of truth:

Documents = source of truth for original input (raw materials)
Wiki = source of truth for organizational knowledge (curated output)

These are no longer continuously synced. That is a feature, not a bug.
Users must understand this distinction (UI hints, docs).
2.3 Three Distinct Action Types
ActionWhoReview?EffectContribute DocumentMember+OptionalAdds to documents, queues ingestionPropose Wiki DraftMember+RequiredCreates pending draft for reviewEdit Wiki DirectlyEditor/AdminNoneSync write to wiki, creates revision
2.4 Schema
wiki_page_drafts — replaces user_contribution_md column
sqlCREATE TABLE wiki_page_drafts (
    id UUID PRIMARY KEY,
    page_id UUID FK → wiki_pages,
    author_id UUID FK → employees,
    content_md TEXT,
    note TEXT,                          -- explanation from author
    status VARCHAR(20),                 -- pending | approved | rejected
    source VARCHAR(20),                 -- web_ui | mcp_claude | mcp_other
    source_metadata JSONB,              -- AI client name, original prompt (opt-in)
    reviewed_by_id UUID FK → employees,
    reviewed_at TIMESTAMPTZ,
    reviewer_note TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);
wiki_page_revisions — full version history
sqlCREATE TABLE wiki_page_revisions (
    id UUID PRIMARY KEY,
    page_id UUID FK → wiki_pages,
    version INT,
    content_md TEXT,                    -- full snapshot
    change_type VARCHAR(30),
    -- agent_compile | agent_retry | editor_edit | draft_approved | manual_rebuild
    draft_id UUID FK → wiki_page_drafts NULL,
    changed_by_id UUID FK → employees,
    change_note TEXT,
    created_at TIMESTAMPTZ
);
2.5 Workflow: Draft → Review → Approve
[Contributor] propose draft
        ↓
wiki_page_drafts (status=pending)
        ↓
[Editor/Admin] notified
        ↓
Review (with inline edit allowed)
        ↓
Approve  →  sync write to content_md
         →  create revision (change_type=draft_approved)
         →  close draft (status=approved)
Reject   →  close draft (status=rejected, with reviewer_note)
2.6 Workflow: Direct Edit
[Editor/Admin] edit wiki page
        ↓
Sync write content_md
        ↓
Create revision (change_type=editor_edit)
        ↓
Done (no review step)
2.7 Decisions on Open Questions
QuestionDecisionMultiple concurrent drafts per page?Yes, allow many. Editor sees all and resolves.Editor edits draft before approving?Yes, inline editing. Reject-and-ask-again is poor UX.Global pages (SOP, regulation) — propose vs read-only?Propose, admin reviews. Read-only is too rigid.Inline edit UX (Notion-style vs form)?Form first for MVP. Notion-style later.Notification mechanism?In-app badge for MVP. Email later.
2.8 Document Update Behavior
When a user uploads a new version of an existing document and that
document already has a derived wiki page with manual edits:
Decision: Show admin a confirmation dialog:

"Wiki page X is derived from this document and has manual edits.
What do you want to do?

Rebuild wiki page (manual edits will be lost, archived in revisions)
Create a new wiki page for this document version
Keep current wiki, replace document only"


Never auto-rebuild. Always require explicit human decision.
2.9 Document Deletion Behavior
When a document with derived wiki content is deleted:

Wiki page is not cascade-deleted
Wiki page is marked orphaned=true with original source_document_id preserved
Admin sees orphaned pages in a maintenance view and decides per case


Part 3 — MCP-Driven Contribution
3.1 Why This Matters
This is the core differentiator of Arkon. Traditional internal tools
require users to switch context — open the portal, navigate, edit, save.
Arkon's value proposition is knowledge updates inline with AI workflow.

User is working with Claude Desktop. Discovers an insight, or Claude
identifies stale wiki content. User says "save this to the team wiki."
Claude calls an MCP tool. Contribution is created. User keeps working.
No tab switch. No browser. No flow break.

If Arkon requires the portal for routine knowledge updates, Arkon is just
another wiki tool. The MCP layer is what makes Arkon a managed
organizational AI resource rather than a database with a UI.
3.2 MCP Tool Inventory
Tier 1 — Read

search_wiki(query, workspace_id?) — semantic search
get_wiki_page(page_id) — full page content
list_workspace_pages(workspace_id) — page index
search_documents(query, workspace_id?) — search raw sources
get_document(document_id) — full document content

Tier 2 — Contribute (member-level)
ToolPurposepropose_wiki_edit(page_id, content_md, note)Edit existing page via draftpropose_new_wiki_page(workspace_id, title, content_md, note)Create new page via draftupload_document(workspace_id, title, content, department_ids)Add raw sourceadd_quick_note(workspace_id, content, tags)Loose contribution, no specific page
Tier 3 — Direct Edit (editor/admin only)
ToolPurposeedit_wiki_page(page_id, content_md, change_note)Sync direct edit, no reviewdelete_wiki_page(page_id, reason)Remove page
Tier 4 — Review (editor/admin only)
ToolPurposelist_pending_drafts(workspace_id?)Drafts awaiting reviewreview_draft(draft_id)Full draft content + diffapprove_draft(draft_id, reviewer_note?, edits?)Approve, optionally with inline editsreject_draft(draft_id, reviewer_note)Reject with reason
This symmetry is critical: both contribute and review happen inline with
AI. Editors can say "review pending drafts in finance workspace" and
Claude will pull, summarize, and recommend.
3.3 Identity & Permissions
Critical security principle: When Claude calls an MCP tool, the action
is authenticated as the user, not as Claude.
User logs into Claude Desktop with Arkon MCP token
   ↓
MCP token bound to employee_id
   ↓
Every MCP call resolves identity from token
   ↓
Permission engine applied identically to REST API
   ↓
Action recorded with user identity (not Claude's)
No exceptions. "Claude suggested it" is not a bypass. The same
permission engine from Part 1 governs MCP and REST equally.
3.4 Confirmation Pattern
When user asks Claude to write to wiki, Claude should not silently
submit. Required pattern:
User: "Save this Q4 budget insight to the finance team wiki"
Claude:
  1. search_wiki("Q4 budget", workspace_id=finance)
  2. Identifies relevant page or proposes new
  3. Drafts content
  4. Shows user: "Will propose edit to page 'Q4 Planning' with this content: [...]
                  Confirm to submit?"
  5. User confirms
  6. Claude calls propose_wiki_edit
  7. Reports back: "Submitted as draft. Editor will review."
This pattern is:

Not enforceable by Arkon alone (Claude could skip steps)
Encouraged by MCP server description that instructs Claude to confirm
Backed by the editor review step (defense in depth)

The editor review is the hard guarantee. Confirmation is UX hygiene.
3.5 Auto-Propose Behavior
Decision: AI does not auto-propose. User must explicitly request.
If Claude detects a wiki inaccuracy mid-conversation, it should flag
the user:

"I notice the wiki page on X says Y, which seems outdated based on this
conversation. Want me to propose an edit?"

Then wait for user confirmation. No background actions.
3.6 Rate Limiting
To prevent accidental or malicious spam through MCP:

20 drafts per user per day via MCP
5 documents uploaded per user per hour via MCP
Rate limits per user, not per AI client
Direct edits by editor/admin via MCP — no rate limit (trusted role)

3.7 Source Tracking
Every contribution records its source in wiki_page_drafts.source:
Source valueMeaningweb_uiSubmitted via Arkon portalmcp_claude_desktopVia Claude Desktop MCPmcp_claude_codeVia Claude Code MCPmcp_otherOther MCP clientsapi_directDirect REST API call
Editors see this on every draft. AI-generated submissions may warrant
extra scrutiny — the metadata enables that judgment without forcing it.
3.8 Audit Logging
Every MCP-driven write must log:

Action type and target
User identity (employee_id)
AI client identifier (user-agent, MCP session metadata)
Timestamp
Original prompt (optional, opt-in per organization)

When disputes arise — "who wrote this into the wiki?" — the answer must
be unambiguous. AI is a proxy; accountability stays with the user.

