/** APKVision development source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://apkvision.org';
const SEARCH_PATH = '/?s=';
const RECOMMENDED_TAB_ID = 'recommended';
const SEARCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  Referer: `${ORIGIN}/`,
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
};
const ACRONYMS = new Set(['apk', 'api', 'fps', 'gta', 'hd', 'mcpe', 'mod', 'nba', 'pe', 'psp', 'rpg', 'vr', 'xapk']);

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => ({
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
    })[entity.toLowerCase()]);
}

function cleanText(value) {
  return decodeHtml(String(value || '').replace(/\s+/g, ' ')).trim();
}

function textFromHtml(value) {
  return cleanText(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function attribute(tag, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag || '');
  return match ? decodeHtml(match[2]).trim() : '';
}

function absoluteUrl(url) {
  const value = cleanText(url);
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${ORIGIN}${value}`;
  return value;
}

function isApkVisionUrl(url) {
  return /^https:\/\/(?:[^/]+\.)?apkvision\.org\//i.test(url);
}

function humanize(value) {
  return String(value || '').split('-').filter(Boolean).map((word) => {
    const lower = word.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    return lower[0].toUpperCase() + lower.slice(1);
  }).join(' ');
}

function stripApkSuffix(title) {
  return cleanText(title)
    .replace(/\s+APK(?:\s*[+:-].*)?$/i, '')
    .replace(/\s+-\s+Download Free for Android.*$/i, '')
    .trim();
}

function extractVersion(value) {
  const match = /\bv?\d+(?:\.\d+)+(?:\s+[A-Za-z][\w-]*)?/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function categoryFromUrl(url) {
  const parts = url.replace(/^https:\/\/[^/]+\//i, '').split('/').filter(Boolean);
  return parts.length > 2 && /^(?:games|app|apps)$/i.test(parts[0])
    ? humanize(parts[parts.length - 2])
    : '';
}

function categoryIdFromAppUrl(url) {
  const match = /^https:\/\/apkvision\.org\/(games|app|apps)\/([^/?#]+)\/[^/?#]+\/?$/i.exec(url);
  return match ? `${ORIGIN}/${match[1].toLowerCase()}/${match[2]}/` : '';
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  const suffix = number > 1 ? `&paged=${number}` : '';
  return `${ORIGIN}${SEARCH_PATH}${encodeURIComponent(query)}${suffix}`;
}

function catalogPageUrl(tabId, page) {
  const number = Math.max(1, Number(page) || 1);
  const base = absoluteUrl(tabId).replace(/\/+$/, '');
  return number > 1 ? `${base}/page/${number}/` : `${base}/`;
}

function hasNextPage(html) {
  return /\brel\s*=\s*["']next["']/i.test(html || '') ||
    /\bclass\s*=\s*["'][^"']*\bnextpostslink\b/i.test(html || '');
}

async function fetchText(url) {
  return apkmesh.request(url, {headers: SEARCH_HEADERS});
}

function isNotFoundError(error) {
  const message = error && error.message ? error.message : String(error || '');
  return /\bHTTP\s+404\b/i.test(message) ||
    /\bstatus(?:\s+code)?\s*[:=]?\s*404\b/i.test(message);
}

async function fetchSearchText(url) {
  try {
    return await fetchText(url);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

let catalogHomeHtml = null;

function parseCardResults(html, anchorClass, titleClass, metadataClass) {
  const entries = [];
  const resultPattern = new RegExp(
    `<a\\b([^>]*\\bclass\\s*=\\s*["'][^"']*\\b${anchorClass}\\b[^"']*["'][^>]*)>([\\s\\S]*?)<\\/a>`,
    'gi',
  );
  const titlePattern = new RegExp(
    `<div\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${titleClass}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`,
    'i',
  );
  const metadataPattern = new RegExp(
    `<div\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${metadataClass}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`,
    'gi',
  );
  for (const match of html.matchAll(resultPattern)) {
    const openingTag = `<a${match[1]}>`;
    const id = absoluteUrl(attribute(openingTag, 'href'));
    if (!isApkVisionUrl(id)) continue;

    const block = match[2];
    const titleMatch = titlePattern.exec(block);
    const metadataValues = [...block.matchAll(metadataPattern)]
      .map((item) => textFromHtml(item[1]));
    const metadata = metadataValues.join(' ');
    const versionText = metadataValues.find((value) => /\bv?\d+(?:\.\d+)+/i.test(value)) || metadata;
    const imageMatch = /<img\b[^>]*>/i.exec(block);
    const name = stripApkSuffix(textFromHtml(titleMatch ? titleMatch[1] : ''));
    if (!name) continue;

    entries.push({
      id,
      name,
      packageName: '',
      version: extractVersion(versionText),
      size: '',
      updatedAt: '',
      category: categoryFromUrl(id),
      iconUrl: imageMatch ? imageUrl(imageMatch[0]) : '',
    });
  }
  return entries;
}

function imageUrl(imageTag) {
  for (const name of ['src', 'data-src', 'data-lazy-src', 'data-original']) {
    const value = attribute(imageTag, name);
    if (value) return absoluteUrl(value);
  }
  return '';
}

function parseSearchResults(html) {
  const newsEntries = parseCardResults(html, 'main-news', 'main-news-title', 'main-news-cat');
  const entries = newsEntries.length
    ? newsEntries
    : parseCardResults(html, 'mainb-item', 'mainb-title', 'mainb-cat');
  return entries.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.id === item.id) === index,
  );
}

function parseCategories(html) {
  const entries = [];
  const seen = new Set();
  const pattern = /<a\b([^>]*\bhref\s*=\s*["'][^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const openingTag = `<a${match[1]}>`;
    const id = categoryIdFromAppUrl(absoluteUrl(attribute(openingTag, 'href')));
    if (!id || seen.has(id)) continue;
    const parts = id.replace(/\/$/, '').split('/');
    const name = humanize(parts[parts.length - 1]);
    if (!name) continue;
    seen.add(id);
    entries.push({id, name, description: ''});
  }
  return entries.slice(0, 24);
}

function rowField(rows, label) {
  const expected = cleanText(label).toLowerCase();
  const row = rows.find((item) => cleanText(item.label).toLowerCase() === expected);
  return row ? cleanText(row.value) : '';
}

function extractSize(value) {
  const match = /^\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function downloadLabel(value) {
  return cleanText(value)
    .replace(/^Download\s+/i, '')
    .replace(/\s+\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b\s*$/i, '')
    .trim();
}

function isDirectDownload(url) {
  return /^https:\/\/dl\.apkvision\.org\//i.test(url);
}

async function resolveDownload(url) {
  if (isDirectDownload(url)) return url;
  if (!/^https:\/\/apkvision\.org\/[^?#]+\/download\//i.test(url)) return null;

  const html = await fetchText(url);
  const linkMatch = /<a\b[^>]*\bid\s*=\s*["']durl["'][^>]*>/i.exec(html);
  if (!linkMatch) return null;
  const direct = absoluteUrl(attribute(linkMatch[0], 'href'));
  return isDirectDownload(direct) ? direct : null;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}

async function reportDetailProgress(requestId, index, download, error) {
  if (!requestId) return;
  try {
    await apkmesh.detailProgress(requestId, {
      index,
      download: download || null,
      error: error ? String(error) : null,
    });
  } catch (_) {
    // Progress delivery must not abort link resolution.
  }
}

globalThis.source = {
  manifest: {
    id: 'apkvision-demo',
    name: 'APKVision',
    version: '1.2.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 APKVision 应用与游戏的搜索、目录、详情、截图和下载项。',
    permissions: {
      network: ['apkvision.org', '*.apkvision.org'],
      browser: true,
      download: true,
      install: true,
    },
    debugProjects: [
      {
        id: 'search-keyword',
        name: '搜索关键词',
        description: '调用源搜索接口，观察请求、状态码和返回内容。',
        inputLabel: '关键词',
        placeholder: '例如 minecraft',
        defaultInput: 'minecraft',
      },
      {
        id: 'app-details',
        name: '获取应用详情',
        description: '打开详情页并通过 WebView 读取应用信息和下载链接。',
        inputLabel: '应用详情 URL',
        placeholder: '粘贴源详情页 URL',
        defaultInput: 'https://apkvision.org/games/arcade/minecraft-pe-apk-55409/',
      },
    ],
  },

  async catalog() {
    const html = await fetchText(`${ORIGIN}/`);
    catalogHomeHtml = html;
    const tabs = [
      {id: RECOMMENDED_TAB_ID, name: '推荐', paged: false},
      {id: `${ORIGIN}/app/`, name: '应用', paged: true},
      {id: `${ORIGIN}/games/`, name: '游戏', paged: true},
      {id: `${ORIGIN}/updated/`, name: '最近更新', paged: true},
      {id: `${ORIGIN}/best-new-releases/`, name: '最佳新作', paged: true},
    ];
    const seen = new Set(tabs.map((tab) => tab.id));
    for (const category of parseCategories(html)) {
      if (seen.has(category.id)) continue;
      seen.add(category.id);
      tabs.push({...category, paged: true});
    }
    return {
      defaultTabId: RECOMMENDED_TAB_ID,
      tabs,
    };
  },

  async catalogPage(tabId, page = 1) {
    const number = Math.max(1, Number(page) || 1);
    if (tabId === RECOMMENDED_TAB_ID) {
      if (number > 1) return {apps: [], hasMore: false};
      const html = catalogHomeHtml || await fetchText(`${ORIGIN}/`);
      catalogHomeHtml = null;
      return {
        apps: parseSearchResults(html).slice(0, 12),
        hasMore: false,
      };
    }

    const id = absoluteUrl(tabId);
    if (!/^https:\/\/apkvision\.org\/(?:app|apps|games|updated|best-new-releases)(?:\/[^/?#]+)?\/?$/i.test(id)) {
      throw new TypeError('无效的目录标签地址');
    }
    const html = await fetchSearchText(catalogPageUrl(id, number));
    if (html === null) return {apps: [], hasMore: false};
    return {
      apps: parseSearchResults(html),
      hasMore: hasNextPage(html),
    };
  },

  async search(query, page = 1) {
    const normalized = cleanText(query);
    if (normalized.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    const html = await fetchSearchText(searchUrl(normalized, page));
    return html === null ? [] : parseSearchResults(html);
  },

  async detailsMetadata(url) {
    const id = absoluteUrl(url);
    if (!isApkVisionUrl(id)) throw new TypeError('无效的 APKVision 详情地址');
    const tab = await apkmesh.browser.open(id);
    try {
      await tab.waitFor('#MobileApplication');
      const app = await tab.query({
        id: 'link[rel="canonical"]@href',
        name: '.ver-top-h1 h1@text',
        version: '.ver-top-version@text',
        updatedAt: '.appinfo tr:nth-child(1) td@text',
        category: '.appinfo tr:nth-child(4) td@text',
        iconUrl: '.ver-top-l img@src',
        summary: 'meta[name="description"]@content',
        description: '.body-post > .b-content@text',
      });
      const infoRows = await tab.queryAll('.appinfo tr', {
        label: 'th@text',
        value: 'td@text',
      });
      app.id = absoluteUrl(app.id || url);
      app.name = stripApkSuffix(app.name || '');
      app.version = cleanText(app.version);
      app.updatedAt = rowField(infoRows, 'Updated') || cleanText(app.updatedAt);
      app.category = rowField(infoRows, 'Genre') || cleanText(app.category);
      app.iconUrl = absoluteUrl(app.iconUrl || '');
      app.summary = cleanText(app.summary);
      app.description = cleanText(app.description);
      app.packageName = rowField(infoRows, 'Package name');

      const screenshotNodes = await tab.queryAll('.app_screens_list img', {
        src: '@src',
        dataSrc: '@data-src',
        dataLazySrc: '@data-lazy-src',
        dataOriginal: '@data-original',
        srcset: '@srcset',
      });
      app.screenshots = screenshotNodes.map((item) => {
        const candidate = item.dataSrc || item.dataLazySrc || item.dataOriginal || item.src || item.srcset || '';
        return absoluteUrl(candidate.split(',')[0].trim().split(' ')[0]);
      }).filter(Boolean).filter((item, index, all) => all.indexOf(item) === index);

      const commentNodes = await tab.queryAll('.comment-content, .comment-body', {text: '@text'});
      app.comments = commentNodes.map((item) => cleanText(item.text)).filter(Boolean);

      const downloadNodes = await tab.queryAll('.b-dwn-spoiler__links a.fdl-btn', {
        label: '.fdl-btn-title > div@text',
        details: '.fdl-btn-title@text',
        url: '@href',
      });
      const candidates = downloadNodes.map((item) => {
        const rawLabel = cleanText(item.label);
        const details = cleanText(item.details);
        const sizeText = details.startsWith(rawLabel) ? details.slice(rawLabel.length) : '';
        return {
          label: downloadLabel(rawLabel),
          url: absoluteUrl(item.url),
          size: extractSize(sizeText),
        };
      }).filter((item) => item.label && isApkVisionUrl(item.url))
        .filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index)
        .slice(0, 20);
      app.downloadCandidates = candidates;
      return app;
    } finally {
      await tab.close();
    }
  },

  async resolveDownloads(candidates, requestId) {
    const resolved = await mapLimit(candidates || [], 4, async (item, index) => {
      try {
        const direct = await resolveDownload(item.url);
        const download = direct ? {...item, url: direct} : null;
        await reportDetailProgress(requestId, index, download, null);
        return download;
      } catch (error) {
        await reportDetailProgress(requestId, index, null, error);
        return null;
      }
    });
    return resolved.filter(Boolean).filter((item, index, all) =>
      all.findIndex((candidate) => candidate.url === item.url) === index,
    );
  },

  async details(url) {
    const app = await this.detailsMetadata(url);
    app.downloads = await this.resolveDownloads(app.downloadCandidates);
    delete app.downloadCandidates;
    return app;
  },

  async debug(projectId, input) {
    const value = cleanText(input);
    if (projectId === 'search-keyword') {
      const results = await this.search(value);
      return {
        title: '搜索完成',
        summary: `关键词“${value}”返回 ${results.length} 条结果`,
        data: results.map((item) => ({
          name: item.name,
          id: item.id,
          version: item.version,
          iconUrl: item.iconUrl,
        })),
      };
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {
        title: '详情读取完成',
        summary: `已读取 ${app.name} 的详情`,
        data: {
          name: app.name,
          packageName: app.packageName,
          version: app.version,
          updatedAt: app.updatedAt,
          downloads: (app.downloads || []).length,
        },
      };
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
