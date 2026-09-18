"""
Build a human-readable XLSX handoff for Basin Safety billing/AR to review and
sign off on the Enverus buyer-rule findings.

Source: JSON dump from dump-enverus-buyer-rules.ts (24 buyers, LEM type).
Out:    server/scripts/data/enverus-buyer-rules-review.xlsx
"""
import json
import sys
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.formatting.rule import CellIsRule
from openpyxl.worksheet.table import Table, TableStyleInfo

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "server" / "scripts" / "data"
SRC = DATA / "enverus-buyer-rules-lem-2026-05-06T16-10-39-815Z.json"
OUT = DATA / "enverus-buyer-rules-review.xlsx"

# ── Load + classify ───────────────────────────────────────────────────

dump = json.loads(SRC.read_text(encoding="utf-8"))
buyers = [r for r in dump["results"]
          if r["status"] == "ok" and isinstance(r.get("body"), dict)]

def cell_of(spec):
    if not spec: return "-"
    if spec.get("visible") is False: return "?"
    if spec.get("requiredOn"): return "R"
    if spec.get("editable") is False: return "RO"
    return "O"

def label_of(spec):
    return spec.get("customLabel") if spec else None

all_fields = sorted({k for b in buyers for k in b["body"].keys()})

field_data = {}
for f in all_fields:
    cells = []
    labels = []
    for b in buyers:
        spec = b["body"].get(f)
        cells.append(cell_of(spec))
        labels.append(label_of(spec))
    cell_set = set(cells)
    label_set = {l or "(none)" for l in labels}
    divergent = len(cell_set) > 1 or len(label_set) > 1
    field_data[f] = {
        "cells": cells,
        "labels": labels,
        "divergent": divergent,
        "cell_counts": {c: cells.count(c) for c in cell_set},
        "label_counts": {l: [x or "(none)" for x in labels].count(l) for l in label_set},
    }

universal_fields = [f for f, d in field_data.items() if not d["divergent"]]
divergent_fields = [f for f, d in field_data.items() if d["divergent"]]

always_required = [
    f for f in universal_fields
    if all(c == "R" for c in field_data[f]["cells"])
]

unique_to_one = [
    f for f in divergent_fields
    if sum(1 for c in field_data[f]["cells"] if c != "-") == 1
]

# ── Styling helpers ───────────────────────────────────────────────────

FONT = "Arial"

H1   = Font(name=FONT, size=16, bold=True)
H2   = Font(name=FONT, size=12, bold=True, color="FFFFFF")
H3   = Font(name=FONT, size=11, bold=True)
BODY = Font(name=FONT, size=10)
BODY_BOLD = Font(name=FONT, size=10, bold=True)
SMALL_ITAL = Font(name=FONT, size=9, italic=True, color="666666")

H2_FILL  = PatternFill("solid", start_color="305496")  # dark blue
HEADER_FILL = PatternFill("solid", start_color="D9E1F2")  # light blue
ALT_FILL = PatternFill("solid", start_color="F2F2F2")

R_FILL  = PatternFill("solid", start_color="F4B7B7")  # red-ish — required
O_FILL  = PatternFill("solid", start_color="C6EFCE")  # green — optional
RO_FILL = PatternFill("solid", start_color="FFE699")  # yellow — read-only
HID_FILL = PatternFill("solid", start_color="BFBFBF")  # grey — hidden
MISS_FILL = PatternFill("solid", start_color="FFFFFF")  # white — missing

CELL_FILLS = {"R": R_FILL, "O": O_FILL, "RO": RO_FILL, "?": HID_FILL, "-": MISS_FILL}

THIN = Side(border_style="thin", color="CCCCCC")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(horizontal="left", vertical="top", wrap_text=True)
CENTER = Alignment(horizontal="center", vertical="center")

wb = Workbook()

# ── Sheet 1: README ───────────────────────────────────────────────────

ws = wb.active
ws.title = "README"

ws["A1"] = "Enverus Buyer-Rule Review"
ws["A1"].font = H1
ws.merge_cells("A1:E1")

