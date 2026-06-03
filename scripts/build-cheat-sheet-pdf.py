#!/usr/bin/env python3
"""Generate the BM Tracking Bot sales-team cheat sheet PDF."""

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Preformatted, KeepTogether
)
from reportlab.lib.enums import TA_LEFT

OUTPUT = "/Users/connorgreene/master-revenue-sheet-workflow/docs/bot-cheat-sheet.pdf"

# ── Style palette ────────────────────────────────────────────────────────────
BLACK   = HexColor("#1a1a1a")
GRAY    = HexColor("#555555")
ACCENT  = HexColor("#0066cc")
CODE_BG = HexColor("#f5f5f7")
RULE    = HexColor("#dadada")

styles = getSampleStyleSheet()

title_style = ParagraphStyle(
    "Title", parent=styles["Title"],
    fontName="Helvetica-Bold", fontSize=22, leading=26, textColor=BLACK,
    spaceAfter=4,
)
subtitle_style = ParagraphStyle(
    "Subtitle", parent=styles["Normal"],
    fontName="Helvetica", fontSize=10.5, leading=14, textColor=GRAY,
    spaceAfter=18,
)
section_style = ParagraphStyle(
    "Section", parent=styles["Heading2"],
    fontName="Helvetica-Bold", fontSize=12, leading=16, textColor=ACCENT,
    spaceBefore=12, spaceAfter=4,
)
body_style = ParagraphStyle(
    "Body", parent=styles["Normal"],
    fontName="Helvetica", fontSize=9.5, leading=13, textColor=BLACK,
    spaceAfter=4, alignment=TA_LEFT,
)
caption_style = ParagraphStyle(
    "Caption", parent=styles["Normal"],
    fontName="Helvetica-Oblique", fontSize=8.5, leading=11, textColor=GRAY,
    spaceAfter=8,
)
code_style = ParagraphStyle(
    "Code", parent=styles["Code"],
    fontName="Courier", fontSize=9, leading=12, textColor=BLACK,
    backColor=CODE_BG, borderColor=RULE, borderWidth=0.5, borderPadding=(6, 8, 6, 8),
    leftIndent=0, rightIndent=0, spaceAfter=8,
)


def code(text):
    return Preformatted(text, code_style)


def section(label):
    return Paragraph(label, section_style)


def body(text):
    return Paragraph(text, body_style)


def caption(text):
    return Paragraph(text, caption_style)


def build():
    doc = SimpleDocTemplate(
        OUTPUT, pagesize=LETTER,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.55 * inch, bottomMargin=0.55 * inch,
        title="BM Tracking Bot — Sales Team Cheat Sheet",
        author="Bolis Media",
    )
    story = []

    # ── Header ──────────────────────────────────────────────────────────────
    story.append(Paragraph("BM Tracking Bot — Cheat Sheet", title_style))
    story.append(Paragraph(
        "All <b>/update</b> commands are sent as a <b>reply to the brief</b> in "
        "<b>Internal Network Ads</b>. The bot updates the Master sheet, the per-page "
        "sheet, the DB, and the brief copy in each per-page IG Ads chat (within 48 h).",
        subtitle_style,
    ))

    # ── /update price ───────────────────────────────────────────────────────
    story.append(section("Edit a price"))
    story.append(code("/update price @hitsblunt $250"))
    story.append(body("Multiple pages, same price:"))
    story.append(code("/update price @hitsblunt @dailyhoodposts $200"))
    story.append(body("Different prices &mdash; one command per line:"))
    story.append(code(
        "/update price @hitsblunt $250\n"
        "/update price @dailyhoodposts $200\n"
        "/update price @zer $100"
    ))

    # ── /update name ────────────────────────────────────────────────────────
    story.append(section("Rename the campaign"))
    story.append(code("/update name New Campaign Name"))
    story.append(caption(
        "Replaces the campaign name in Master sheet, all per-page sheets, the DB, "
        "and every per-page brief copy in chat."
    ))

    # ── /update remove ──────────────────────────────────────────────────────
    story.append(section("Remove a page from a brief"))
    story.append(code("/update remove @oddlyhorrifying"))
    story.append(body("Multi-page:"))
    story.append(code("/update remove @page1 @page2"))
    story.append(caption(
        "Deletes the bot&#39;s forwarded brief in that page&#39;s chat, the Master "
        "sheet row, the per-page sheet row, and the DB row &mdash; and subtracts "
        "the page&#39;s price from the brief total."
    ))

    # ── /editbrief ──────────────────────────────────────────────────────────
    story.append(section("Manually edit one bot-sent message"))
    story.append(code(
        "/editbrief https://t.me/c/<id>/<msg_id>\n"
        "<new text on the next lines>"
    ))
    story.append(caption(
        "Get the link by right-clicking the bot&#39;s message in the per-page "
        "chat &rarr; Copy Link. Falls back to a two-message flow if pasting "
        "multi-line doesn&#39;t work in your client."
    ))

    # ── /mystatus + /ad ─────────────────────────────────────────────────────
    story.append(section("Check your submissions / submit a new ad"))
    story.append(body("DM <b>@bm_tracking_bot</b> (Greg):"))
    story.append(code(
        "/mystatus            — your last 10 submissions\n"
        "/mystatus <id>       — drill into one\n"
        "/ad                  — opens the wizard for a new submission"
    ))

    # ── Gotchas ─────────────────────────────────────────────────────────────
    story.append(section("Gotchas"))
    story.append(body(
        "&bull; <b>/update</b> must be a <b>reply</b> to the brief.<br/>"
        "&bull; Each <b>/update</b> line is an independent command &mdash; "
        "stack them in one message.<br/>"
        "&bull; Telegram only allows editing chat messages within <b>48 hours</b>. "
        "Sheet + DB updates still work past that; the chat copy stays as-is.<br/>"
        "&bull; <b>/update remove</b> is final &mdash; no undo.<br/>"
        "&bull; Bot prints a summary card with Master <b>N</b> &middot; Per-page "
        "<b>N</b> &middot; DB <b>N</b> &middot; Chat edits: <b>N</b>. If a count "
        "is <b>0</b> where you expected <b>1+</b>, ping Connor."
    ))

    # ── Footer ──────────────────────────────────────────────────────────────
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "<font color='#888888'>Questions? Ping @connor_bolismedia &middot; "
        "Bolis Media internal &middot; v1.0</font>",
        ParagraphStyle("Footer", parent=body_style, fontSize=8, textColor=GRAY,
                       alignment=TA_LEFT),
    ))

    doc.build(story)
    print(f"✅ Wrote {OUTPUT}")


if __name__ == "__main__":
    build()
