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

## 部署：Cloudflare Workers 静态资源

本站托管在 **Cloudflare Workers**（不是 Pages）：仓库连到 Cloudflare 的 Workers 构建，
每次 push 到 `main` 自动构建并部署。

| 项目 | 值 |
| --- | --- |
| 线上地址 | https://imyld.top（`www.imyld.top` 同样可访问） |
| 仓库 | https://github.com/steam404/StaticPages |
| Cloudflare 项目名 | `staticpages` |
| 构建命令 | `npm run build` |
| 部署命令 | `npx wrangler deploy` |
| 产物目录 | `dist`（由 `wrangler.jsonc` 的 `assets.directory` 指定） |

`wrangler.jsonc` 是关键文件，它告诉 Workers 把 `dist/` 当作静态资源发布；
没有它，`npx wrangler deploy` 会报「找不到入口」。

### 以后发文章

```bash
# 1. 在 src/posts/ 下新建 xxx.md（文件名即网址）
# 2. 本地预览（可选）
npm run build && npm run preview
# 3. 提交并推送，Cloudflare 自动部署
git add -A
git commit -m "post: 文章标题"
git push
```

推送后 1–3 分钟自动上线。构建日志和回滚都在 Cloudflare 的
`Workers & Pages → staticpages → 部署` 里。

### 换账号或换仓库时怎么重建

1. Cloudflare → `Workers & Pages` → 创建应用程序 → 连接 Git 仓库 → 选这个仓库
2. 项目名 `staticpages`，构建命令 `npm run build`，部署命令 `npx wrangler deploy`
3. 若构建报 `engines` 不匹配，在项目设置里加环境变量 `NODE_VERSION=22.23.4`
4. 部署成功后：设置 → 域和路由 → 添加自定义域 `imyld.top` 和 `www.imyld.top`

Cloudflare 会自动为根域名做 CNAME 展平并签发证书，不需要手动加 DNS 记录。

## 常见问题

- **`npm run dev` 报 `require is not defined`**
  这是 Vite 在某些环境下加载 CommonJS 依赖的问题，和文章内容无关。
  不影响构建和部署，本地预览可以改用 `npm run build && npm run preview`。

- **`npm install` 报 EPERM / 缓存权限错误**
  npm 默认缓存目录可能不可写，换成项目内缓存即可：`npm install --cache .npm-cache`
  （记得把 `.npm-cache` 加进 `.gitignore`）。

- **Cloudflare 构建失败，提示 engines 不匹配**
  没设 `NODE_VERSION`。在 Workers 项目的「设置 → 变量与机密」里加 `NODE_VERSION=22.23.4`。

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

## 养乐多在吃什么（`/eat/`）

一个纯前端的小应用，数据全部存在浏览器本地，不经过服务器。

- **今天**：按日期记录早/午/晚/加餐，选菜、加照片，自动汇总热量和蛋白/脂肪/碳水，按规则打分
- **菜谱库**：自己的常做菜，带照片、食材、做法；新建时按菜名自动带出营养估值
- **统计**：最近 7 天热量柱状图、最常吃的菜
- **设置**：每日热量目标、可选的 AI 估算接口地址

存储位置：菜谱和记录在 `localStorage`，照片在 IndexedDB。
换浏览器、清缓存都会丢，所以在「菜谱库 → 导出备份」定期存一份 JSON。

内置了约 70 道常见菜的营养数据（`src/data/dishes.js`），匹配不到时按「炸/红烧/汤/炒」等关键词估算，都会标注为「估算」。

### 接真正的 AI（可选）

设置里填一个接口地址，当内置表匹配不到时会 POST `{ "dish": "菜名" }`，期望返回：

```json
{ "kcal": 320, "p": 18, "f": 12, "c": 30, "comment": "偏油，建议配个青菜" }
```

留空就只用内置表，不联网。

## 多端同步（可选，需要在 Cloudflare 上开通 D1 + R2）

默认不启用：不配置时顶栏的「同步」按钮是灰点，所有数据仍然只存在本机。配置之后，同一个口令登录的设备共享同一份数据。

### 1. 创建资源

```powershell
# D1 数据库（存版本号与登录限流）
npx wrangler d1 create yakult-sync

# R2 存储桶（存快照、图片、书籍正文）
npx wrangler r2 bucket create yakult-blobs
```

`d1 create` 会输出 `database_id`。打开 `wrangler.jsonc`，把文件末尾那两块
（`d1_databases` 与 `r2_buckets`）的注释去掉，并把 `REPLACE_WITH_D1_DATABASE_ID`
换成实际 id。

这两块默认是注释状态——不配置时整站照常部署，只是顶栏「同步」显示为未启用。

### 2. 建表

```powershell
npx wrangler d1 execute yakult-sync --remote --file=./schema.sql
```

### 3. 设置两个密钥

```powershell
# 用你的口令生成哈希，把 你的口令 换掉后再执行
node -e "crypto.subtle.digest('SHA-256',new TextEncoder().encode('yakult-sync:你的口令')).then(b=>console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))"
npx wrangler secret put SYNC_PASSPHRASE_HASH

# 会话签名用的随机串
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put SYNC_SECRET
```

### 4. 部署与使用

推送后 Cloudflare 会带着绑定重新部署。之后：

- 点顶栏「同步」→ 输入口令 → 登录并同步
- 第一次登录时，如果云端为空，会把本机数据整包推上去；如果云端已有数据，会让你在「保留云端 / 用本地覆盖」之间选
- 之后每次改动会在 8 秒后自动推送；断网时排队，恢复后自动补
- 每台新设备登录一次即可看到全部数据（菜谱、菜单、书、照片、运势、设置）

### 同步了什么、没同步什么

| 同步 | 不���步 |
|---|---|
| 菜谱、菜单、设置、运势、新闻缓存 | **AI 的 `api_key`**（只留在本机，换设备需重填） |
| 做饭照片（R2） | 浏览器里的新闻/照片缓存不占本机以外的地方 |
| 书籍正文与阅读进度（R2） | — |

单次上传上限 25 MB，超过的书会被跳过并在同步结果里提示。

### 成本

D1 与 R2 都在免费额度内（个人用量远低于），月费 0。
