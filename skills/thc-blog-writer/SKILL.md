---
name: thc-blog-writer
description: >
  Writes and formats blog articles, educational pieces, business spotlights, and
  program success stories for The Haitian Community, Inc. Make sure to use this
  skill whenever the user asks to write, draft, post, or publish a blog post,
  article, or long-form content for The Haitian Community (or "Haitian Community
  Cares") — even if they just paste in research or notes and ask for "a post" or
  "an article" out of it. Enforces the org's required article format (Read time +
  Excerpt at the top), Grade 8 / bilingual writing standards, brand voice, and
  source verification before anything gets published.
allowed-tools: [Read, Write, Edit, WebSearch]
metadata:
  version: 1.0.0
---

# THC Blog Writer

## Overview

Turns research, notes, or a topic into a publish-ready article for The Haitian
Community's blog/content channels. Every article produced with this skill comes
out the door with two non-negotiable elements at the top — **Read time** and
**Excerpt** — plus the org's existing editorial standards (Grade 8 reading level,
active voice, brand voice/tone) applied consistently, so any draft is ready to
move straight into the editorial review step without rework.

## When To Use

- Drafting a new blog post, article, or "story" for The Haitian Community from
  pasted research, a topic, or a set of notes
- Reformatting/upgrading an existing draft that's missing a Read time or Excerpt
- Writing any of THC's recurring content types: business spotlights, educational
  articles, program success stories, event recaps
- The user says things like "turn this into a post," "write this up as an
  article," or "draft something for Haitian Community Cares"

## Instructions

### Step 1: Verify before writing

If the draft relies on statistics, dates, names, rulings, or claims about real
events, verify them with web search before publishing. Note any correction
inline (don't silently "fix" a number the user supplied — flag what changed and
why). Unverifiable claims should be softened or cut rather than published as fact.

### Step 2: Apply THC's writing standards

These come from the Content department's existing guidelines — this skill exists
to make sure they're actually applied every time, not just on file somewhere:

- **Reading level:** Grade 8. Short, direct sentences over clause-stacked ones.
- **Paragraphs:** 3–4 sentences max. Break up anything longer.
- **Voice:** active voice throughout.
- **Emphasis:** bold the key facts/numbers a skimming reader needs to catch.
- **Lists:** use bullet points for any list of 3+ items rather than burying them
  in a sentence.
- **Bilingual:** offer an English + Kreyòl version where the topic and timeline
  allow it. If only English is produced, say so, so an editor knows Kreyòl is
  still owed.
- **Tone by context** — match the situation:
  - Business listings → professional, descriptive
  - Community content → warm, engaging
  - Program info → informative, encouraging
  - Crisis/emergency → clear, direct, caring
  - Social repurposing → energetic, conversational
- **SEO basics:** primary keyword in the title and first paragraph; a meta
  description under 160 characters if one is requested; internal links to
  related THC content where relevant; descriptive URL slug matching the title.

### Step 3: Format the article — Read time + Excerpt are required

Every article gets this exact structure, in this order, no exceptions:

```markdown
# [Title]

**Read time:** ~[N] min

**Excerpt:** [1–3 sentences. The hook — what's at stake, the single most
surprising or important fact, or the question the piece answers. This is what
gets pulled into a newsletter teaser or social card, so it has to stand alone
without the rest of the article.]

---

[Article body — H2 sections as needed]

---

*Sources: [linked citations for any factual/statistical claims]*
```

**Calculating Read time:** count words in the body (excluding the
Read-time/Excerpt block itself and the Sources line), divide by 225
(average adult reading speed), round to the nearest minute, floor of 1 minute.

```
read_minutes = max(1, round(word_count / 225))
```

**Writing the Excerpt:** write it last, after the draft is done — it's easier
to pull the strongest line out of a finished piece than to predict it up front.
It should work as a standalone teaser (think: the line that would appear in a
newsletter or social post linking to the full article), not just a restatement
of the title.

### Step 4: Hand off

Note in your reply to the user where the editorial process picks up from here
(Review → Approval → Publishing → Distribution, per the Content department's
process), and flag anything still owed — a Kreyòl version, an image, a meta
description — rather than letting it look "done" when a step is outstanding.

## Examples

**Input:** "Turn this research about the TPS ruling into a blog post for THC."

**Output:** A markdown file with H1 title → Read time → Excerpt → `---` →
body in H2 sections, Grade-8/active-voice prose in short paragraphs, bolded
key stats, and a closing Sources block with links for every factual claim.

## Dependencies

- None required. WebSearch is used opportunistically for fact-checking when
  the draft includes verifiable claims.

## Notes

- If the user supplies a draft that already has a Read time or Excerpt,
  recompute the Read time against the actual word count rather than trusting
  a stale number — drafts get edited after the excerpt is written.
- This skill governs format and standards; it does not replace the human
  Review/Approval steps in THC's editorial process.
- Related: `thc-outreach-scheduler` (content calendar/scheduling once a piece
  is ready to publish).