ws["A3"] = "What this is"
ws["A3"].font = H3
ws["A4"] = (
    "Enverus (OpenInvoice) lets each customer (buyer) configure which fields they require on "
    "submitted Field Tickets, what to call those fields, and which are optional. We pulled the "
    "live LEM (Labor/Equipment/Material) rules for every active buyer Basin Safety has access "
    "to. This workbook summarizes what's the same vs. different across buyers."
)
ws["A4"].font = BODY
ws["A4"].alignment = WRAP
ws.merge_cells("A4:E6")
ws.row_dimensions[4].height = 60

ws["A8"] = "What we need from you"
ws["A8"].font = H3
ws["A9"] = (
    "Please review (1) the Per-Buyer Required tab — confirm the required-field list looks right "
    "for each customer; and (2) the Field Labels tab — confirm we should use each customer's own "
    "label in the Sundog UI when a tech is filling out a ticket for that buyer. Flag anything "
    "that looks wrong or surprising; we'll bake what you bless into Sundog's billing profiles."
)
ws["A9"].font = BODY
ws["A9"].alignment = WRAP
ws.merge_cells("A9:E12")
ws.row_dimensions[9].height = 70

ws["A14"] = "Tab guide"
ws["A14"].font = H3

guide = [
    ("Summary",            "High-level counts and the always-required floor."),
    ("Divergent Matrix",   "Every field that varies × every buyer. Color-coded so you can eyeball it."),
    ("Field Labels",       "For each field that buyers rename, the list of label variants."),
    ("Per-Buyer Required", "One row per buyer; their required-field list."),
    ("Buyer-Unique Fields","Fields that only one buyer has (e.g., COP-only carve-outs)."),
]
for i, (tab, desc) in enumerate(guide):
    r = 15 + i
    ws.cell(row=r, column=1, value=tab).font = BODY_BOLD
    ws.cell(row=r, column=2, value=desc).font = BODY
    ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=5)

ws["A22"] = "Legend (used on Divergent Matrix)"
ws["A22"].font = H3
legend = [
    ("R",  "Required to submit a ticket",  R_FILL),
    ("O",  "Optional — visible & editable", O_FILL),
    ("RO", "Read-only on the form",          RO_FILL),
    ("?",  "Present but hidden by Enverus",  HID_FILL),
    ("-",  "Field doesn't exist for this buyer", MISS_FILL),
    ("*",  "Cell suffix means buyer uses a custom label (see Field Labels tab)", None),
]
for i, (sym, desc, fill) in enumerate(legend):
    r = 23 + i
    c = ws.cell(row=r, column=1, value=sym)
    c.font = BODY_BOLD
    c.alignment = CENTER
    c.border = BORDER
    if fill:
        c.fill = fill
    ws.cell(row=r, column=2, value=desc).font = BODY
    ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=5)

ws["A30"] = f"Source data: {SRC.name}"
ws["A30"].font = SMALL_ITAL
ws["A31"] = f"Generated: {dump['generatedAt']}"
ws["A31"].font = SMALL_ITAL
ws["A32"] = f"Buyers: {len(buyers)}  •  Fields: {len(all_fields)} total ({len(universal_fields)} universal, {len(divergent_fields)} divergent)"
ws["A32"].font = SMALL_ITAL

ws.column_dimensions["A"].width = 22
for col in "BCDE":
    ws.column_dimensions[col].width = 22

# ── Sheet 2: Summary ──────────────────────────────────────────────────

ws = wb.create_sheet("Summary")

ws["A1"] = "Summary"
ws["A1"].font = H1
ws.merge_cells("A1:D1")

