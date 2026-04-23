"""
전체 UI 80% 스케일 — 하드코딩된 인라인 스타일 값 일괄 축소.

대상: frontend/src/**/*.tsx  (App.tsx 의 SCALE_TOKENS 정의 블록은 제외)
스케일 대상 속성: fontSize, padding, margin, gap
  - 정수형 값만 처리: `prop: N` (N은 1 이상 정수)
  - 문자열 padding (예: '4px 8px') 또는 음수/소수는 스킵
건드리지 않음: height, width (스크린샷/아이콘/미디어 크기 섞여있음)
"""
import re
import sys
from pathlib import Path

SCALE = 0.8
ROOT = Path(__file__).resolve().parent.parent / "frontend" / "src"
PROPS = ("fontSize", "padding", "margin", "marginTop", "marginBottom",
         "marginLeft", "marginRight", "paddingTop", "paddingBottom",
         "paddingLeft", "paddingRight", "gap")

# `prop: 숫자` (숫자 뒤에 다른 숫자/소수점이 오면 매치 안됨)
PATTERN = re.compile(
    r'\b(' + '|'.join(PROPS) + r'):\s*(\d+)(?![.\d])'
)

SKIP_REGION_MARKERS = ("SCALE_TOKENS", "do-not-scale")


def scale_value(n: int) -> int:
    if n <= 1:
        return n
    scaled = round(n * SCALE)
    return max(1, scaled)


def process_file(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")
    changed = 0

    # SCALE_TOKENS 블록 감지: `SCALE_TOKENS = {` ~ `}` 스킵
    skip_ranges = []
    for i, line in enumerate(lines):
        if any(m in line for m in SKIP_REGION_MARKERS) and "=" in line and "{" in line:
            # 블록 끝 찾기 (간단히 } as const; 또는 첫 닫힘 중괄호로 종료)
            depth = line.count("{") - line.count("}")
            j = i
            while depth > 0 and j + 1 < len(lines):
                j += 1
                depth += lines[j].count("{") - lines[j].count("}")
            skip_ranges.append((i, j))

    def in_skip(idx: int) -> bool:
        return any(a <= idx <= b for a, b in skip_ranges)

    for i, line in enumerate(lines):
        if in_skip(i):
            continue

        def repl(m: re.Match) -> str:
            prop, n = m.group(1), int(m.group(2))
            new_n = scale_value(n)
            if new_n == n:
                return m.group(0)
            return f"{prop}: {new_n}"

        new_line, count = PATTERN.subn(repl, line)
        if count:
            lines[i] = new_line
            changed += count

    if changed:
        path.write_text("\n".join(lines), encoding="utf-8")
    return changed


def main() -> int:
    total_files = 0
    total_changes = 0
    for tsx in ROOT.rglob("*.tsx"):
        n = process_file(tsx)
        if n:
            total_files += 1
            total_changes += n
            rel = tsx.relative_to(ROOT)
            print(f"  {rel}: {n} changes")

    print(f"\nTotal: {total_changes} changes in {total_files} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
