#!/usr/bin/env python3
"""
Validate THC blog posts against the thc-blog-writer schema.

The skill mandates a Read time and an Excerpt on every article. This checks
that they are present, that the frontmatter and the visible body agree, and
that the Read time still matches the actual word count — drafts get edited
after the excerpt is written, so a stale number is the common failure.

Usage:
    python scripts/validate_posts.py            # check every post
    python scripts/validate_posts.py --fix      # recompute stale readTime values
    python scripts/validate_posts.py --path content/blog/01-foo.md

Exit code is 1 if any post fails, so this can gate a publish step.
"""

import re
import sys
import argparse
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BLOG_DIR = REPO / "content" / "blog"

REQUIRED = ["title", "date", "category", "status", "readTime", "excerpt",
            "lang", "kreyolVersion"]
VALID_STATUS = {"draft", "in_review", "published", "archived"}
WORDS_PER_MINUTE = 225

# The skill requires a Kreyol version alongside the English one. A Kreyol
# article carries Kreyol labels, so the two required elements are matched per
# language rather than assuming English.
LABELS = {
    "en": ("Read time", "Excerpt"),
    "ht": ("Tan lekti", "Rezime"),
}


def split_frontmatter(raw: str):
    if not raw.startswith("---"):
        return None, raw
    lines = raw.split("\n")
    end = next((i for i, l in enumerate(lines[1:], 1) if l.strip() == "---"), None)
    if end is None:
        return None, raw
    meta = {}
    for line in lines[1:end]:
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip().strip('"').replace('\\"', '"')
    return meta, "\n".join(lines[end + 1:])


def labels_for(lang: str) -> tuple[str, str]:
    return LABELS.get((lang or "en").lower(), LABELS["en"])


def article_body(body: str, lang: str = "en") -> str:
    """The prose only: everything after the rule below the excerpt block."""
    _, excerpt_label = labels_for(lang)
    marker = re.search(rf"^\*\*{re.escape(excerpt_label)}:\*\*.*?^---$",
                       body, flags=re.M | re.S)
    text = body[marker.end():] if marker else body
    return re.sub(r"^\*(Sources?|Sous):.*$", "", text, flags=re.M | re.I)


def read_time(body: str, lang: str = "en") -> int:
    return max(1, round(len(article_body(body, lang).split()) / WORDS_PER_MINUTE))


def check(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8")
    meta, body = split_frontmatter(raw)
    problems = []

    if meta is None:
        return ["no YAML frontmatter"]

    for key in REQUIRED:
        if key not in meta:
            problems.append(f"missing frontmatter key: {key}")

    if meta.get("status") and meta["status"] not in VALID_STATUS:
        problems.append(
            f"status {meta['status']!r} not one of {sorted(VALID_STATUS)}")

    lang = meta.get("lang", "en")
    if lang.lower() not in LABELS:
        problems.append(f"lang {lang!r} not one of {sorted(LABELS)}")
    time_label, excerpt_label = labels_for(lang)

    # The two elements the skill calls non-negotiable.
    body_time = re.search(rf"^\*\*{re.escape(time_label)}:\*\*\s*~?(\d+)\s*min",
                          body, flags=re.M)
    body_excerpt = re.search(rf"^\*\*{re.escape(excerpt_label)}:\*\*\s*(.+?)(?:\n\n|\n---)",
                             body, flags=re.M | re.S)
    if not body_time:
        problems.append(f"body is missing the '**{time_label}:**' line")
    if not body_excerpt:
        problems.append(f"body is missing the '**{excerpt_label}:**' line")

    # A translation must name the article it came from, and that file must exist.
    if lang != "en":
        source = meta.get("translationOf")
        if not source:
            problems.append("translation is missing 'translationOf'")
        elif not (path.parent / source).exists():
            problems.append(f"translationOf points at a missing file: {source}")

    h1 = re.search(r"^#\s+(.+)$", body, flags=re.M)
    if not h1:
        problems.append("body is missing an H1 title")
    elif meta.get("title") and h1.group(1).strip() != meta["title"].strip():
        problems.append("H1 does not match frontmatter title")

    # Frontmatter and body must not drift apart.
    if body_excerpt and meta.get("excerpt"):
        if " ".join(body_excerpt.group(1).split()) != " ".join(meta["excerpt"].split()):
            problems.append("body excerpt differs from frontmatter excerpt")

    actual = read_time(body, lang)
    if body_time and int(body_time.group(1)) != actual:
        problems.append(
            f"body {time_label} is {body_time.group(1)} min, actual is {actual} min")
    if meta.get("readTime") and int(meta["readTime"]) != actual:
        problems.append(
            f"frontmatter readTime is {meta['readTime']}, actual is {actual}")

    return problems


def fix_read_time(path: Path) -> bool:
    raw = path.read_text(encoding="utf-8")
    meta, body = split_frontmatter(raw)
    if meta is None:
        return False
    lang = meta.get("lang", "en")
    time_label, _ = labels_for(lang)
    actual = read_time(body, lang)
    updated = re.sub(r"^readTime:.*$", f"readTime: {actual}", raw, flags=re.M)
    updated = re.sub(rf"^\*\*{re.escape(time_label)}:\*\*.*$",
                     f"**{time_label}:** ~{actual} min", updated, flags=re.M)
    if updated != raw:
        path.write_text(updated, encoding="utf-8")
        return True
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", type=Path, default=None,
                        help="Check a single post instead of the whole folder")
    parser.add_argument("--fix", action="store_true",
                        help="Recompute stale readTime values in place")
    args = parser.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    paths = [args.path] if args.path else sorted(BLOG_DIR.glob("*.md"))
    if not paths:
        print(f"No posts found in {BLOG_DIR}")
        return 1

    if args.fix:
        for path in paths:
            if fix_read_time(path):
                print(f"updated read time: {path.name}")

    failures = 0
    owed_kreyol = []
    for path in paths:
        problems = check(path)
        meta, _ = split_frontmatter(path.read_text(encoding="utf-8"))
        # A Kreyol article is not itself owed a Kreyol version.
        if (meta and meta.get("lang", "en") == "en"
                and str(meta.get("kreyolVersion", "")).lower() != "true"):
            owed_kreyol.append(path.name)
        if problems:
            failures += 1
            print(f"\nFAIL {path.name}")
            for problem in problems:
                print(f"  - {problem}")

    print(f"\n{len(paths) - failures}/{len(paths)} posts valid")
    if owed_kreyol:
        # Not a failure: the skill asks that an owed Kreyol version stay visible
        # rather than a piece looking finished when a step is outstanding.
        print(f"\nKreyol version still owed on {len(owed_kreyol)} post(s):")
        for name in owed_kreyol:
            print(f"  - {name}")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
