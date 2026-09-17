#!/usr/bin/env python3
"""Renders public/UserGuide.md into public/UserGuide.html.

    pip install markdown
    python scripts/build-guide.py

The page shell - <head>, CSS and the <nav> frame - is the SHELL constant below;
the sidebar links come from the guide's own "Table of Contents" section, which is
therefore not repeated in the body. Output is written with CRLF, as the repo keeps it.
"""

import re
import sys
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
MD = ROOT / "public" / "UserGuide.md"
HTML = ROOT / "public" / "UserGuide.html"

SHELL = """\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DEXPI 1.4 / DISC Profile Viewer — User Guide</title>
<style>
:root{
  --bg:#ffffff; --fg:#1f2328; --muted:#57606a; --line:#d8dee4; --soft:#f6f8fa;
  --accent:#0969da; --code:#0a3069; --shadow:0 1px 3px rgba(31,35,40,.08);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.wrap{display:grid;grid-template-columns:260px minmax(0,1fr);gap:0;max-width:1240px;margin:0 auto}
nav{position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto;
  padding:26px 18px 40px;border-right:1px solid var(--line);font-size:13px}
nav .brand{font-weight:700;font-size:14px;margin-bottom:12px;line-height:1.35}
nav .brand span{display:block;font-weight:400;color:var(--muted);font-size:12px;margin-top:2px}
nav ul{list-style:none;margin:0;padding:0}
nav li{margin:0 0 2px}
nav a{display:block;padding:4px 8px;border-radius:5px;color:var(--muted);text-decoration:none}
nav a:hover{background:var(--soft);color:var(--accent)}
main{padding:30px 34px 90px;min-width:0}
h1{font-size:27px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:20px;margin:40px 0 10px;padding-top:14px;border-top:1px solid var(--line);letter-spacing:-.01em}
h3{font-size:16px;margin:26px 0 8px}
h4{font-size:14px;margin:20px 0 6px;color:var(--muted)}
p,li{max-width:80ch}
a{color:var(--accent)}
hr{display:none}
code{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px;
  background:var(--soft);color:var(--code);padding:1px 5px;border-radius:4px;white-space:nowrap}
pre{background:var(--soft);border:1px solid var(--line);border-radius:7px;padding:12px 14px;overflow:auto}
pre code{background:none;padding:0;white-space:pre;color:var(--fg)}
blockquote{margin:16px 0;padding:9px 14px;border-left:3px solid #d4a72c;background:#fff8e6;
  border-radius:0 6px 6px 0;color:#4d3800}
blockquote p{margin:0}
.tablewrap{overflow-x:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:13.5px;box-shadow:var(--shadow);border-radius:7px}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--soft);font-weight:600;white-space:nowrap}
tbody tr:nth-child(even){background:#fbfcfd}
td code{white-space:nowrap}
.toc{display:none}
footer{margin-top:60px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media (max-width:900px){
  .wrap{grid-template-columns:1fr}
  nav{position:static;max-height:none;border-right:none;border-bottom:1px solid var(--line)}
  main{padding:22px 16px 60px}
}
@media print{nav{display:none}.wrap{display:block}main{padding:0}}
</style>
</head>
<body>
<div class="wrap">
<nav>
  <div class="brand">DEXPI 1.4 / DISC Profile Viewer<span>User Guide</span></div>
<!--NAV-->
</nav>
<main>
<!--BODY-->
<footer>DEXPI 1.4 / DISC Profile Viewer — Tonia Pedersen. Generated from <code>UserGuide.md</code>.</footer>
</main>
</div>
</body>
</html>
"""


def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def slug(anchor):
    # "— " in a heading would otherwise leave a doubled dash in its id.
    return re.sub(r"-{2,}", "-", anchor)


def build(md_path=MD, html_path=HTML):
    src = md_path.read_text(encoding="utf-8")

    toc = re.search(r"^## Table of Contents\n(.*?)\n---\n", src, re.S | re.M)
    if not toc:
        sys.exit(f"{md_path}: no '## Table of Contents' section to build the nav from")
    items = re.findall(r"^(\d+)\.\s*\[(.+?)\]\((#.+?)\)", toc.group(1), re.M)
    body_md = src[:toc.start()] + src[toc.end() - len("---\n"):]

    body = markdown.markdown(body_md, extensions=["extra", "toc", "sane_lists"],
                             extension_configs={"toc": {"permalink": False}})
    body = re.sub(r'(id="|href="#)([^"]+)"', lambda m: m.group(1) + slug(m.group(2)) + '"', body)
    body = re.sub(r"<table>(.*?)</table>",
                  lambda m: '<div class="tablewrap"><table>' + m.group(1) + "</table></div>",
                  body, flags=re.S)

    nav = "\n".join(f'<li><a href="{slug(href)}">{n}. {esc(text)}</a></li>' for n, text, href in items)
    page = SHELL.replace("<!--NAV-->", "  <ul>" + nav + "</ul>").replace("<!--BODY-->", body)
    html_path.write_bytes(page.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8"))
    print(f"{html_path.relative_to(ROOT)}: {len(items)} sections, {len(page)} chars")


if __name__ == "__main__":
    build(*(Path(a) for a in sys.argv[1:3]))
