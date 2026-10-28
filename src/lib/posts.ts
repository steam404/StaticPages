/**
 * 文章数据来源。
 *
 * 文章是 src/posts/*.md，通过 Vite 的 import.meta.glob 在构建时读入，
 * 不依赖 Astro 的 Content Collections（这样 Astro 7 当前的加载 bug 也就绕开了）。
 */

export interface PostData {
  title: string;
  description?: string;
  pubDate: string | Date;
  tags?: string[];
  draft?: boolean;
}

export interface Post {
  slug: string;
  url: string;
  data: PostData;
  Content: any;
}

const modules = import.meta.glob('/src/posts/*.md', { eager: true }) as Record<
  string,
  { frontmatter: PostData; Content?: any; default?: any }
>;

export const posts: Post[] = Object.entries(modules)
  .map(([path, mod]) => {
    const slug = path.split('/').pop()!.replace(/\.md$/, '');
    return {
      slug,
      url: `/posts/${slug}/`,
      data: mod.frontmatter,
      Content: mod.Content ?? mod.default,
    };
  })
  .filter((post) => !post.data.draft)
  .sort((a, b) => new Date(b.data.pubDate).valueOf() - new Date(a.data.pubDate).valueOf());

/** 统一成 2026-10-28 这样的展示格式 */
export function formatDate(date: string | Date): string {
  return new Date(date).toISOString().slice(0, 10);
}
