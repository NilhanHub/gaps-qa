import json
import sys
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile


def paragraph(text="", *, bold=False, size=None):
    properties = []
    if bold:
        properties.append("<w:b/>")
    if size:
        properties.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
    run_properties = f"<w:rPr>{''.join(properties)}</w:rPr>" if properties else ""
    safe_text = escape(str(text))
    return (
        "<w:p><w:r>"
        f"{run_properties}<w:t xml:space=\"preserve\">{safe_text}</w:t>"
        "</w:r></w:p>"
    )


def build_document_xml(payload):
    paragraphs = []
    paragraphs.append(paragraph("UI Element Writeups", bold=True, size=34))
    paragraphs.append(paragraph(f"App audited: {payload.get('appName', 'Unknown app')}"))
    paragraphs.append(paragraph(f"Environment audited: {payload.get('targetUrl', 'Unknown target')}"))
    paragraphs.append(paragraph(f"Audit mode: {payload.get('auditMode', 'Unknown mode')}"))
    paragraphs.append(paragraph(f"Verdict: {payload.get('verdict', 'UNVERIFIED')}"))
    paragraphs.append(paragraph(f"Readiness: {payload.get('readiness', 'UNVERIFIED')}"))
    paragraphs.append(paragraph())

    summary = payload.get("summary", {})
    paragraphs.append(paragraph("Run summary", bold=True, size=28))
    for title, key in [
        ("Top risks", "topRisks"),
        ("Workflow failures", "biggestWorkflowFailures"),
        ("UX friction", "biggestUxFrictionPoints"),
    ]:
        paragraphs.append(paragraph(title, bold=True))
        values = summary.get(key, [])
        if values:
            paragraphs.extend(paragraph(f"• {value}") for value in values)
        else:
            paragraphs.append(paragraph("None captured."))
    paragraphs.append(
        paragraph(summary.get("bluntBottomLine", "No blunt summary recorded."))
    )

    reviews = payload.get("uiElementReviews", [])
    paragraphs.append(paragraph("UI element results", bold=True, size=28))
    if not reviews:
        paragraphs.append(paragraph("No UI element reviews were captured for this run."))
    else:
        for review in reviews:
            paragraphs.append(
                paragraph(review.get("label", "Unnamed element"), bold=True, size=24)
            )
            paragraphs.append(paragraph(f"Surface: {review.get('surfaceId', 'Unknown surface')}"))
            paragraphs.append(paragraph(f"Element type: {review.get('elementType', 'Unknown type')}"))
            paragraphs.append(paragraph(f"Distinct state: {review.get('distinctState', 'Unknown state')}"))
            paragraphs.append(paragraph(f"Action attempted: {review.get('actionAttempted', 'Unknown action')}"))
            paragraphs.append(paragraph(f"Result: {review.get('result', 'UNVERIFIED')}"))
            paragraphs.append(paragraph(f"Terminal state: {review.get('terminalState', 'Unknown terminal state')}"))
            paragraphs.append(paragraph(review.get("humanSummary", "No human summary was captured.")))
            paragraphs.append(paragraph("Steps executed", bold=True))

            steps = review.get("stepsExecuted", [])
            if steps:
                paragraphs.extend(
                    paragraph(f"{index}. {step}")
                    for index, step in enumerate(steps, start=1)
                )
            else:
                paragraphs.append(paragraph("No executable steps were recorded."))

            findings = review.get("linkedFindingIds", [])
            paragraphs.append(
                paragraph(f"Linked findings: {', '.join(findings) if findings else 'None'}")
            )
            evidence = review.get("evidencePaths", [])
            paragraphs.append(
                paragraph(f"Evidence paths: {', '.join(evidence) if evidence else 'None'}")
            )

    body = "".join(paragraphs)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}"
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'
        "</w:sectPr></w:body></w:document>"
    )


def write_docx(output_path, document_xml):
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
    relationships = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output_path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", relationships)
        archive.writestr("word/document.xml", document_xml)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: generate_ui_element_writeups.py <input-json> <output-docx>")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    payload = json.loads(input_path.read_text(encoding="utf-8"))
    write_docx(output_path, build_document_xml(payload))


if __name__ == "__main__":
    main()
