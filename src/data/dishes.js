/**
 * 内置菜品营养表 + 关键词估算。
 *
 * 数据是「每份」的粗略值，用于个人记录，不用于医疗或减重决策。
 * kcal / p(蛋白质 g) / f(脂肪 g) / c(碳水 g)
 */

export const DISHES = [
  // 家常荤菜
  { name: '番茄炒蛋', aliases: ['西红柿炒鸡蛋', '番茄炒鸡蛋'], kcal: 180, p: 13, f: 11, c: 8, cat: '荤', tags: ['炒'] },
  { name: '青椒肉丝', kcal: 220, p: 18, f: 14, c: 6, cat: '荤', tags: ['炒'] },
  { name: '宫保鸡丁', kcal: 280, p: 22, f: 17, c: 10, cat: '荤', tags: ['炒'] },
  { name: '鱼香肉丝', kcal: 250, p: 17, f: 16, c: 12, cat: '荤', tags: ['炒'] },
  { name: '回锅肉', kcal: 380, p: 16, f: 32, c: 6, cat: '荤', tags: ['炒', '重油'] },
  { name: '红烧肉', kcal: 450, p: 15, f: 40, c: 8, cat: '荤', tags: ['红烧', '重油'] },
  { name: '糖醋排骨', kcal: 400, p: 20, f: 26, c: 22, cat: '荤', tags: ['油炸'] },
  { name: '清蒸鲈鱼', aliases: ['清蒸鱼'], kcal: 150, p: 24, f: 5, c: 1, cat: '荤', tags: ['清蒸'] },
  { name: '可乐鸡翅', kcal: 320, p: 22, f: 18, c: 18, cat: '荤', tags: ['红烧'] },
  { name: '白切鸡', kcal: 220, p: 26, f: 12, c: 0, cat: '荤', tags: ['清蒸'] },
  { name: '麻婆豆腐', kcal: 200, p: 14, f: 13, c: 7, cat: '荤', tags: ['炒'] },
  { name: '水煮鱼', kcal: 500, p: 30, f: 38, c: 6, cat: '荤', tags: ['重油'] },
  { name: '酸菜鱼', kcal: 400, p: 28, f: 28, c: 8, cat: '荤', tags: ['重油'] },
  { name: '咖喱鸡', kcal: 350, p: 24, f: 22, c: 14, cat: '荤', tags: ['炖'] },
  { name: '黄焖鸡', kcal: 400, p: 26, f: 26, c: 14, cat: '荤', tags: ['炖'] },
  { name: '清炒虾仁', kcal: 160, p: 20, f: 7, c: 3, cat: '荤', tags: ['炒'] },
  { name: '烤肉', kcal: 400, p: 28, f: 30, c: 4, cat: '荤', tags: ['烧烤'] },
  { name: '烤鸡腿', kcal: 320, p: 26, f: 22, c: 2, cat: '荤', tags: ['烧烤'] },

  // 素菜
  { name: '蒜蓉西兰花', aliases: ['西兰花'], kcal: 90, p: 5, f: 5, c: 7, cat: '素', tags: ['炒'] },
  { name: '清炒时蔬', aliases: ['炒青菜', '青菜'], kcal: 80, p: 2, f: 5, c: 6, cat: '素', tags: ['炒'] },
  { name: '地三鲜', kcal: 260, p: 4, f: 18, c: 20, cat: '素', tags: ['炒', '重油'] },
  { name: '干煸豆角', kcal: 180, p: 4, f: 13, c: 11, cat: '素', tags: ['炒', '重油'] },
  { name: '酸辣土豆丝', aliases: ['土豆丝'], kcal: 150, p: 2, f: 8, c: 18, cat: '素', tags: ['炒'] },
  { name: '凉拌黄瓜', kcal: 40, p: 1, f: 2, c: 4, cat: '素', tags: ['凉拌'] },
  { name: '凉拌木耳', kcal: 60, p: 2, f: 2, c: 8, cat: '素', tags: ['凉拌'] },
  { name: '蔬菜沙拉', aliases: ['沙拉'], kcal: 150, p: 5, f: 10, c: 10, cat: '素', tags: ['凉拌'] },

  // 汤
  { name: '西红柿鸡蛋汤', aliases: ['番茄蛋汤'], kcal: 80, p: 5, f: 4, c: 5, cat: '汤', tags: ['汤'] },
  { name: '紫菜蛋花汤', kcal: 50, p: 4, f: 2, c: 3, cat: '汤', tags: ['汤'] },
  { name: '冬瓜排骨汤', kcal: 180, p: 12, f: 12, c: 4, cat: '汤', tags: ['汤'] },
  { name: '玉米排骨汤', kcal: 200, p: 13, f: 12, c: 10, cat: '汤', tags: ['汤'] },
  { name: '鸡汤', kcal: 150, p: 12, f: 10, c: 1, cat: '汤', tags: ['汤'] },

  // 主食
  { name: '米饭', aliases: ['白米饭'], kcal: 230, p: 4, f: 1, c: 50, cat: '主食', tags: [] },
  { name: '杂粮饭', kcal: 200, p: 5, f: 1, c: 42, cat: '主食', tags: [] },
  { name: '面条', aliases: ['挂面'], kcal: 280, p: 9, f: 2, c: 56, cat: '主食', tags: [] },
  { name: '馒头', kcal: 220, p: 7, f: 1, c: 46, cat: '主食', tags: [] },
  { name: '包子', kcal: 250, p: 8, f: 8, c: 36, cat: '主食', tags: [] },
  { name: '饺子', aliases: ['水饺'], kcal: 300, p: 14, f: 10, c: 36, cat: '主食', tags: [] },
  { name: '煎饺', kcal: 350, p: 13, f: 18, c: 34, cat: '主食', tags: ['油炸'] },
  { name: '蛋炒饭', kcal: 450, p: 12, f: 16, c: 60, cat: '主食', tags: ['炒'] },
  { name: '白粥', aliases: ['粥', '稀饭'], kcal: 90, p: 2, f: 0, c: 20, cat: '主食', tags: [] },
  { name: '皮蛋瘦肉粥', kcal: 180, p: 9, f: 5, c: 24, cat: '主食', tags: [] },
  { name: '燕麦粥', kcal: 150, p: 5, f: 3, c: 26, cat: '主食', tags: [] },
  { name: '牛肉面', kcal: 550, p: 24, f: 16, c: 76, cat: '主食', tags: [] },
  { name: '兰州拉面', aliases: ['拉面'], kcal: 500, p: 20, f: 14, c: 74, cat: '主食', tags: [] },
  { name: '螺蛳粉', kcal: 500, p: 12, f: 22, c: 62, cat: '主食', tags: ['重油'] },
  { name: '酸辣粉', kcal: 450, p: 8, f: 18, c: 60, cat: '主食', tags: ['重油'] },
  { name: '三明治', kcal: 300, p: 12, f: 12, c: 34, cat: '主食', tags: [] },
  { name: '寿司', kcal: 300, p: 12, f: 4, c: 56, cat: '主食', tags: [] },

  // 快餐 / 外食
  { name: '汉堡', kcal: 550, p: 25, f: 30, c: 44, cat: '主食', tags: ['油炸'] },
  { name: '炸鸡', kcal: 500, p: 30, f: 32, c: 20, cat: '荤', tags: ['油炸'] },
  { name: '薯条', kcal: 300, p: 4, f: 15, c: 38, cat: '主食', tags: ['油炸'] },
  { name: '披萨', kcal: 300, p: 12, f: 12, c: 34, cat: '主食', tags: [] },
  { name: '麻辣烫', kcal: 500, p: 20, f: 28, c: 42, cat: '荤', tags: ['重油'] },
  { name: '火锅', kcal: 800, p: 40, f: 56, c: 30, cat: '荤', tags: ['重油'] },
  { name: '烧烤', aliases: ['撸串'], kcal: 600, p: 32, f: 44, c: 14, cat: '荤', tags: ['烧烤'] },
  { name: '卤肉饭', kcal: 600, p: 22, f: 26, c: 68, cat: '主食', tags: [] },

  // 蛋奶 / 加餐
  { name: '水煮蛋', aliases: ['鸡蛋', '煮鸡蛋'], kcal: 70, p: 6, f: 5, c: 1, cat: '荤', tags: [] },
  { name: '煎蛋', kcal: 90, p: 6, f: 7, c: 1, cat: '荤', tags: [] },
  { name: '牛奶', kcal: 130, p: 7, f: 7, c: 10, cat: '荤', tags: [] },
  { name: '豆浆', kcal: 80, p: 6, f: 4, c: 6, cat: '素', tags: [] },
  { name: '酸奶', kcal: 100, p: 5, f: 4, c: 12, cat: '素', tags: [] },
  { name: '奶茶', kcal: 400, p: 5, f: 16, c: 58, cat: '甜点', tags: ['甜'] },
  { name: '可乐', kcal: 140, p: 0, f: 0, c: 35, cat: '甜点', tags: ['甜'] },
  { name: '蛋糕', kcal: 350, p: 5, f: 18, c: 44, cat: '甜点', tags: ['甜'] },
  { name: '蛋挞', kcal: 200, p: 4, f: 12, c: 20, cat: '甜点', tags: ['甜'] },
  { name: '冰淇淋', kcal: 200, p: 3, f: 11, c: 24, cat: '甜点', tags: ['甜'] },
  { name: '水果', aliases: ['苹果', '香蕉'], kcal: 90, p: 1, f: 0, c: 22, cat: '素', tags: [] },
];

