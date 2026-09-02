# haitian-community-cares

Skills, content, and resources for The Haitian Community, Inc.

## Contents

- `skills/thc-blog-writer/SKILL.md` — Claude skill for drafting THC blog articles (enforces Read time + Excerpt, brand voice, fact-checking).
- `content/blog/` — 17 article drafts and published posts, all on the schema below.
- `scripts/validate_posts.py` — checks every post against that schema.

Working copies also live in Google Drive, with tasks tracked in the HCC Blog &
Content Notion database and sources backed up in Obsidian. The markdown in
`content/blog/` is the version of record for format.

## Post schema

Every post carries YAML frontmatter followed by the body structure the
`thc-blog-writer` skill requires. Frontmatter is the machine-readable copy;
the body block is what a reader sees.

```markdown
---
title: "Full article title"
date: 2026-07-13
category: "Policy_Legal"
status: "published"
readTime: 2
excerpt: "One to three sentences that stand alone as a teaser."
author: "HCC Content Intelligence Pipeline"   # original reporting
source: "The Haitian Times"                   # syndicated posts only
sourceUrl: "https://..."                      # syndicated posts only
lang: "en"
kreyolVersion: false
---

# Full article title

**Read time:** ~2 min

**Excerpt:** One to three sentences that stand alone as a teaser.

---

Article body, H2 sections as needed.

---

*Sources: [linked citations](https://...)*
```

| Field | Notes |
|-------|-------|
| `status` | `draft`, `in_review`, `published`, or `archived` |
| `readTime` | `max(1, round(body_words / 225))` — recomputed, never trusted |
| `excerpt` | Must match the `**Excerpt:**` line in the body exactly |
| `kreyolVersion` | `false` means a Kreyòl translation is still owed |

`title` must match the H1, and `excerpt` must match the body line — the
validator enforces both, so the two copies cannot drift.

## Validating

```bash
python3 scripts/validate_posts.py           # check every post
python3 scripts/validate_posts.py --fix     # recompute stale read times
```

Exits non-zero if any post fails, so it can gate a publish step. It also lists
every post still owing a Kreyòl version — that is reported, not a failure, so
a piece never looks finished while a step is outstanding.

Read time drifts whenever a draft is edited after its excerpt was written, so
run `--fix` before publishing rather than trusting the stored number.
