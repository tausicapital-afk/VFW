"""Markdown -> manual_body.html, the one input build_html.py reads.

Kept as a script rather than a remembered command line because the extension
set is not incidental: `tables` renders the permission grids the manual is
mostly made of, and `toc` is what stamps the heading ids that build_html.py's
hard-coded contents list links to. Convert without either and the PDF comes out
with the tables as literal pipes and every contents entry pointing at nothing.
"""
import markdown
import pathlib

SRC = pathlib.Path(__file__).resolve().parent.parent / 'user-manual.md'
OUT = pathlib.Path(__file__).resolve().parent / 'manual_body.html'

html = markdown.markdown(
    SRC.read_text(encoding='utf-8'),
    extensions=['extra', 'toc', 'sane_lists'],
)
OUT.write_text(html, encoding='utf-8')
print(f'{SRC.name} -> {OUT.name} ({len(html):,} bytes)')
