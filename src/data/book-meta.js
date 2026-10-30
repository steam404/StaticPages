/**
 * 推荐的书的封面与豆瓣链接（自动生成，勿手改）
 *
 * 封面来自豆瓣，仅作展示；链接指向豆瓣读书书目页。
 * 生成脚本：crawl-book-covers.mjs
 */

export const BOOK_META = {
  "围城": { cover: "/books/00.jpg", douban: "https://book.douban.com/subject/11524204/", rating: 9.3 },
  "我们仨": { cover: "/books/01.jpg", douban: "https://book.douban.com/subject/1023045/", rating: 8.8 },
  "平凡的世界": { cover: "/books/02.jpg", douban: "https://book.douban.com/subject/10517238/", rating: 9 },
  "白鹿原": { cover: "/books/03.jpg", douban: "https://book.douban.com/subject/27047454/", rating: 9.2 },
  "百年孤独": { cover: "/books/04.jpg", douban: "https://book.douban.com/subject/6082808/", rating: 9.3 },
  "杀死一只知更鸟": { cover: "/books/05.jpg", douban: "https://book.douban.com/subject/26879778/", rating: 9.3 },
  "悉达多": { cover: "/books/06.jpg", douban: "https://book.douban.com/subject/26980487/", rating: null },
  "荒原狼": { cover: "/books/07.jpg", douban: "https://book.douban.com/subject/4908883/", rating: null },
  "月亮与六便士": { cover: "/books/08.jpg", douban: "https://book.douban.com/subject/26954760/", rating: null },
  "人性的枷锁": { cover: "/books/09.jpg", douban: "https://book.douban.com/subject/26803714/", rating: null },
  "局外人": { cover: "/books/10.jpg", douban: "https://book.douban.com/subject/4908885/", rating: null },
  "鼠疫": { cover: "/books/11.jpg", douban: "https://book.douban.com/subject/24257229/", rating: null },
  "飘": { cover: "/books/12.jpg", douban: "https://book.douban.com/subject/1068920/", rating: null },
  "霍乱时期的爱情": { cover: "/books/13.jpg", douban: "https://book.douban.com/subject/10594787/", rating: null },
  "安娜·卡列尼娜": { cover: "/books/14.jpg", douban: "https://book.douban.com/subject/2253380/", rating: null },
  "面纱": { cover: "/books/15.jpg", douban: "https://book.douban.com/subject/26757680/", rating: null },
  "房思琪的初恋乐园": { cover: "/books/16.jpg", douban: "https://book.douban.com/subject/27614904/", rating: null },
  "呼兰河传": { cover: "/books/17.jpg", douban: "https://book.douban.com/subject/34451656/", rating: null },
  "活着": { cover: "/books/18.jpg", douban: "https://book.douban.com/subject/4913064/", rating: null },
  "城南旧事": { cover: "/books/19.jpg", douban: "https://book.douban.com/subject/3057333/", rating: null },
  "四世同堂": { cover: "/books/20.jpg", douban: "https://book.douban.com/subject/3183775/", rating: null },
  "人间草木": { cover: "/books/21.jpg", douban: "https://book.douban.com/subject/1253310/", rating: null },
  "秋园": { cover: "/books/22.jpg", douban: "https://book.douban.com/subject/34998019/", rating: null },
  "撒哈拉的故事": { cover: "/books/23.jpg", douban: "https://book.douban.com/subject/1060068/", rating: null },
  "社会性动物": { cover: "/books/24.jpg", douban: "https://book.douban.com/subject/2328458/", rating: null },
  "人类简史": { cover: "/books/25.jpg", douban: "https://book.douban.com/subject/25985021/", rating: null },
  "动物农场": { cover: "/books/26.jpg", douban: "https://book.douban.com/subject/4908879/", rating: null },
  "1984": { cover: "/books/27.jpg", douban: "https://book.douban.com/subject/4820710/", rating: null },
  "沉默的大多数": { cover: "/books/28.jpg", douban: "https://book.douban.com/subject/27013716/", rating: null },
  "悲惨世界": { cover: "/books/29.jpg", douban: "https://book.douban.com/subject/25897657/", rating: null },
  "人生的智慧": { cover: "/books/30.jpg", douban: "https://book.douban.com/subject/3261600/", rating: null },
  "亲密关系": { cover: "/books/31.jpg", douban: "https://book.douban.com/subject/26585065/", rating: null },
};

export const bookMeta = title => BOOK_META[title] || { cover: '', douban: '', rating: null };
