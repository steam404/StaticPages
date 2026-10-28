import rss from '@astrojs/rss';
import { posts } from '../lib/posts';

export async function GET(context) {
  return rss({
    title: '我的博客',
    description: '记录学习、思考与折腾的地方。',
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: new Date(post.data.pubDate),
      description: post.data.description ?? '',
      link: post.url,
    })),
    customData: '<language>zh-cn</language>',
  });
}
