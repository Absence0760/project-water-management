"""Generate the string-decoding fixture and what openpyxl reads from it (issue #22).

    python scripts/wbt-import/make_string_decoding_fixture.py [OUTDIR]

Writes, into OUTDIR (default scripts/wbt-import/fixtures/):

  string_decoding.xlsx        a one-sheet workbook whose XML is written by hand
  string_decoding.cells.json  every cell openpyxl reads from it, as the importer
                              opens a workbook (read-only, cached values)

The in-browser importer's reader must decode cell text exactly as openpyxl
does, since the Python importer is the reference the port matches. The XML is
written by hand because no spreadsheet program writes most of these cases on
demand: Excel's `_xHHHH_` escapes (and `_x005F_`, its escape for a literal
underscore) in shared, inline and formula strings, a formula's cached text
(`t="str"`) holding entity references, numeric character references (a CR, a
character beyond U+FFFF), literal line breaks, CDATA, and rich-text runs.
Every value is invented. `frontend/src/lib/spreadsheet/import/stringDecoding.test.ts`
reads the workbook with the TypeScript reader and compares every cell with the
committed JSON; `test_string_decoding.py` checks the JSON is still what
openpyxl reads.

The bytes are deterministic (stored zip entries, a fixed timestamp).
"""

from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path
from typing import Any

import openpyxl

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
STEM = "string_decoding"
WORKBOOK_NAME = f"{STEM}.xlsx"
CELLS_NAME = f"{STEM}.cells.json"
ZIP_TIME = (2026, 1, 1, 0, 0, 0)

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

# Shared strings, as raw XML inside <sst>. The comment says what openpyxl reads.
SHARED_STRINGS: list[str] = [
    "<si><t>Plain header</t></si>",  # 0: control
    "<si><t>Flow_x000D__x000A_(m3/day)</t></si>",  # 1: _xHHHH_ kept as written
    "<si><t>Literal _x005F_x000D_ text</t></si>",  # 2: 'x005F_' removed: '_x000D_'
    "<si><t>Alpha &amp;amp; Bravo &amp; Co</t></si>",  # 3: one decode: 'Alpha &amp; Bravo & Co'
    "<si><t>CR LF ref&#13;&#10;next</t></si>",  # 4: numeric references kept: CR LF
    "<si><t>Literal CR LF\r\nnext\rlast</t></si>",  # 5: literal line breaks normalised to LF by the XML parser
    "<si><t>Beyond BMP &#128167; &#x1F4A7;</t></si>",  # 6: one character each, not truncated
    "<si><r><t>Rich_x0041_</t></r><r><rPr><b/></rPr><t xml:space=\"preserve\"> run &amp;amp;</t></r></si>",  # 7: runs joined, one decode
    "<si><t><![CDATA[CDATA _x000D_ &amp; kept]]></t></si>",  # 8: CDATA literal
    "<si><t>Mid x005F_ word</t></si>",  # 9: 'x005F_' removed anywhere in a shared string
    "<si><t>Upper &#x2014; dash _X000D_</t></si>",  # 10: hex reference; an upper-case escape is text too
]

# (cell, attributes, body)
CELLS: list[tuple[str, str, str]] = [
    ("A1", ' t="s"', "<v>0</v>"),
    ("A2", ' t="s"', "<v>1</v>"),
    ("A3", ' t="s"', "<v>2</v>"),
    ("A4", ' t="s"', "<v>3</v>"),
    ("A5", ' t="s"', "<v>4</v>"),
    ("A6", ' t="s"', "<v>5</v>"),
    ("A7", ' t="s"', "<v>6</v>"),
    ("A8", ' t="s"', "<v>7</v>"),
    ("A9", ' t="s"', "<v>8</v>"),
    ("A10", ' t="s"', "<v>9</v>"),
    ("A11", ' t="s"', "<v>10</v>"),
    # A formula's cached text: decoded once, no _xHHHH_ handling.
    ("B1", ' t="str"', '<f>"Echo "&amp;"Farm"</f><v>Echo Farm</v>'),  # control
    ("B2", ' t="str"', "<f>A4</f><v>Alpha &amp;amp; Bravo</v>"),  # 'Alpha &amp; Bravo'
    ("B3", ' t="str"', "<f>A2</f><v>Flow_x000D_</v>"),  # kept as written
    ("B4", ' t="str"', "<f>X1</f><v>a &amp;lt;b&amp;gt; &amp;#65;</v>"),  # 'a &lt;b&gt; &#65;'
    ("B5", ' t="str"', "<f>X2</f><v>Golf x005F_ &#13;&#10;Hotel</v>"),  # no x005F_ removal outside shared strings
    ("B6", ' t="str"', "<f>X3</f><v>Beyond &#128167;</v>"),
    # Inline strings: decoded once, no _xHHHH_ handling, no x005F_ removal.
    ("C1", ' t="inlineStr"', "<is><t>Inline &amp;amp; _x000D_ x005F_</t></is>"),
    ("C2", ' t="inlineStr"', "<is><r><t>In_x0041_</t></r><r><t>line &amp;#66;</t></r></is>"),
    # Numbers: a control, and one written with character references.
    ("D1", "", "<v>12.5</v>"),
    ("D2", "", "<v>&#49;&#50;</v>"),
]


