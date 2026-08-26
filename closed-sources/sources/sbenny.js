/** Sbenny public-page source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://sbenny.com';
const PAGE_SIZE = 24;
const CATALOG_TABS = [
  {id: `${ORIGIN}/`, name: '最近更新', paged: true},
  {id: `${ORIGIN}/games.html`, name: '游戏', paged: true},
  {id: `${ORIGIN}/apps.html`, name: '应用', paged: true},
  {id: `${ORIGIN}/games/action.html`, name: '动作', paged: true},
  {id: `${ORIGIN}/games/adventure.html`, name: '冒险', paged: true},
  {id: `${ORIGIN}/games/puzzle.html`, name: '益智', paged: true},
  {id: `${ORIGIN}/games/role-playing-games.html`, name: '角色扮演', paged: true},
  {id: `${ORIGIN}/games/simulation.html`, name: '模拟', paged: true},
  {id: `${ORIGIN}/games/strategy.html`, name: '策略', paged: true},
  {id: `${ORIGIN}/apps/communication.html`, name: '通讯', paged: true},
  {id: `${ORIGIN}/apps/education.html`, name: '教育', paged: true},
  {id: `${ORIGIN}/apps/entertainment.html`, name: '娱乐', paged: true},
  {id: `${ORIGIN}/apps/photography.html`, name: '摄影', paged: true},
  {id: `${ORIGIN}/apps/tools.html`, name: '工具', paged: true},
];

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(value, baseUrl = ORIGIN) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  const originMatch = /^https?:\/\/[^/]+/i.exec(baseUrl);
  const origin = originMatch ? originMatch[0] : ORIGIN;
  if (url.startsWith('/')) return `${origin}${url}`;
  if (/^(?:apps|games|media|images|component)\//i.test(url)) return `${ORIGIN}/${url}`;
  const directory = baseUrl.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
  return `${directory}${url}`;
}

function firstValue(...values) {
  return values.map(cleanText).find(Boolean) || '';
}

function stripTitle(value) {
  return cleanText(value)
    .replace(/^Download\s+/i, '')
    .replace(/\s+(?:MOD(?:DED)?\s+)?APK(?:\s+Android)?\s*$/i, '')
    .trim();
}

function extractVersion(value) {
  const match = /(?:Last Updated Version\s*:\s*)?v?(\d+(?:\.\d+)+(?:[\w.-]+)?)/i.exec(cleanText(value));
  return match ? match[1] : '';
}

function extractPackage(value) {
  return cleanText(value).replace(/^APK ID\s*:\s*/i, '').trim();
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function imageValue(item, baseUrl) {
  return absoluteUrl(firstValue(
    item.dataSrc,
    item.dataLazySrc,
    item.dataOriginal,
    item.src,
  ), baseUrl);
}

function uniqueBy(items, field) {
  return items.filter((item, index, all) =>
    item && item[field] && all.findIndex((candidate) => candidate[field] === item[field]) === index,
  );
}

function isSourceUrl(url) {
  return /^https:\/\/(?:[a-z0-9-]+\.)?sbenny\.com(?:\/|$)/i.test(cleanText(url));
}

