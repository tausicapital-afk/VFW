import json, re, datetime

with open('fonts_b64.json') as f:
    fonts = json.load(f)

with open('manual_body.html', encoding='utf-8') as f:
    body = f.read()

# Drop the auto h1 (we build our own cover instead of an inline h1)
body = re.sub(r'<h1[^>]*>.*?</h1>\s*', '', body, count=1, flags=re.S)

# Section grouping for page breaks: give every h2 a class for a hard page break,
# and wrap each h2+its following h3 block boundary isn't needed structurally —
# CSS break-before on h2 is enough since content is a flat sibling stream.

toc_items = [
    ("The five roles", "the-five-roles", 1),
    ("Work", "work", 0),
    ("Dashboard", "dashboard", 1),
    ("New submission", "new-submission", 1),
    ("Submissions", "submissions", 1),
    ("Contacts", "contacts", 1),
    ("Messages", "messages", 1),
    ("Emails", "emails", 1),
    ("Approval queue", "approval-queue", 1),
    ("QuickBooks", "quickbooks", 1),
    ("People", "people", 0),
    ("Attendance", "attendance", 1),
    ("Payroll", "payroll", 1),
    ("Leaderboard", "leaderboard", 1),
    ("Designer feedback", "designer-feedback", 1),
    ("Internal notes", "internal-notes", 1),
    ("Insight", "insight", 0),
    ("Reports", "reports", 1),
    ("Audit trail", "audit-trail", 1),
    ("System", "system", 0),
    ("Administration", "administration", 1),
    ("Logs", "logs", 1),
    ("Console", "console-reached-from-your-profile-menu-not-the-main-navigation", 0),
    ("Settings", "settings", 1),
    ("Account", "account", 1),
    ("Signing in and getting access", "signing-in-and-getting-access", 0),
    ("What you might see — known quirks", "what-you-might-see-known-quirks", 0),
]

toc_html_parts = []
for label, anchor, indent in toc_items:
    cls = "toc-sub" if indent else "toc-main"
    toc_html_parts.append(f'<li class="{cls}"><a href="#{anchor}">{label}</a></li>')
toc_html = "\n".join(toc_html_parts)

try:
    today = datetime.date.today().strftime("%B %d, %Y").replace(" 0", " ")
except Exception:
    today = ""

font_faces = f"""
@font-face {{
  font-family: 'Anton';
  src: url(data:font/ttf;base64,{fonts['anton']}) format('truetype');
  font-weight: 400; font-style: normal;
}}
@font-face {{
  font-family: 'Work Sans';
  src: url(data:font/ttf;base64,{fonts['ws400']}) format('truetype');
  font-weight: 400; font-style: normal;
}}
@font-face {{
  font-family: 'Work Sans';
  src: url(data:font/ttf;base64,{fonts['ws500']}) format('truetype');
  font-weight: 500; font-style: normal;
}}
@font-face {{
  font-family: 'Work Sans';
  src: url(data:font/ttf;base64,{fonts['ws600']}) format('truetype');
  font-weight: 600; font-style: normal;
}}
@font-face {{
  font-family: 'Work Sans';
  src: url(data:font/ttf;base64,{fonts['ws700']}) format('truetype');
  font-weight: 700; font-style: normal;
}}
@font-face {{
  font-family: 'Work Sans';
  src: url(data:font/ttf;base64,{fonts['ws800']}) format('truetype');
  font-weight: 800; font-style: normal;
}}
@font-face {{
  font-family: 'IBM Plex Mono';
  src: url(data:font/ttf;base64,{fonts['mono500']}) format('truetype');
  font-weight: 500; font-style: normal;
}}
"""

