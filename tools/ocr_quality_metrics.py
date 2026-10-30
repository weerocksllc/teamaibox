#!/usr/bin/env python3
"""Deterministic OCR text, layout, reading-order, and PubTabNet-style TEDS metrics."""

from __future__ import annotations

from dataclasses import dataclass, field
from html.parser import HTMLParser
import re
import unicodedata
from typing import Any, Sequence


def levenshtein(first: Sequence[Any], second: Sequence[Any]) -> float:
    if len(first) < len(second):
        first, second = second, first
    previous = [float(index) for index in range(len(second) + 1)]
    for row, left in enumerate(first, 1):
        current = [float(row)]
        for column, right in enumerate(second, 1):
            current.append(min(current[-1] + 1, previous[column] + 1,
                               previous[column - 1] + (0 if left == right else 1)))
        previous = current
    return previous[-1]


def normalize_text(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", value)
    value = value.replace("```", " ")
    value = re.sub(r"[*_#`~]+", "", value)
    value = unicodedata.normalize("NFKC", value).casefold()
    value = re.sub(r"\s+", " ", value).strip()
    return value


def word_tokens(value: str) -> list[str]:
    normalized = normalize_text(value)
    return re.findall(r"[\u3400-\u9fff]|[a-z0-9]+(?:[-'][a-z0-9]+)*", normalized)


def text_error_counts(reference: str, prediction: str) -> dict[str, int]:
    reference_chars = list(normalize_text(reference))
    prediction_chars = list(normalize_text(prediction))
    reference_words = word_tokens(reference)
    prediction_words = word_tokens(prediction)
    return {
        "characterErrors": int(levenshtein(reference_chars, prediction_chars)),
        "referenceCharacters": len(reference_chars),
        "wordErrors": int(levenshtein(reference_words, prediction_words)),
        "referenceWords": len(reference_words),
    }


def bbox_iou(first: Sequence[float], second: Sequence[float]) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    first_area = max(0.0, first[2] - first[0]) * max(0.0, first[3] - first[1])
    second_area = max(0.0, second[2] - second[0]) * max(0.0, second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / union if union else 0.0


LABELS = {
    "text": "text", "paragraph_title": "text", "abstract": "text", "content": "text",
    "doc_title": "doc_title", "title": "doc_title", "table": "table",
    "display_formula": "display_formula", "inline_formula": "display_formula",
}


def layout_scores(reference: list[dict[str, Any]], prediction: list[dict[str, Any]],
                  threshold: float = 0.5) -> dict[str, Any]:
    expected_labels = {LABELS.get(item.get("label"), item.get("label")) for item in reference}
    predicted = []
    for index, item in enumerate(prediction):
        label = LABELS.get(item.get("block_label"), item.get("block_label"))
        bbox = item.get("block_bbox")
        if label in expected_labels and isinstance(bbox, list) and len(bbox) == 4:
            predicted.append({"index": index, "label": label, "bbox": [float(value) for value in bbox],
                              "order": float(item.get("reading_order", index))})
    candidates = []
    for expected_index, expected in enumerate(reference):
        expected_label = LABELS.get(expected.get("label"), expected.get("label"))
        for predicted_index, current in enumerate(predicted):
            if current["label"] == expected_label:
                overlap = bbox_iou(expected["bbox"], current["bbox"])
                if overlap >= threshold:
                    candidates.append((overlap, expected_index, predicted_index))
    matches = []
    used_expected, used_predicted = set(), set()
    for overlap, expected_index, predicted_index in sorted(candidates, reverse=True):
        if expected_index not in used_expected and predicted_index not in used_predicted:
            used_expected.add(expected_index)
            used_predicted.add(predicted_index)
            matches.append((expected_index, predicted_index, overlap))
    true_positive = len(matches)
    f1 = 2 * true_positive / (len(reference) + len(predicted)) if reference or predicted else 1.0
    ordered = sorted(matches)
    correct_pairs = 0
    total_pairs = len(ordered) * (len(ordered) - 1) // 2
    for left in range(len(ordered)):
        for right in range(left + 1, len(ordered)):
            left_prediction = predicted[ordered[left][1]]["order"]
            right_prediction = predicted[ordered[right][1]]["order"]
            correct_pairs += int(left_prediction < right_prediction)
    order_accuracy = correct_pairs / total_pairs if total_pairs else 0.0
    return {"f1": f1, "readingOrderAccuracy": order_accuracy, "expectedCount": len(reference),
            "predictedCount": len(predicted), "matchedCount": true_positive,
            "meanMatchedIou": (sum(item[2] for item in matches) / len(matches) if matches else 0.0),
            "correctOrderPairs": correct_pairs, "orderPairCount": total_pairs}


@dataclass
class TableNode:
    tag: str
    colspan: int = 1
    rowspan: int = 1
    content: list[str] = field(default_factory=list)
    children: list["TableNode"] = field(default_factory=list)


class TableParser(HTMLParser):
    ALLOWED = {"table", "thead", "tbody", "tfoot", "tr", "td", "th"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root: TableNode | None = None
        self.stack: list[TableNode] = []
        self.cell: TableNode | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self.cell is not None and tag not in {"td", "th"}:
            self.cell.content.append(f"<{tag}>")
        if tag not in self.ALLOWED:
            return
        attributes = dict(attrs)
        normalized = "td" if tag == "th" else tag
        node = TableNode(normalized, int(attributes.get("colspan") or 1), int(attributes.get("rowspan") or 1))
        if self.stack:
            self.stack[-1].children.append(node)
        elif normalized == "table" and self.root is None:
            self.root = node
        self.stack.append(node)
        if normalized == "td":
            self.cell = node

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        normalized = "td" if tag == "th" else tag
        if self.cell is not None and normalized != "td" and tag not in self.ALLOWED:
            self.cell.content.append(f"</{tag}>")
        if tag not in self.ALLOWED:
            return
        if self.stack and self.stack[-1].tag == normalized:
            closed = self.stack.pop()
            if closed is self.cell:
                self.cell = None

    def handle_data(self, data: str) -> None:
        if self.cell is not None:
            self.cell.content.extend(list(data))


def parse_table(value: str) -> TableNode | None:
    parser = TableParser()
    try:
        parser.feed(value)
        parser.close()
        return parser.root
    except (ValueError, TypeError):
        return None


def postorder(root: TableNode) -> tuple[list[TableNode | None], list[int], list[int]]:
    nodes: list[TableNode | None] = [None]
    leftmost: list[int] = [0]

    def visit(node: TableNode) -> int:
        child_leftmost = None
        for child in node.children:
            current = visit(child)
            if child_leftmost is None:
                child_leftmost = current
        nodes.append(node)
        index = len(nodes) - 1
        leftmost.append(child_leftmost if child_leftmost is not None else index)
        return leftmost[index]

    visit(root)
    last_for_leftmost: dict[int, int] = {}
    for index in range(1, len(nodes)):
        last_for_leftmost[leftmost[index]] = index
    return nodes, leftmost, sorted(last_for_leftmost.values())


def rename_cost(first: TableNode, second: TableNode, structure_only: bool) -> float:
    if first.tag != second.tag or first.colspan != second.colspan or first.rowspan != second.rowspan:
        return 1.0
    if first.tag == "td" and not structure_only and (first.content or second.content):
        maximum = max(len(first.content), len(second.content))
        return levenshtein(first.content, second.content) / maximum if maximum else 0.0
    return 0.0


def tree_edit_distance(first: TableNode, second: TableNode, structure_only: bool = False) -> float:
    nodes1, left1, keyroots1 = postorder(first)
    nodes2, left2, keyroots2 = postorder(second)
    distance = [[0.0] * len(nodes2) for _ in nodes1]
    for root1 in keyroots1:
        for root2 in keyroots2:
            left_root1, left_root2 = left1[root1], left2[root2]
            rows, columns = root1 - left_root1 + 2, root2 - left_root2 + 2
            forest = [[0.0] * columns for _ in range(rows)]
            for row in range(1, rows):
                forest[row][0] = forest[row - 1][0] + 1
            for column in range(1, columns):
                forest[0][column] = forest[0][column - 1] + 1
            for row in range(1, rows):
                node1 = left_root1 + row - 1
                for column in range(1, columns):
                    node2 = left_root2 + column - 1
                    delete = forest[row - 1][column] + 1
                    insert = forest[row][column - 1] + 1
                    if left1[node1] == left_root1 and left2[node2] == left_root2:
                        assert nodes1[node1] is not None and nodes2[node2] is not None
                        replace = forest[row - 1][column - 1] + rename_cost(
                            nodes1[node1], nodes2[node2], structure_only
                        )
                        forest[row][column] = min(delete, insert, replace)
                        distance[node1][node2] = forest[row][column]
                    else:
                        prefix_row = left1[node1] - left_root1
                        prefix_column = left2[node2] - left_root2
                        replace = forest[prefix_row][prefix_column] + distance[node1][node2]
                        forest[row][column] = min(delete, insert, replace)
    return distance[-1][-1]


def teds(reference_html: str, prediction_html: str, structure_only: bool = False) -> float:
    reference = parse_table(reference_html)
    prediction = parse_table(prediction_html)
    if reference is None or prediction is None:
        return 0.0
    reference_nodes = len(postorder(reference)[0]) - 1
    prediction_nodes = len(postorder(prediction)[0]) - 1
    maximum = max(reference_nodes - 1, prediction_nodes - 1, 1)  # PubTabNet excludes the table root.
    return max(0.0, 1.0 - tree_edit_distance(prediction, reference, structure_only) / maximum)
