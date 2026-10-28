# 我的博客（Astro 静态博客）

一个可以立刻跑起来、也能直接部署上线的个人博客。Markdown 写作，构建产物是纯静态 HTML。

## 环境要求

**Node.js ≥ 22.23.4**（Astro 7 的硬性要求，`.nvmrc` 已写好）。

```bash
npm install
npm run dev      # http://localhost:4321
```

构建与本地预览生产版本：

```bash
npm run build    # 产物在 dist/
npm run preview  # 预览 dist/，默认 http://localhost:4321
```

## 项目结构

```
StaticPages/
├─ src/
│  ├─ posts/                   # 文章，一篇一个 .md 文件
│  ├─ lib/posts.ts             # 读取、排序、过滤草稿（全站唯一的数据来源）
│  ├─ layouts/BaseLayout.astro # 页面骨架（head、导航、页脚）
│  ├─ pages/
│  │  ├─ index.astro           # 首页文章列表
│  │  ├─ about.astro           # 关于页
│  │  ├─ posts/[slug].astro    # 文章详情
│  │  └─ rss.xml.js            # RSS 订阅
│  └─ styles/global.css        # 全站样式（自动跟随系统明暗主题）
├─ public/                     # favicon、robots.txt、图片等原样拷贝的文件
├─ astro.config.mjs            # 站点配置（域名、插件）
└─ package.json
```

## 写一篇新文章

在 `src/posts/` 下新建 `文件名.md`，文件名就是网址：`my-post.md` → `/posts/my-post/`。

```md
---
title: 文章标题
description: 一句话摘要，会显示在首页和搜索结果里
pubDate: 2026-10-28
tags: ['随笔']
draft: false
---

正文从这里开始，用 Markdown 写。
```

- `title`、`pubDate` 必填，其余可选
- `draft: true` 的文章不会出现在首页、文章页和 RSS 里
- 图片放 `public/images/`，正文里写 `![说明](/images/x.png)`
- 代码块自动高亮，表格、引用、列表都支持，写法见 `src/posts/markdown-guide.md`

## 为什么文章没用 Content Collections

文章通过 `import.meta.glob` 读取（见 `src/lib/posts.ts`），而不是 Astro 官方的 Content Collections。

原因：Astro 7.4.2 + yaml 2.9.1 目前在加载内容集合时会崩，报 `require is not defined`
（yaml 是 CJS 包，被 Vite 的模块运行器当成 ESM 求值）。已用最小项目复现，与本项目代码无关。
换成 `import.meta.glob` 后功能等价：列表、按日期排序、草稿过滤、RSS 都在 `posts.ts` 里实现了。

等上游修好后想迁回官方写法，改动只涉及 `src/lib/posts.ts`、`src/pages/index.astro`、
`src/pages/posts/[slug].astro` 和 `src/pages/rss.xml.js` 四个文件，其他内容不用动。

## 上线前要改的地方

| 文件 | 改什么 |
| --- | --- |
| `astro.config.mjs` | `site` 改成你的真实域名（影响 sitemap、canonical） |
| `src/layouts/BaseLayout.astro` | `siteName` 改成站点名 |
| `src/pages/index.astro` | 首页的自我介绍 |
| `src/pages/about.astro` | 关于页、联系方式 |
| `public/robots.txt` | 取消注释并填入真实 Sitemap 地址 |
| `public/favicon.svg` | 想换图标就替换它 |
| `src/posts/` | 删掉三篇示例文章，写自己的 |

## 部署到 Cloudflare Pages（免费，不需要备案）

1. **推到 GitHub**

   ```bash
   git init
   git add -A
   git commit -m "init blog"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```

2. **连接 Cloudflare**
   登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → `Workers & Pages` → `Create` → `Pages` → `Connect to Git` → 选刚才的仓库。

3. **构建配置**

   | 项 | 值 |
   | --- | --- |
   | Framework preset | `Astro` |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | 环境变量 | `NODE_VERSION` = `22.23.4` |

   > `NODE_VERSION` 一定要设，Cloudflare 默认的 Node 版本可能低于 Astro 7 要求的 22.23.4，
   > 不设会在构建阶段报 engines 不匹配。

   点 `Save and Deploy`，一两分钟后拿到 `xxx.pages.dev` 的临时地址。

4. **绑定自己的域名**
   `Custom domains` → `Set up a custom domain` → 输入域名。
   - 域名 DNS 托管在 Cloudflare 时：自动加记录，几分钟生效
   - 否则按提示去域名商处添加 `CNAME` 记录

5. **HTTPS**
   Cloudflare 自动签发证书，无需操作。域名生效后打开 `https://你的域名` 确认锁图标正常。

> 用 Vercel、Netlify 的流程几乎一样：连仓库、`npm run build`、产物 `dist`，同样记得指定 Node 22。

## 常见问题

- **`npm run dev` 报 `require is not defined`**
  这是 Vite 在某些环境下加载 CommonJS 依赖的问题，和文章内容无关。
  不影响构建和部署，本地预览可以改用 `npm run build && npm run preview`。

- **`npm install` 报 EPERM / 缓存权限错误**
  npm 默认缓存目录可能不可写，换成项目内缓存即可：`npm install --cache .npm-cache`
  （记得把 `.npm-cache` 加进 `.gitignore`）。

- **Cloudflare 构建失败，提示 engines 不匹配**
  没设 `NODE_VERSION`。在 Pages 的环境变量里加上 `NODE_VERSION=22.23.4`。

## 之后可以加的东西

- **访问统计**：Umami Cloud 或 Plausible，加一段 script 即可
- **评论**：giscus（基于 GitHub Discussions），适合静态站
- **图片优化**：用 Astro 的 `<Image>` 组件自动压缩、生成多尺寸
- **标签页 / 搜索**：文章多了再做，先别过度设计
- **SEO 提交**：上线后到 Google Search Console、必应站长、百度站长提交 `sitemap-index.xml`

## 如果必须国内快速访问

那就得用国内服务器（阿里云/腾讯云），并且走 **ICP 备案**：

- 域名需在境内注册商并完成实名认证
- 通过云服务商提交备案，个人备案约 1–20 个工作日
- 网站上线 30 日内做公安备案
- 备案通过后，把 `dist/` 上传到对象存储或云服务器，配好 CDN 和证书

项目本身不用改，只是换一个发布目标。