ws["A3"] = "Buyers reviewed"
ws["B3"] = len(buyers)
ws["A4"] = "Fields seen in any buyer"
ws["B4"] = len(all_fields)
ws["A5"] = "Universal (same shape on every buyer)"
ws["B5"] = len(universal_fields)
ws["A6"] = "Divergent (varies across buyers)"
ws["B6"] = len(divergent_fields)
ws["A7"] = "Buyer-unique (only one buyer has this field)"
ws["B7"] = len(unique_to_one)
for r in range(3, 8):
    ws.cell(row=r, column=1).font = BODY_BOLD
    ws.cell(row=r, column=2).font = BODY

ws["A9"] = "Always-required fields (every buyer requires these for LEM)"
ws["A9"].font = H3
for i, f in enumerate(always_required):
    ws.cell(row=10 + i, column=1, value=f).font = BODY

ws["A" + str(10 + len(always_required) + 1)] = "Top label divergences (same field, many customer-facing names)"
top_label_div_row = 10 + len(always_required) + 1
ws.cell(row=top_label_div_row, column=1).font = H3

# Find divergent fields with the most label variants
label_div_fields = sorted(
    [(f, len([k for k in field_data[f]["label_counts"] if k != "(none)"])) for f in divergent_fields],
    key=lambda x: -x[1],
)
top_label_div_fields = [f for f, n in label_div_fields if n >= 2][:8]

r = top_label_div_row + 2
ws.cell(row=r, column=1, value="Field").font = BODY_BOLD
ws.cell(row=r, column=2, value="Distinct labels").font = BODY_BOLD
ws.cell(row=r, column=3, value="Most-common label").font = BODY_BOLD
ws.cell(row=r, column=4, value="Variants").font = BODY_BOLD
for c in range(1, 5):
    ws.cell(row=r, column=c).fill = HEADER_FILL
    ws.cell(row=r, column=c).border = BORDER

for f in top_label_div_fields:
    r += 1
    counts = {k: v for k, v in field_data[f]["label_counts"].items() if k != "(none)"}
    sorted_labels = sorted(counts.items(), key=lambda x: -x[1])
    most = sorted_labels[0] if sorted_labels else ("(none)", 0)
    ws.cell(row=r, column=1, value=f).font = BODY_BOLD
    ws.cell(row=r, column=2, value=len(counts))
    ws.cell(row=r, column=3, value=f'"{most[0]}" ({most[1]}×)')
    ws.cell(row=r, column=4, value=", ".join(f'"{l}" ({n}×)' for l, n in sorted_labels[1:]))
    for c in range(1, 5):
        ws.cell(row=r, column=c).font = BODY
        ws.cell(row=r, column=c).border = BORDER
        ws.cell(row=r, column=c).alignment = WRAP

ws.column_dimensions["A"].width = 28
ws.column_dimensions["B"].width = 18
ws.column_dimensions["C"].width = 32
ws.column_dimensions["D"].width = 80
ws.row_dimensions[r].height = None

ws.freeze_panes = "A2"

# ── Sheet 3: Divergent Matrix ─────────────────────────────────────────

ws = wb.create_sheet("Divergent Matrix")
ws["A1"] = "Divergent fields × buyers"
ws["A1"].font = H1

# Header rows: buyer name + DUNS
ws["A3"] = "Field"
ws["B3"] = "# buyers with field"
ws["C3"] = "# requiring it"
for j, b in enumerate(buyers):
    name_cell = ws.cell(row=2, column=4 + j, value=b["customerNames"][0])
    duns_cell = ws.cell(row=3, column=4 + j, value=b["duns"])
    name_cell.font = BODY_BOLD
    name_cell.alignment = Alignment(horizontal="center", vertical="bottom", wrap_text=True, text_rotation=60)
    duns_cell.font = SMALL_ITAL
    duns_cell.alignment = CENTER
    name_cell.fill = HEADER_FILL
    duns_cell.fill = HEADER_FILL
    name_cell.border = BORDER
    duns_cell.border = BORDER

for c in range(1, 4):
    ws.cell(row=3, column=c).font = BODY_BOLD
    ws.cell(row=3, column=c).fill = HEADER_FILL
    ws.cell(row=3, column=c).border = BORDER
    ws.cell(row=3, column=c).alignment = CENTER

