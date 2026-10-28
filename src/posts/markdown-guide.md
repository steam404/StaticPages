---
title: Markdown 速查：写文章用得到的语法
description: 这个博客支持的全部常用 Markdown 写法，附带示例。
pubDate: 2026-10-24
tags: ['写作', 'Markdown']
---

这篇文章既是速查表，也是渲染效果的测试页。所有写法都可以直接复制到新文章里用。

## 标题

用 `##` 到 `####`，`#` 留给文章标题（由 frontmatter 提供）。

## 强调

`**粗体**` 得到 **粗体**，`*斜体*` 得到 *斜体*，`~~删除线~~` 得到 ~~删除线~~。

## 列表

- 无序列表
- 支持嵌套
  - 第二层
- 就这样

1. 有序列表
2. 第二项
3. 第三项

## 引用

> 引用适合放别人的话，或者需要强调的结论。
>
> 也可以有多段。

## 代码

行内代码：`npm run dev`。

代码块（自动高亮，支持明暗主题）：

```js
const posts = await getCollection('posts', ({ data }) => !data.draft);
posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
console.log(`共 ${posts.length} 篇文章`);
```

```bash
npm install
npm run dev    # http://localhost:4321
npm run build  # 产物在 dist/
```

## 表格

| 方案 | 费用 | 备案 |
| --- | --- | --- |
| Cloudflare Pages | 免费 | 不需要 |
| 国内云服务器 | 约 100 元/年 | 需要 |

## 链接与图片

行内链接：[Astro 文档](https://docs.astro.build)。

图片放到 `public/` 下，然后：

```md
![图片说明](/images/example.png)
```

## 分隔线

---

上面就是全部常用语法了。更多细节看 [Markdown 指南](https://www.markdownguide.org/)。