css = """
:root {
  --ink: #0a0a0a;
  --paper: #ffffff;
  --accent: #B1ECF6;
  --accent-deep: #4fb8ce;
  --rule: #1d1d1d;
  --muted: #55585c;
  --panel: #f4f5f5;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Work Sans', Arial, sans-serif;
  font-size: 10.6pt;
  line-height: 1.55;
  color: var(--ink);
  font-weight: 400;
}
h1, h2, h3, h4 {
  font-family: 'Anton', 'Work Sans', sans-serif;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.01em;
  color: var(--ink);
  margin: 0 0 10px;
}
h2 {
  font-size: 26pt;
  padding-bottom: 10px;
  border-bottom: 3px solid var(--ink);
  margin-top: 34px;
  margin-bottom: 22px;
  /* Deliberately NOT break-before:page. Forcing every section onto a fresh
     sheet leaves whatever's left of the previous page blank whenever a
     section doesn't end exactly on a page boundary — with 8 sections that's
     8 chances at a mostly-empty page. break-after:avoid instead just keeps
     the heading glued to the paragraph under it, so at worst it starts a
     couple lines lower on the current page rather than stranding alone at
     the bottom of one. */
  break-after: avoid;
  break-inside: avoid;
  position: relative;
}
h2:first-of-type { margin-top: 0; }
h2::after {
  content: "";
  display: block;
  width: 46px;
  height: 6px;
  background: var(--accent);
  margin-top: 6px;
}
h3 {
  font-size: 15.5pt;
  margin-top: 26px;
  margin-bottom: 10px;
  padding-top: 4px;
  border-top: 1px solid #ddd;
  break-after: avoid;
  break-inside: avoid;
}
h3:first-of-type { border-top: none; }
p { margin: 0 0 10px; }
strong { font-weight: 700; }
em { color: var(--muted); }
ul, ol { margin: 0 0 12px; padding-left: 20px; }
li { margin-bottom: 4px; }
a { color: #0a5b6b; text-decoration: none; }

table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0 18px;
  font-size: 9.3pt;
  break-inside: auto;
}
thead tr { background: var(--ink); }
thead th {
  color: #fff;
  text-align: left;
  padding: 7px 9px;
  font-family: 'Work Sans', sans-serif;
  font-weight: 700;
  font-size: 8.7pt;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  border-bottom: 3px solid var(--accent);
}
tbody td {
  padding: 6px 9px;
  border-bottom: 1px solid #e4e4e4;
  vertical-align: top;
}
tbody tr:nth-child(even) { background: var(--panel); }
tr { break-inside: avoid; }

code {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 8.8pt;
  background: var(--panel);
  padding: 1px 5px;
  border-radius: 2px;
}
pre {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 8.6pt;
  background: var(--panel);
  border-left: 3px solid var(--accent-deep);
  padding: 10px 12px;
  margin: 10px 0 16px;
  white-space: pre-wrap;
  break-inside: avoid;
  line-height: 1.5;
}
pre code { background: none; padding: 0; }

blockquote {
  margin: 10px 0 16px;
  padding: 8px 14px;
  border-left: 3px solid var(--ink);
  background: var(--panel);
  color: var(--muted);
  break-inside: avoid;
}

hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
/* Every h2 already forces its own page break (see h2 break-before above), so
   a divider hr placed right before one never has anything to separate — it
   only ever renders as an orphan line on its own near-blank page. */
hr:has(+ h2) { display: none; }

.wrap { padding: 6px 4px 40px; }

/* ---- Cover page ---- */
.cover {
  height: 297mm;
  background: var(--ink);
  color: #fff;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 26mm 22mm;
  break-after: page;
}
.cover-eyebrow {
  font-family: 'Work Sans', sans-serif;
  font-size: 10.5pt;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 600;
}
.cover-mark {
  width: 64px;
  height: 64px;
  border: 2.5px solid #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Anton', sans-serif;
  font-size: 15pt;
  letter-spacing: 0.03em;
  margin-bottom: 30px;
}
.cover-title {
  font-family: 'Anton', sans-serif;
  font-size: 58pt;
  line-height: 0.98;
  text-transform: uppercase;
  margin: 0;
  color: #fff;
}
.cover-title span { color: var(--accent); }
.cover-sub {
  font-family: 'Work Sans', sans-serif;
  font-weight: 500;
  font-size: 13pt;
  letter-spacing: 0.03em;
  margin-top: 14px;
  color: #d8d8d8;
}
.cover-rule {
  width: 100%;
  height: 3px;
  background: var(--accent);
  margin: 22px 0;
}
.cover-foot {
  display: flex;
  justify-content: space-between;
  font-family: 'Work Sans', sans-serif;
  font-size: 9.5pt;
  color: #9a9a9a;
  letter-spacing: 0.02em;
  border-top: 1px solid #333;
  padding-top: 14px;
}
.cover-foot b { color: #fff; }

/* ---- TOC page ---- */
.toc-page {
  padding: 10mm 22mm 6mm;
  break-after: page;
}
.toc-list { list-style: none; margin: 0; padding: 0; column-count: 1; }
.toc-main {
  font-family: 'Anton', sans-serif;
  font-size: 12.5pt;
  text-transform: uppercase;
  margin-top: 6px;
  padding-bottom: 3px;
  border-bottom: 1px solid #ccc;
}
.toc-main a { color: var(--ink); }
.toc-sub {
  font-family: 'Work Sans', sans-serif;
  font-size: 10pt;
  padding: 2px 0 2px 16px;
  color: #333;
}
.toc-sub a { color: #333; }
.toc-sub a::before { content: "— "; color: var(--accent-deep); }

/* ---- Role callout at top ---- */
.roles-note {
  background: var(--panel);
  border-left: 3px solid var(--accent-deep);
  padding: 10px 14px;
  margin-bottom: 16px;
  font-size: 9.8pt;
}
"""

toc_page = f"""
<section class="toc-page">
  <h2 style="break-before:auto;">Contents</h2>
  <ul class="toc-list">
    {toc_html}
  </ul>
</section>
"""

cover = f"""
<section class="cover">
  <div>
    <div class="cover-mark">VFW</div>
    <div class="cover-eyebrow">Vancouver Fashion Week</div>
  </div>
  <div>
    <h1 class="cover-title">VFW<br>Console<span>.</span></h1>
    <div class="cover-rule"></div>
    <div class="cover-sub">User Manual — how each role uses every module</div>
  </div>
  <div class="cover-foot">
    <div>For Sales, Intern, Accounting,<br>Sales Manager &amp; Administrator roles</div>
    <div style="text-align:right;"><b>Internal document</b><br>{today}</div>
  </div>
</section>
"""

cover_toc_html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>VFW Console — User Manual — Cover</title>
<style>
{font_faces}
{css}
@page {{ margin: 0; size: A4; }}
</style>
</head>
<body>
{cover}
{toc_page}
</body>
</html>
"""

content_html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>VFW Console — User Manual</title>
<style>
{font_faces}
{css}
</style>
</head>
<body>
<div class="wrap">
{body}
</div>
</body>
</html>
"""

with open('cover-toc.html', 'w', encoding='utf-8') as f:
    f.write(cover_toc_html)
with open('content.html', 'w', encoding='utf-8') as f:
    f.write(content_html)

print("Written cover-toc.html —", len(cover_toc_html), "chars")
print("Written content.html —", len(content_html), "chars")