function isAppUrl(url) {
  return /^https:\/\/(?:www\.)?sbenny\.com\/(?:games|apps)\/[^/?#]+\/[^/?#]+\.html(?:[?#].*)?$/i.test(cleanText(url));
}

function isCatalogUrl(url) {
  return CATALOG_TABS.some((tab) => tab.id === url);
}

function isDirectFile(url) {
  return /^https?:\/\//i.test(url) && /\.(?:apk|xapk|apks|zip)(?:[?#]|$)/i.test(url);
}

function isDownloadCandidate(url) {
  return /^https:\/\/short\.sbenny\.com\//i.test(url) ||
    (isSourceUrl(url) && /(?:download|attachment)/i.test(url));
}

function pageUrl(baseUrl, page) {
  const number = Math.max(1, Number(page) || 1);
  if (number === 1) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}limit=${PAGE_SIZE}&start=${(number - 1) * PAGE_SIZE}`;
}

function searchUrl(query, page) {
  const base = `${ORIGIN}/component/jak2filter/?theme=jak2&isc=1&st=exact&ordering=modified&searchword=${encodeURIComponent(query)}`;
  return pageUrl(base, page);
}

function isChallenge(page) {
  const text = `${cleanText(page && page.title)} ${cleanText(page && page.body)}`;
  return /just a moment|security verification|enable javascript and cookies to continue|checking your browser/i.test(text);
}

function assertPublicPage(page) {
  if (isChallenge(page)) {
    throw new Error('Sbenny is protected by a Cloudflare verification page');
  }
  if (/\b(?:404|page not found|not found)\b/i.test(cleanText(page && page.title))) return false;
  return true;
}

async function readPage(tab, readySelector) {
  const initial = await tab.query({title: 'title@text', body: 'body@text'});
  if (isChallenge(initial)) return {...initial, canonical: '', next: ''};
  try {
    await tab.waitFor(readySelector);
  } catch (_) {
    // Query the current DOM so callers receive a specific challenge or empty-page error.
  }
  return tab.query({
    title: 'title@text',
    body: 'body@text',
    canonical: 'link[rel="canonical"]@href',
    next: 'ul.pagination a[title="Next"]@href',
  });
}

async function loadListing(url) {
  const tab = await apkmesh.browser.open(url);
  try {
    const page = await readPage(tab, '.catItemView');
    if (!assertPublicPage(page)) return {apps: [], hasMore: false};
    const rows = await tab.queryAll('.catItemView', {
      url: '.catItemTitle a@href',
      name: '.catItemTitle@text',
      category: '.catItemCategory a@text',
      updatedAt: '.catItemDateModified@text',
      iconSrc: '.catItemImage img@src',
      iconDataSrc: '.catItemImage img@data-src',
      iconDataLazySrc: '.catItemImage img@data-lazy-src',
      iconDataOriginal: '.catItemImage img@data-original',
      metadata: '.catItemBody@text',
    });
    const apps = rows.map((row) => {
      const id = absoluteUrl(row.url, url).replace(/#.*$/, '');
      const name = stripTitle(row.name);
      if (!isAppUrl(id) || !name) return null;
      return {
        id,
        name,
        packageName: '',
        version: '',
        size: extractSize(row.metadata),
        updatedAt: cleanText(row.updatedAt).replace(/^Updated on\s*/i, ''),
        category: cleanText(row.category),
        iconUrl: imageValue({
          src: row.iconSrc,
          dataSrc: row.iconDataSrc,
          dataLazySrc: row.iconDataLazySrc,
          dataOriginal: row.iconDataOriginal,
        }, url),
      };
    }).filter(Boolean);
    return {apps: uniqueBy(apps, 'id'), hasMore: Boolean(page.next)};
  } finally {
    await tab.close();
  }
}

function downloadFromLink(link, referer, fallbackLabel) {
  const url = absoluteUrl(link.url, referer);
  if (!isDirectFile(url)) return null;
  return {
    label: cleanText(link.text) || fallbackLabel || 'APK',
    url,
    size: extractSize(link.text),
    headers: {Referer: referer},
  };
}

async function resolveCandidate(candidate) {
  if (isDirectFile(candidate.url)) return [{...candidate, headers: {Referer: candidate.referer || ORIGIN}}];
  const tab = await apkmesh.browser.open(candidate.url);
  try {
    const page = await readPage(tab, 'body');
    assertPublicPage(page);
    const links = await tab.queryAll('a[href]', {url: '@href', text: '@text'});
    const downloads = uniqueBy(links.map((link) =>
      downloadFromLink(link, candidate.url, candidate.label),
    ).filter(Boolean), 'url');
    if (downloads.length) return downloads;
    const text = cleanText(page.body);
    if (/\b(?:log in|login|register)\b/i.test(text)) {
      throw new Error('Sbenny download requires a forum account; APK Mesh does not collect account credentials');
    }
    throw new Error(`Sbenny download page did not expose a public APK link: ${candidate.url}`);
  } finally {
    await tab.close();
  }
}

async function reportProgress(requestId, index, downloads, error) {
  if (!requestId) return;
  try {
    await apkmesh.detailProgress(requestId, {
      index,
      downloads: downloads || [],
      error: error ? String(error) : null,
    });
  } catch (_) {
    // Progress reporting must not hide the actual resolver result.
  }
}

globalThis.source = {
  manifest: {
    id: 'sbenny',
    name: 'Sbenny',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '通过受隔离的浏览器读取 Sbenny 公开目录、搜索、详情和匿名可用下载项；不处理论坛账号登录。',
    permissions: {
      network: ['sbenny.com', '*.sbenny.com', 'challenges.cloudflare.com', '*.challenges.cloudflare.com'],
      browser: true,
      download: true,
      install: false,
    },
    debugProjects: [
      {
        id: 'search-keyword',
        name: '搜索关键词',
        description: '在 Sbenny 公开搜索页检查应用和游戏结果。',
        inputLabel: '关键词',
        placeholder: '例如 bubble shoot',
        defaultInput: 'bubble shoot',
      },
      {
        id: 'app-details',
        name: '获取应用详情',
        description: '读取 Sbenny 详情页元数据、截图和公开下载入口。',
        inputLabel: '应用详情 URL',
        placeholder: '粘贴 Sbenny 应用或游戏详情 URL',
        defaultInput: 'https://sbenny.com/games/puzzle/bubble-shoot.html',
      },
    ],
  },

  async catalog() {
    return {defaultTabId: `${ORIGIN}/`, tabs: CATALOG_TABS};
  },

  async catalogPage(tabId, page = 1) {
    if (!isCatalogUrl(tabId)) throw new TypeError('无效的 Sbenny 目录标签');
    const result = await loadListing(pageUrl(tabId, page));
    return {apps: result.apps, hasMore: result.hasMore};
  },

  async search(query, page = 1) {
    const value = cleanText(query);
    if (value.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    return (await loadListing(searchUrl(value, page))).apps;
  },

  async detailsMetadata(value) {
    const url = absoluteUrl(value);
    if (!isAppUrl(url)) throw new TypeError('无效的 Sbenny 详情地址');
    const tab = await apkmesh.browser.open(url);
    try {
      const page = await readPage(tab, '#k2Container.itemView');
      if (!assertPublicPage(page)) throw new Error('Sbenny detail page was not found');
      const fields = await tab.query({
        id: 'link[rel="canonical"]@href',
        name: 'h1.itemTitle@text',
        packageName: '.itemFullText .apkid@text',
        version: '.itemFullText .apkver@text',
        updatedAt: '.itemContentFooter time[itemprop="dateModified"]@datetime',
        category: '.EXitemCategory a@text',
        iconUrl: 'meta[property="og:image"]@content',
        summary: 'meta[name="description"]@content',
        description: '.itemFullText@text',
      });
      const screenshots = await tab.queryAll('.itemIntroText img.appic, .itemFullText img.appic', {
        src: '@src',
        dataSrc: '@data-src',
        dataLazySrc: '@data-lazy-src',
        dataOriginal: '@data-original',
      });
      const commentNodes = await tab.queryAll('.commentBody, .comment-body, .comment-content', {text: '@text'});
      const links = await tab.queryAll('.itemFullText a[href]', {url: '@href', text: '@text', title: '@title'});
      const appName = stripTitle(fields.name);
      const candidates = links.map((link) => {
        const target = absoluteUrl(link.url, url);
        if (!isDownloadCandidate(target) && !isDirectFile(target)) return null;
        return {
          label: firstValue(link.title, link.text, appName, 'APK'),
          url: target,
          size: extractSize(link.text),
          referer: url,
        };
      }).filter(Boolean);
      if (!appName) throw new Error('Sbenny detail page did not contain an application title');
      return {
        id: url,
        name: appName,
        packageName: extractPackage(fields.packageName),
        version: extractVersion(fields.version),
        size: extractSize(fields.description),
        updatedAt: cleanText(fields.updatedAt),
        category: cleanText(fields.category),
        iconUrl: absoluteUrl(fields.iconUrl, url),
        summary: cleanText(fields.summary),
        description: cleanText(fields.description),
        screenshots: uniqueBy(screenshots.map((item) => ({url: imageValue(item, url)})), 'url').map((item) => item.url),
        comments: uniqueBy(commentNodes.map((item) => ({text: cleanText(item.text)})).filter((item) => item.text), 'text').map((item) => item.text),
        downloadCandidates: uniqueBy(candidates, 'url').slice(0, 12),
      };
    } finally {
      await tab.close();
    }
  },

  async resolveDownloads(candidates, requestId) {
    const downloads = [];
    const errors = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      try {
        const resolved = await resolveCandidate(candidates[index]);
        downloads.push(...resolved);
        await reportProgress(requestId, index, resolved, null);
      } catch (error) {
        errors.push(error);
        await reportProgress(requestId, index, [], error);
      }
    }
    const unique = uniqueBy(downloads, 'url');
    if (!unique.length && errors.length && errors.length === (candidates || []).length) throw errors[0];
    return unique;
  },

  async details(value) {
    const app = await this.detailsMetadata(value);
    app.downloads = await this.resolveDownloads(app.downloadCandidates);
    delete app.downloadCandidates;
    return app;
  },

  async debug(projectId, input) {
    const value = cleanText(input);
    if (projectId === 'search-keyword') {
      const results = await this.search(value);
      return {title: '搜索完成', summary: `关键词“${value}”返回 ${results.length} 条结果`, data: results};
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {title: '详情读取完成', summary: `已读取 ${app.name}；下载项 ${app.downloads.length} 个`, data: app};
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
