"""
하드코딩된 fontSize 값을 모두 +1.
SCALE_TOKENS 블록은 스킵.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "frontend" / "src"
PATTERN = re.compile(r'\bfontSize:\s*(\d+)(?![.\d])')
SKIP_MARKERS = ("SCALE_TOKENS",)


def process_file(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")

    # SCALE_TOKENS = { ... } 블록 감지
    skip_ranges = []
    for i, line in enumerate(lines):
        if any(m in line for m in SKIP_MARKERS) and "=" in line and "{" in line:
            depth = line.count("{") - line.count("}")
            j = i
            while depth > 0 and j + 1 < len(lines):
                j += 1
                depth += lines[j].count("{") - lines[j].count("}")
            skip_ranges.append((i, j))

    def in_skip(idx: int) -> bool:
        return any(a <= idx <= b for a, b in skip_ranges)

    changed = 0
    for i, line in enumerate(lines):
        if in_skip(i):
            continue

        def repl(m: re.Match) -> str:
            n = int(m.group(1))
            return f"fontSize: {n + 1}"

        new_line, count = PATTERN.subn(repl, line)
        if count:
            lines[i] = new_line
            changed += count

    if changed:
        path.write_text("\n".join(lines), encoding="utf-8")
    return changed


total_changes = 0
total_files = 0
for tsx in ROOT.rglob("*.tsx"):
    n = process_file(tsx)
    if n:
        total_files += 1
        total_changes += n
        print(f"  {tsx.relative_to(ROOT)}: {n} changes")

print(f"\nTotal: {total_changes} changes in {total_files} files")