ws.row_dimensions[2].height = 110
ws.row_dimensions[3].height = 18

# Data rows
for i, f in enumerate(divergent_fields):
    r = 4 + i
    cells = field_data[f]["cells"]
    labels = field_data[f]["labels"]
    has_count = sum(1 for c in cells if c != "-")
    req_count = sum(1 for c in cells if c == "R")

    ws.cell(row=r, column=1, value=f).font = BODY_BOLD
    ws.cell(row=r, column=1).border = BORDER
    ws.cell(row=r, column=2, value=has_count).font = BODY
    ws.cell(row=r, column=2).alignment = CENTER
    ws.cell(row=r, column=2).border = BORDER
    ws.cell(row=r, column=3, value=req_count).font = BODY
    ws.cell(row=r, column=3).alignment = CENTER
    ws.cell(row=r, column=3).border = BORDER

    for j, (cell, lbl) in enumerate(zip(cells, labels)):
        display = cell + ("*" if lbl else "")
        c = ws.cell(row=r, column=4 + j, value=display)
        c.font = BODY
        c.alignment = CENTER
        c.border = BORDER
        c.fill = CELL_FILLS.get(cell, MISS_FILL)
        if lbl:
            c.font = Font(name=FONT, size=10, bold=True)

ws.column_dimensions["A"].width = 28
ws.column_dimensions["B"].width = 16
ws.column_dimensions["C"].width = 14
for j in range(len(buyers)):
    ws.column_dimensions[get_column_letter(4 + j)].width = 6

ws.freeze_panes = "D4"

# ── Sheet 4: Field Labels ─────────────────────────────────────────────

ws = wb.create_sheet("Field Labels")
ws["A1"] = "Per-field label variants"
ws["A1"].font = H1

ws["A3"] = "API field"
ws["B3"] = "Distinct labels"
ws["C3"] = "Label"
ws["D3"] = "Buyer count"
ws["E3"] = "Buyers using this label"
for c in range(1, 6):
    ws.cell(row=3, column=c).font = BODY_BOLD
    ws.cell(row=3, column=c).fill = HEADER_FILL
    ws.cell(row=3, column=c).border = BORDER
    ws.cell(row=3, column=c).alignment = CENTER

r = 4
for f in divergent_fields:
    counts = {k: v for k, v in field_data[f]["label_counts"].items() if k != "(none)"}
    if not counts:
        continue
    sorted_labels = sorted(counts.items(), key=lambda x: -x[1])
    first_row = r
    for label, count in sorted_labels:
        # which buyers have this exact label
        users = [
            buyers[i]["customerNames"][0]
            for i, l in enumerate(field_data[f]["labels"])
            if (l or "(none)") == label
        ]
        ws.cell(row=r, column=1, value=f if r == first_row else "").font = BODY_BOLD
        ws.cell(row=r, column=2, value=len(sorted_labels) if r == first_row else "")
        ws.cell(row=r, column=3, value=label).font = BODY
        ws.cell(row=r, column=4, value=count).font = BODY
        ws.cell(row=r, column=5, value=", ".join(users)).font = BODY
        for c in range(1, 6):
            ws.cell(row=r, column=c).border = BORDER
            ws.cell(row=r, column=c).alignment = WRAP
        ws.cell(row=r, column=2).alignment = CENTER
        ws.cell(row=r, column=4).alignment = CENTER
        if r == first_row:
            ws.cell(row=r, column=1).fill = ALT_FILL
            ws.cell(row=r, column=2).fill = ALT_FILL
        r += 1

ws.column_dimensions["A"].width = 24
ws.column_dimensions["B"].width = 14
ws.column_dimensions["C"].width = 32
ws.column_dimensions["D"].width = 12
ws.column_dimensions["E"].width = 70
ws.freeze_panes = "A4"
ws.auto_filter.ref = f"A3:E{r-1}"

# ── Sheet 5: Per-Buyer Required ───────────────────────────────────────