def sst_xml() -> str:
    body = "".join(SHARED_STRINGS)
    n = len(SHARED_STRINGS)
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="{MAIN_NS}" count="{n}" uniqueCount="{n}">{body}</sst>'


def sheet_xml() -> str:
    rows: dict[int, list[str]] = {}
    for ref, attrs, body in CELLS:
        row = int("".join(ch for ch in ref if ch.isdigit()))
        rows.setdefault(row, []).append(f'<c r="{ref}"{attrs}>{body}</c>')
    data = "".join(f'<row r="{r}">{"".join(cells)}</row>' for r, cells in sorted(rows.items()))
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="{MAIN_NS}" xmlns:r="{REL_NS}">'
        f'<dimension ref="A1:D11"/><sheetData>{data}</sheetData></worksheet>'
    )


def parts() -> list[tuple[str, str]]:
    ct = "application/vnd.openxmlformats-officedocument.spreadsheetml"
    return [
        (
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            f'<Override PartName="/xl/workbook.xml" ContentType="{ct}.sheet.main+xml"/>'
            f'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="{ct}.worksheet+xml"/>'
            f'<Override PartName="/xl/sharedStrings.xml" ContentType="{ct}.sharedStrings+xml"/>'
            "</Types>",
        ),
        (
            "_rels/.rels",
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{PKG_REL_NS}">'
            f'<Relationship Id="rId1" Type="{REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        ),
        (
            "xl/workbook.xml",
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="{MAIN_NS}" xmlns:r="{REL_NS}">'
            '<sheets><sheet name="Strings" sheetId="1" r:id="rId1"/></sheets>'
            # zAppVer points at the sheet so the TypeScript reader parses it (it reads only the sheets b023 names point at).
            '<definedNames><definedName name="zAppVer">Strings!$A$1</definedName></definedNames></workbook>',
        ),
        (
            "xl/_rels/workbook.xml.rels",
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{PKG_REL_NS}">'
            f'<Relationship Id="rId1" Type="{REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>'
            f'<Relationship Id="rId2" Type="{REL_NS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
        ),
        ("xl/worksheets/sheet1.xml", sheet_xml()),
        ("xl/sharedStrings.xml", sst_xml()),
    ]


def workbook_bytes() -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        for name, text in parts():
            zi = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            zi.compress_type = zipfile.ZIP_STORED
            zi.external_attr = 0o644 << 16
            # newline="" semantics: the literal CR and CRLF in SHARED_STRINGS reach the part as written.
            z.writestr(zi, text.encode("utf-8"))
    return out.getvalue()


def read_cells(path: Path) -> dict[str, Any]:
    """Every non-empty cell, opened the way extract_project.py opens a workbook."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True, keep_vba=False)
    try:
        cells: dict[str, Any] = {}
        for row in wb["Strings"].iter_rows():
            for c in row:
                if getattr(c, "value", None) is not None:
                    cells[c.coordinate] = c.value
        return cells
    finally:
        wb.close()


def dump_cells(cells: dict[str, Any]) -> str:
    # ASCII-escaped, so a CR, a LF or a character beyond the BMP is visible in review.
    return json.dumps(cells, indent=2, ensure_ascii=True) + "\n"


def main(argv: list[str]) -> int:
    outdir = Path(argv[1]) if len(argv) > 1 else FIXTURES
    outdir.mkdir(parents=True, exist_ok=True)
    workbook = outdir / WORKBOOK_NAME
    workbook.write_bytes(workbook_bytes())
    (outdir / CELLS_NAME).write_text(dump_cells(read_cells(workbook)), encoding="utf-8")
    print(f"{workbook} ({workbook.stat().st_size} bytes) + {CELLS_NAME}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
