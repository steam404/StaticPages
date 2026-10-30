"""生成 public/book-library.json（在线书库索引）。

数据来源：GitHub 仓库 hankinghu/literature-books。
该仓库超过 jsDelivr 的 50MB 限制，CDN 列表接口拿不到文件清单，
所以先用 codeload 下载整包 tar.gz（不解压），再从这里读目录。

用法：
    # 1. 下载整包（约 517 MB）
    curl -L -o lit-books.tar.gz \
      https://codeload.github.com/hankinghu/literature-books/tar.gz/refs/heads/master

    # 2. 生成索引
    python build-book-library.py lit-books.tar.gz

产物只有几十 KB，可以直接提交进仓库。
"""

import json
import sys
import tarfile
import urllib.parse
from pathlib import Path

TAR = sys.argv[1] if len(sys.argv) > 1 else "lit-books.tar.gz"
OUT = Path(__file__).parent / "public" / "book-library.json"
PREFIX = "literature-books-master/"

books = []
with tarfile.open(TAR, "r|gz") as tf:
    for m in tf:
        if not m.isfile():
            continue
        name = m.name
        if not name.startswith(PREFIX):
            continue
        rel = name[len(PREFIX):]
        if not rel.lower().endswith(".txt"):
            continue

        # 个别文件名是 URL 编码过的（%5B…），显示时解码
        display = urllib.parse.unquote(rel.split("/")[-1])
        title = display[:-4].strip()
        books.append({"title": title, "path": rel, "size": m.size})

books.sort(key=lambda b: b["title"])

OUT.write_text(
    json.dumps(
        {"count": len(books), "books": books},
        ensure_ascii=False,
        separators=(",", ":"),
    ),
    encoding="utf-8",
)

print(f"txt {len(books)} 本，合计 {sum(b['size'] for b in books) / 1024 / 1024:.1f} MB")
print(f"已写入 {OUT}（{OUT.stat().st_size / 1024:.1f} KB）")