const KEYS = [
  { k: '炸', kcal: 450, p: 18, f: 30, c: 24, tags: ['油炸'] },
  { k: '红烧', kcal: 380, p: 18, f: 28, c: 12, tags: ['红烧'] },
  { k: '糖醋', kcal: 380, p: 16, f: 20, c: 32, tags: ['油炸'] },
  { k: '清蒸', kcal: 160, p: 22, f: 6, c: 2, tags: ['清蒸'] },
  { k: '白灼', kcal: 140, p: 20, f: 4, c: 2, tags: ['清蒸'] },
  { k: '汤', kcal: 120, p: 8, f: 6, c: 8, tags: ['汤'] },
  { k: '凉拌', kcal: 100, p: 3, f: 6, c: 8, tags: ['凉拌'] },
  { k: '炒', kcal: 260, p: 14, f: 18, c: 10, tags: ['炒'] },
  { k: '粥', kcal: 130, p: 4, f: 2, c: 24, tags: [] },
  { k: '面', kcal: 480, p: 18, f: 14, c: 68, tags: [] },
  { k: '饭', kcal: 450, p: 12, f: 14, c: 64, tags: [] },
  { k: '蛋糕', kcal: 350, p: 5, f: 18, c: 44, tags: ['甜'] },
  { k: '甜', kcal: 320, p: 4, f: 14, c: 44, tags: ['甜'] },
];