ws = wb.create_sheet("Per-Buyer Required")
ws["A1"] = "Each buyer's required-field list (LEM)"
ws["A1"].font = H1

headers = ["Buyer", "DUNS", "# required", "Required fields"]
for j, h in enumerate(headers):
    c = ws.cell(row=3, column=1 + j, value=h)
    c.font = BODY_BOLD
    c.fill = HEADER_FILL
    c.border = BORDER
    c.alignment = CENTER

for i, b in enumerate(buyers):
    r = 4 + i
    required = []
    for f, spec in b["body"].items():
        if isinstance(spec, dict) and spec.get("requiredOn"):
            label = spec.get("customLabel")
            required.append(f'{f}{f" ({label})" if label and label != f else ""}')
    required.sort()
    ws.cell(row=r, column=1, value=b["customerNames"][0]).font = BODY_BOLD
    ws.cell(row=r, column=2, value=b["duns"]).font = BODY
    ws.cell(row=r, column=3, value=len(required)).font = BODY
    ws.cell(row=r, column=3).alignment = CENTER
    ws.cell(row=r, column=4, value=", ".join(required)).font = BODY
    ws.cell(row=r, column=4).alignment = WRAP
    for c in range(1, 5):
        ws.cell(row=r, column=c).border = BORDER
    if i % 2:
        for c in range(1, 5):
            ws.cell(row=r, column=c).fill = ALT_FILL
    ws.row_dimensions[r].height = 36

ws.column_dimensions["A"].width = 32
ws.column_dimensions["B"].width = 14
ws.column_dimensions["C"].width = 14
ws.column_dimensions["D"].width = 110
ws.freeze_panes = "A4"
ws.auto_filter.ref = f"A3:D{3 + len(buyers)}"

# ── Sheet 6: Buyer-Unique Fields ──────────────────────────────────────

ws = wb.create_sheet("Buyer-Unique Fields")
ws["A1"] = "Fields that only ONE buyer has"
ws["A1"].font = H1
ws["A2"] = (
    "These are buyer-specific carve-outs. If we don't bake them into the Sundog billing "
    "profile for that buyer, the field will not appear (or will not be required) when a tech "
    "files a ticket for them."
)
ws["A2"].font = SMALL_ITAL
ws["A2"].alignment = WRAP
ws.merge_cells("A2:E2")
ws.row_dimensions[2].height = 36

headers = ["API field", "Buyer", "DUNS", "Required?", "Custom label"]
for j, h in enumerate(headers):
    c = ws.cell(row=4, column=1 + j, value=h)
    c.font = BODY_BOLD
    c.fill = HEADER_FILL
    c.border = BORDER
    c.alignment = CENTER

r = 5
for f in unique_to_one:
    cells = field_data[f]["cells"]
    labels = field_data[f]["labels"]
    idx = next(i for i, c in enumerate(cells) if c != "-")
    b = buyers[idx]
    ws.cell(row=r, column=1, value=f).font = BODY_BOLD
    ws.cell(row=r, column=2, value=b["customerNames"][0]).font = BODY
    ws.cell(row=r, column=3, value=b["duns"]).font = BODY
    ws.cell(row=r, column=4, value="Yes" if cells[idx] == "R" else "No").font = BODY
    ws.cell(row=r, column=5, value=labels[idx] or "").font = BODY
    for c in range(1, 6):
        ws.cell(row=r, column=c).border = BORDER
        ws.cell(row=r, column=c).alignment = WRAP
    ws.cell(row=r, column=4).alignment = CENTER
    r += 1

ws.column_dimensions["A"].width = 28
ws.column_dimensions["B"].width = 32
ws.column_dimensions["C"].width = 14
ws.column_dimensions["D"].width = 12
ws.column_dimensions["E"].width = 32
ws.freeze_panes = "A5"

# ── Save ──────────────────────────────────────────────────────────────

OUT.parent.mkdir(parents=True, exist_ok=True)
wb.save(OUT)
print(f"wrote {OUT}")
print(f"sheets: {wb.sheetnames}")
