"""Bounded OTSL v1.0 table conversion for PaddleOCR-VL results.

The span semantics follow PaddleX's Apache-2.0 reference implementation at
commit ffb64904d23708863ff5b8da312a5cbd52a7f462.  This local implementation uses
only the Python standard library and emits both an escaped HTML representation
and explicit cells for the Team AI Box API.
"""

from __future__ import annotations

from dataclasses import dataclass
import html
import itertools
import re
from typing import Any


NL = "<nl>"
FCEL = "<fcel>"
ECEL = "<ecel>"
LCEL = "<lcel>"
UCEL = "<ucel>"
XCEL = "<xcel>"
CELL_TAGS = frozenset({FCEL, ECEL, LCEL, UCEL, XCEL})
ALL_TAGS = frozenset({*CELL_TAGS, NL})
TAG_PATTERN = re.compile(r"(<fcel>|<ecel>|<nl>|<lcel>|<ucel>|<xcel>)")
CELL_PATTERN = re.compile(
    r"(?:<fcel>|<ecel>|<lcel>|<ucel>|<xcel>).*?"
    r"(?=(?:<fcel>|<ecel>|<lcel>|<ucel>|<xcel>|<nl>)|$)",
    re.DOTALL,
)
MAX_TABLE_BYTES = 4 * 1024 * 1024
MAX_ROWS = 4_096
MAX_COLUMNS = 4_096
MAX_CELLS = 250_000


@dataclass(frozen=True)
class Cell:
    text: str
    row: int
    column: int
    row_span: int = 1
    column_span: int = 1


def _pad_rectangular(value: str) -> str:
    candidate = value.strip()
    if NL not in candidate:
        candidate += NL
    rows: list[dict[str, Any]] = []
    for line in candidate.split(NL):
        if not line:
            continue
        raw_cells = CELL_PATTERN.findall(line)
        if not raw_cells:
            continue
        minimum = max((index + 1 for index, cell in enumerate(raw_cells) if cell.startswith(FCEL)), default=0)
        rows.append({"cells": raw_cells, "length": len(raw_cells), "minimum": minimum})
    if not rows:
        raise ValueError("OTSL table contains no rows")
    minimum_width = max(row["minimum"] for row in rows)
    maximum_width = max(row["length"] for row in rows)
    width = min(
        range(minimum_width, max(minimum_width, maximum_width) + 1),
        key=lambda candidate_width: sum(abs(row["length"] - candidate_width) for row in rows),
    )
    if width < 1 or width > MAX_COLUMNS or len(rows) > MAX_ROWS or width * len(rows) > MAX_CELLS:
        raise ValueError("OTSL table dimensions exceed limits")
    repaired = []
    for row in rows:
        cells = row["cells"][:width]
        repaired.append("".join(cells + [ECEL] * (width - len(cells))))
    return NL.join(repaired) + NL


def _tokens_and_text(value: str) -> tuple[list[str], list[str]]:
    tokens = TAG_PATTERN.findall(value)
    mixed = [item for item in TAG_PATTERN.split(value) if item.strip()]
    if not tokens or any(item.startswith("<") and item not in ALL_TAGS for item in mixed):
        raise ValueError("OTSL table contains unsupported tags")
    return tokens, mixed


def _count_right(rows: list[list[str]], row: int, column: int) -> int:
    count = 0
    while column < len(rows[row]) and rows[row][column] in {LCEL, XCEL}:
        count += 1
        column += 1
    return count


def _count_down(rows: list[list[str]], row: int, column: int) -> int:
    count = 0
    while row < len(rows) and column < len(rows[row]) and rows[row][column] in {UCEL, XCEL}:
        count += 1
        row += 1
    return count


def _parse_cells(tokens: list[str], mixed: list[str]) -> tuple[list[Cell], list[list[str]]]:
    rows = [list(group) for is_separator, group in itertools.groupby(tokens, lambda item: item == NL) if not is_separator]
    if not rows:
        raise ValueError("OTSL table contains no cells")
    width = max(len(row) for row in rows)
    for row in rows:
        row.extend([ECEL] * (width - len(row)))

    # Match the reference converter: rebuild a normalized tag/text stream after
    # padding so cell content remains attached to its originating <fcel>.
    normalized: list[str] = []
    mixed_index = 0
    for row in rows:
        for token in row:
            normalized.append(token)
            if mixed_index < len(mixed) and mixed[mixed_index] == token:
                mixed_index += 1
                if mixed_index < len(mixed) and mixed[mixed_index] not in ALL_TAGS:
                    normalized.append(mixed[mixed_index])
                    mixed_index += 1
        normalized.append(NL)
        if mixed_index < len(mixed) and mixed[mixed_index] == NL:
            mixed_index += 1

    cells: list[Cell] = []
    row_index = column_index = 0
    for index, item in enumerate(normalized):
        if item in {FCEL, ECEL}:
            text = ""
            offset = 1
            if item == FCEL:
                if index + 1 >= len(normalized) or normalized[index + 1] in ALL_TAGS:
                    raise ValueError("OTSL full cell is missing content")
                text = normalized[index + 1].strip()
                offset = 2
            right = normalized[index + offset] if index + offset < len(normalized) else ""
            below = rows[row_index + 1][column_index] if row_index + 1 < len(rows) else ""
            column_span = 1 + (_count_right(rows, row_index, column_index + 1) if right in {LCEL, XCEL} else 0)
            row_span = 1 + (_count_down(rows, row_index + 1, column_index) if below in {UCEL, XCEL} else 0)
            cells.append(Cell(text=text, row=row_index, column=column_index, row_span=row_span, column_span=column_span))
        if item in CELL_TAGS:
            column_index += 1
        elif item == NL:
            row_index += 1
            column_index = 0
    return cells, rows


def convert_otsl(value: str) -> dict[str, Any]:
    if not isinstance(value, str) or not 1 <= len(value.encode("utf-8")) <= MAX_TABLE_BYTES:
        raise ValueError("OTSL table content is invalid")
    padded = _pad_rectangular(value)
    tokens, mixed = _tokens_and_text(padded)
    cells, rows = _parse_cells(tokens, mixed)
    if not cells or len(cells) > MAX_CELLS:
        raise ValueError("OTSL table contains an invalid cell count")
    starts = {(cell.row, cell.column): cell for cell in cells}
    body: list[str] = ["<table>"]
    for row_index in range(len(rows)):
        body.append("<tr>")
        for column_index in range(len(rows[row_index])):
            cell = starts.get((row_index, column_index))
            if cell is None:
                continue
            attributes = ""
            if cell.row_span > 1:
                attributes += f' rowspan="{cell.row_span}"'
            if cell.column_span > 1:
                attributes += f' colspan="{cell.column_span}"'
            body.append(f"<td{attributes}>{html.escape(cell.text.strip())}</td>")
        body.append("</tr>")
    body.append("</table>")
    return {
        "format": "otsl-v1.0",
        "rows": len(rows),
        "columns": max(len(row) for row in rows),
        "cells": [
            {"row": cell.row, "column": cell.column, "row_span": cell.row_span,
             "column_span": cell.column_span, "text": cell.text}
            for cell in cells
        ],
        "html": "".join(body),
    }