/** 从内置表里找菜；找不到就按关键词估。 */
export function estimateDish(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return null;

  const exact = DISHES.find(
    d => d.name === name || (d.aliases || []).includes(name),
  );
  if (exact) return { ...pick(exact), match: 'table', matched: exact.name };

  // 包含匹配：取最长的那个，避免「番茄炒蛋盖饭」命中「饭」
  const partial = DISHES.filter(d => name.includes(d.name) || d.name.includes(name)).sort(
    (a, b) => b.name.length - a.name.length,
  )[0];
  if (partial) return { ...pick(partial), match: 'table', matched: partial.name };

  const hit = KEYS.find(x => name.includes(x.k));
  if (hit) {
    return {
      kcal: hit.kcal,
      p: hit.p,
      f: hit.f,
      c: hit.c,
      cat: '荤',
      tags: hit.tags,
      match: 'guess',
      matched: `按「${hit.k}」估算`,
    };
  }

  return { kcal: 300, p: 12, f: 14, c: 26, cat: '荤', tags: [], match: 'default', matched: '默认估值' };
}

function pick(d) {
  return { kcal: d.kcal, p: d.p, f: d.f, c: d.c, cat: d.cat, tags: d.tags };
}

/** 搜索建议：按名字模糊匹配 */
export function suggest(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return DISHES.slice(0, limit);
  return DISHES.filter(d => d.name.includes(q) || (d.aliases || []).some(a => a.includes(q))).slice(0, limit);
}
