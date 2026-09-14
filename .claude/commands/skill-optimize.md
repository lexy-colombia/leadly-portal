---
description: Audit and rewrite a SKILL.md using Anthropic skill best practices
---
You are an expert in agent skill authoring. Your task is to audit and rewrite the SKILL.md (and its companion reference files if any) identified by the user.

The skill to optimize is: **$ARGUMENTS**

---

## Step 1 — Locate and read the skill

Search for the SKILL.md in these locations (in order):
1. `.opencode/skills/$ARGUMENTS/SKILL.md`
2. `.github/skills/$ARGUMENTS/SKILL.md`
3. `.agents/skills/$ARGUMENTS/SKILL.md`
4. `.claude/skills/$ARGUMENTS/SKILL.md`

Read the SKILL.md you find. Then read any reference files it links to (one level deep only — do NOT follow links inside reference files).

---

## Step 2 — Audit against these criteria

Evaluate the current skill on every point below. Mark each as PASS, FAIL, or N/A.

**Discovery (frontmatter)**
- [ ] `name` uses only lowercase letters, numbers, and hyphens; matches the directory name; ≤ 64 chars
- [ ] `description` is written in third person ("Processes...", not "I can..." or "You can...")
- [ ] `description` states BOTH what the skill does AND when to use it (specific triggers/contexts)
- [ ] `description` includes key domain terms an agent would match against a user request
- [ ] `description` ≤ 1024 chars; avoids XML tags and reserved words ("anthropic", "claude")

**Conciseness**
- [ ] SKILL.md body is under 500 lines
- [ ] Content assumes Claude already knows general concepts (no over-explaining)
- [ ] Verbose background prose is replaced with direct instructions or code
- [ ] Each paragraph justifies its token cost

**Degrees of freedom**
- [ ] High-freedom tasks use text instructions (not rigid scripts)
- [ ] Low-freedom / fragile tasks use exact commands with "Run exactly this" language
- [ ] The level of specificity matches the fragility of the operation

**Structure and progressive disclosure**
- [ ] SKILL.md is a table-of-contents / overview; detail lives in reference files
- [ ] Reference files are linked directly from SKILL.md (one level deep, not nested)
- [ ] Reference files longer than 100 lines have a table of contents at the top
- [ ] All file paths use forward slashes

**Terminology and content quality**
- [ ] One consistent term is used for each concept throughout (no "endpoint/URL/route/path" mix)
- [ ] No time-sensitive information (dates, "before/after X release" conditionals)
- [ ] Examples are concrete input/output pairs, not abstract descriptions
- [ ] No options soup — a single recommended approach is given, with an escape hatch if needed

**Workflows and feedback loops**
- [ ] Multi-step operations have numbered, sequential steps
- [ ] Critical operations include a validation/verify step before finalizing
- [ ] Complex workflows offer a copy-pasteable checklist

**Scripts (if present)**
- [ ] Scripts handle errors explicitly rather than punting to the agent
- [ ] No magic numbers — all constants are documented with their rationale
- [ ] Required packages are listed and the execution intent is clear ("Run X" vs "See X for reference")
- [ ] No Windows-style backslash paths

---

## Step 3 — Rewrite

Produce the optimized skill. Output each file separately, clearly labeled.

### Rules for the rewrite:
- Keep the directory name and `name` field unchanged unless it violates naming rules
- Rewrite the `description` to be third-person, specific, and trigger-rich
- Trim SKILL.md to a tight overview: purpose, when to use, core workflow, reference table
- Move or keep detail in reference files; do not inline large content into SKILL.md
- Replace vague prose with direct instructions, tables, or minimal code examples
- Apply the correct degree of freedom per section (text guidance vs exact commands)
- Ensure every file reference is one level deep from SKILL.md
- Add table of contents to any reference file that exceeds 100 lines
- Use consistent terminology; remove time-sensitive content

---

## Step 4 — Output format

Return results in this exact structure:

<audit_summary>
A short paragraph stating the 2–4 most impactful problems found. Skip minor issues that were already fine.
</audit_summary>

<failed_checks>
Bullet list of every FAIL from the audit, one line each.
</failed_checks>

<optimized_skill>

### FILE: <relative path to SKILL.md>
```markdown
<full rewritten SKILL.md content>
```

### FILE: <relative path to each changed reference file, if any>
```markdown
<full rewritten content>
```

</optimized_skill>

<change_log>
Concise bullet list: what changed and why (one line per change, referencing the principle).
</change_log>

Do not modify reference files that have no issues. Only output files that changed.
