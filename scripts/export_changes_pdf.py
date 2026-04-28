"""
One-off: build a PDF summary of uncommitted / pre-push work (CI + tests).
Run from repo root: python scripts/export_changes_pdf.py
"""
from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from fpdf import FPDF
except ImportError:
    print("Install fpdf2: pip install fpdf2", file=sys.stderr)
    raise


REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "CHANGES_REVIEW.pdf"


def run_git(args: list[str]) -> str:
    p = subprocess.run(
        ["git", "-C", str(REPO), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if p.returncode != 0:
        return f"(git {' '.join(args)} failed: {p.stderr})"
    return p.stdout or ""


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def safe(s: str) -> str:
    return s.replace("\r\n", "\n").replace("\r", "\n")


# fpdf2 core fonts are Latin-1; normalize so CI/diffs do not break PDF output
def ascii_sanitize(s: str) -> str:
    t = safe(s)
    t = t.replace("\t", "    ")
    for a, b in [
        ("\u2014", "-"),  # em dash
        ("\u2013", "-"),  # en dash
        ("\u2018", "'"),
        ("\u2019", "'"),
        ("\u201c", '"'),
        ("\u201d", '"'),
        ("\u2026", "..."),
    ]:
        t = t.replace(a, b)
    return t.encode("ascii", "replace").decode("ascii")


class Doc(FPDF):
    def footer(self) -> None:
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.cell(0, 10, f"Page {self.page_no()}", align="C")


def add_heading(pdf: Doc, text: str) -> None:
    pdf.set_font("Helvetica", "B", 14)
    pdf.multi_cell(0, 8, ascii_sanitize(text))
    pdf.ln(2)


def add_subheading(pdf: Doc, text: str) -> None:
    pdf.set_font("Helvetica", "B", 11)
    pdf.multi_cell(0, 6, ascii_sanitize(text))
    pdf.ln(1)


def add_body(pdf: Doc, text: str) -> None:
    pdf.set_font("Helvetica", "", 10)
    pdf.multi_cell(0, 5, ascii_sanitize(text))
    pdf.ln(2)


def add_code(pdf: Doc, text: str) -> None:
    pdf.set_font("Courier", "", 6.5)
    pdf.set_x(pdf.l_margin)
    w = pdf.w - pdf.l_margin - pdf.r_margin
    for line in ascii_sanitize(safe(text)).split("\n"):
        if not line:
            line = " "
        if len(line) > 110:
            rest = line
            while rest:
                chunk, rest = rest[:110], rest[110:]
                pdf.set_x(pdf.l_margin)
                pdf.multi_cell(w, 3.2, chunk, new_x="LMARGIN", new_y="NEXT")
        else:
            pdf.set_x(pdf.l_margin)
            pdf.multi_cell(w, 3.2, line, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(1)


def main() -> None:
    branch = run_git(["rev-parse", "--abbrev-ref", "HEAD"]).strip() or "?"
    head = run_git(["rev-parse", "--short", "HEAD"]).strip() or "?"

    pdf = Doc()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    add_heading(pdf, "432Project - local changes (pre-push review)")
    add_body(
        pdf,
        f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n"
        f"Branch: {branch}\n"
        f"HEAD: {head}\n"
        f"Not yet committed: working tree (CI + tests work).",
    )

    add_heading(pdf, "1. Summary of what you added or changed")
    add_body(
        pdf,
        "- GitHub Actions workflow (.github/workflows/ci.yml): CI on push and "
        "pull request: Python job (pytest) and Node job (npm test).\n"
        "- Node tests: package.json `test` runs node:test on test/server.test.cjs; "
        "tests cover yahooChartSymbol and filterCandlesByRange.\n"
        "- server.js: startListen returns the server; only listen when the file is "
        "the main entry; module.exports app, yahooChartSymbol, filterCandlesByRange, "
        "startListen for testing.\n"
        "- Python API tests: pytest + TestClient, Neo4j mocked via monkeypatch; "
        "pytest.ini and requirements-test.txt; tests/ package with test_api.py.\n"
        "- .gitignore: Python cache and .pytest_cache.\n"
        "- New files: .github/, pytest.ini, requirements-test.txt, test/, tests/.",
    )

    add_heading(pdf, "2. git status (short)")
    add_code(pdf, run_git(["status", "-sb"]) + run_git(["status", "--porcelain"]))

    add_heading(pdf, "3. Unified diff (modified tracked files)")
    add_subheading(pdf, "git diff")
    add_code(pdf, run_git(["diff", ".gitignore", "package.json", "server.js"]))

    for label, relpath in [
        (".github/workflows/ci.yml", ".github/workflows/ci.yml"),
        ("pytest.ini", "pytest.ini"),
        ("requirements-test.txt", "requirements-test.txt"),
        ("test/server.test.cjs", "test/server.test.cjs"),
        ("tests/__init__.py", "tests/__init__.py"),
        ("tests/test_api.py", "tests/test_api.py"),
    ]:
        p = REPO / relpath
        if p.is_file():
            add_subheading(pdf, f"New/changed file: {label}")
            add_code(pdf, read_text(p))
        else:
            add_subheading(pdf, f"(Missing: {relpath})")

    add_heading(pdf, "4. How to reproduce locally")
    add_body(
        pdf,
        "Node: npm install && npm test\n"
        "Python: pip install -r requirements-test.txt && python -m pytest -v",
    )

    pdf.output(str(OUT))
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
