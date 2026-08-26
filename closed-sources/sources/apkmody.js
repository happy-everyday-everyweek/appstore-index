/** APKMODY public-page source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://apkmody.com';
const CATALOG_TABS = [
  {id: 'featured', name: '推荐', paged: false},
  {id: 'games', name: '游戏', paged: true},
  {id: 'apps', name: '应用', paged: true},
];

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    })[entity.toLowerCase()]);
}

function cleanText(value) {
  return decodeHtml(String(value || '').replace(/\s+/g, ' ')).trim();
}

function absoluteUrl(value, baseUrl = ORIGIN) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  const originMatch = /^https?:\/\/[^/]+/i.exec(baseUrl);
  const origin = originMatch ? originMatch[0] : ORIGIN;
  if (url.startsWith('/')) return `${origin}${url}`;
  const directory = baseUrl.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
  return `${directory}${url}`;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(cleanText(url));
}

function isSourceUrl(url) {
  return /^https:\/\/(?:www\.)?apkmody\.com(?:\/|$)/i.test(cleanText(url));
}

function isAppUrl(url) {
  return /^https:\/\/(?:www\.)?apkmody\.com\/(?:games|apps)\/[^/?#]+\/?(?:[?#].*)?$/i.test(cleanText(url));
}

function isChallenge(page) {
  const title = cleanText(page && page.title);
  const body = cleanText(page && page.body);
  return /just a moment|security verification/i.test(`${title} ${body}`) ||
    /enable javascript and cookies to continue/i.test(body);
}

function assertPublicPage(page) {
  if (isChallenge(page)) {
    throw new Error('APKMODY is protected by a Cloudflare verification page');
  }
  if (/\b(?:404|page not found|nothing found)\b/i.test(cleanText(page && page.title))) {
    return false;
  }
  return true;
}

function stripApkSuffix(value) {
  return cleanText(value)
    .replace(/\s+v\d+(?:\.\d+)+[\s\S]*$/i, '')
    .replace(/\s+(?:MOD\s+)?APK(?:\s+v?[\w.-]+)?(?:\s*\([^)]*\))?\s*$/i, '')
    .replace(/\s+-\s+Download.*$/i, '')
    .trim();
}

function extractVersion(value) {
  const match = /\bv?\d+(?:\.\d+)+(?:[A-Za-z][\w.-]*)?/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function firstValue(...values) {
  return values.map(cleanText).find(Boolean) || '';
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

function listingUrl(kind, page) {
  const number = Math.max(1, Number(page) || 1);
  if (kind === 'featured') return `${ORIGIN}/`;
  return number > 1 ? `${ORIGIN}/${kind}/page/${number}` : `${ORIGIN}/${kind}`;
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  const path = `${ORIGIN}/search/${encodeURIComponent(query)}`;
  return number > 1 ? `${path}/page/${number}` : path;
}

async function readPage(tab, readySelector) {
  try {
    await tab.waitFor(readySelector);
  } catch (_) {
    // Read the current DOM below so a verification page produces a useful error.
  }
  const page = await tab.query({
    title: 'title@text',
    body: 'body@text',
    canonical: 'link[rel="canonical"]@href',
    next: 'link[rel="next"]@href',
    nextPage: '.archive-pagination a.next@href',
  });
  return page;
}

async function loadListing(url) {
  const tab = await apkmesh.browser.open(url);
  try {
    const page = await readPage(tab, 'main a[href]');
    if (!assertPublicPage(page)) return {apps: [], hasMore: false};
    const nodes = await tab.queryAll('main a[href]', {
      url: '@href',
      text: '@text',
      heading: 'h2@text',
      smallHeading: 'h3@text',
      appHeading: '.app-name h2@text',
      name: '.app-name@text',
      cardName: '.entry-title@text',
      version: '.app-sub-text@text',
      meta: '.app-meta@text',
      src: 'img@src',
      dataSrc: 'img@data-src',
      dataLazySrc: 'img@data-lazy-src',
      dataOriginal: 'img@data-original',
      alt: 'img@alt',
    });
    const apps = nodes.map((item) => {
      const id = absoluteUrl(item.url, url).replace(/#.*$/, '');
      if (!isAppUrl(id)) return null;
      const text = cleanText(item.text);
      const name = stripApkSuffix(firstValue(
        item.appHeading,
        item.name,
        item.cardName,
        item.heading,
        item.smallHeading,
        item.alt,
        text,
      ));
      if (!name) return null;
      return {
        id,
        name,
        packageName: '',
        version: extractVersion(firstValue(item.version, item.meta, text)),
        size: extractSize(firstValue(item.meta, text)),
        updatedAt: '',
        category: /\/games\//i.test(id) ? '游戏' : '应用',
        iconUrl: imageValue(item, url),
      };
    }).filter(Boolean);
    return {
      apps: uniqueBy(apps, 'id'),
      hasMore: Boolean(page.next || page.nextPage),
    };
  } finally {
    await tab.close();
  }
}

function structuredApplication(nodes) {
  function visit(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object') return null;
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.some((type) => /^(?:Mobile|Software)Application$/i.test(type || ''))) return value;
    for (const key of ['mainEntity', '@graph', 'itemListElement']) {
      const found = visit(value[key]);
      if (found) return found;
    }
    return null;
  }
  for (const node of nodes || []) {
    try {
      const found = visit(JSON.parse(cleanText(node.text)));
      if (found) return found;
    } catch (_) {
      // Pages commonly include unrelated or malformed JSON-LD blocks.
    }
  }
  return {};
}

function structuredImage(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.url || value.contentUrl || '';
  return '';
}

function structuredScreenshots(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map(structuredImage).filter(Boolean);
}

function rowField(rows, labels) {
  const expected = labels.map((label) => label.toLowerCase());
  const row = (rows || []).find((item) => {
    const label = cleanText(item.label).toLowerCase().replace(/:$/, '');
    return expected.some((value) => label === value || label.startsWith(`${value} `));
  });
  return row ? cleanText(row.value) : '';
}

function isDownloadPage(url) {
  return isSourceUrl(url) && /\/download(?:\/|$)|\/(?:games|apps)\/[^/?#]+\/download/i.test(url);
}

function isDirectFile(url) {
  return isHttpUrl(url) && /\.(?:apk|xapk|apks)(?:[?#]|$)/i.test(url);
}

function downloadFromLink(link, referer, fallbackLabel, fallbackSize) {
  const url = absoluteUrl(link.url, referer);
  if (!isHttpUrl(url)) return null;
  const marker = `${cleanText(link.text)} ${cleanText(link.className)} ${cleanText(link.download)}`;
  const externalDownload = !isSourceUrl(url) && /\bdownload\b/i.test(marker) &&
    !/facebook|twitter|whatsapp|telegram|advert|play\.google/i.test(url);
  if (!isDirectFile(url) && !externalDownload) return null;
  return {
    label: stripApkSuffix(cleanText(link.text)) || fallbackLabel || 'APK',
    url,
    size: extractSize(link.text) || fallbackSize || '',
    headers: {Referer: referer},
  };
}

async function inspectDownloadPage(candidate) {
  let current = absoluteUrl(candidate.url);
  const visited = new Set();
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isHttpUrl(current) || visited.has(current)) break;
    visited.add(current);
    if (isDirectFile(current)) return [{...candidate, url: current}];
    const tab = await apkmesh.browser.open(current);
    try {
      const page = await readPage(tab, 'body');
      assertPublicPage(page);
      const links = await tab.queryAll('a[href]', {
        url: '@href',
        text: '@text',
        className: '@class',
        download: '@download',
      });
      const downloads = uniqueBy(links.map((link) =>
        downloadFromLink(link, current, candidate.label, candidate.size),
      ).filter(Boolean), 'url');
      if (downloads.length) return downloads;
      const next = links.map((link) => absoluteUrl(link.url, current)).find((url) =>
        isDownloadPage(url) && !visited.has(url),
      );
      if (!next) break;
      current = next;
    } finally {
      await tab.close();
    }
  }
  throw new Error(`APKMODY download page did not expose an APK link: ${candidate.url}`);
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
    // Progress reporting must not mask the actual resolver result.
  }
}

globalThis.source = {
  manifest: {
    id: 'apkmody',
    name: 'APKMODY',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '通过受隔离的浏览器读取 APKMODY 公开页面、应用详情和下载项。',
    permissions: {
      network: ['*'],
      browser: true,
      download: true,
      install: false,
    },
    debugProjects: [
      {
        id: 'search-keyword',
        name: '搜索关键词',
        description: '在 APKMODY 公开搜索页检查应用与游戏结果。',
        inputLabel: '关键词',
        placeholder: '例如 minecraft',
        defaultInput: 'minecraft',
      },
      {
        id: 'app-details',
        name: '获取应用详情',
        description: '读取 APKMODY 详情页元数据、截图和公开下载链接。',
        inputLabel: '应用详情 URL',
        placeholder: '粘贴 APKMODY 应用或游戏 URL',
        defaultInput: 'https://apkmody.com/games/minecraft-education',
      },
    ],
  },

  async catalog() {
    return {defaultTabId: 'featured', tabs: CATALOG_TABS};
  },

  async catalogPage(tabId, page = 1) {
    if (!CATALOG_TABS.some((tab) => tab.id === tabId)) throw new TypeError('无效的目录标签');
    const number = Math.max(1, Number(page) || 1);
    if (tabId === 'featured' && number > 1) return {apps: [], hasMore: false};
    const result = await loadListing(listingUrl(tabId, number));
    return {apps: result.apps, hasMore: tabId === 'featured' ? false : result.hasMore};
  },

  async search(query, page = 1) {
    const normalized = cleanText(query);
    if (normalized.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    return (await loadListing(searchUrl(normalized, page))).apps;
  },

  async detailsMetadata(value) {
    const url = absoluteUrl(value);
    if (!isAppUrl(url)) throw new TypeError('无效的 APKMODY 详情地址');
    const tab = await apkmesh.browser.open(url);
    try {
      const page = await readPage(tab, 'main, article');
      assertPublicPage(page);
      const fields = await tab.query({
        id: 'link[rel="canonical"]@href',
        name: 'h1@text',
        iconUrl: 'meta[property="og:image"]@content',
        summary: 'meta[name="description"]@content',
        description: '.entry-block.entry-content.main-entry-content@text',
      });
      const rows = await tab.queryAll('table tr, .app-info li, .specifications li', {
        label: 'th, .label, strong@text',
        value: 'td, .value, span@text',
      });
      const structured = structuredApplication(await tab.queryAll('script[type="application/ld+json"]', {text: '@text'}));
      const screenshots = await tab.queryAll('.screenshots img, .gallery img, [class*="screenshot"] img', {
        src: '@src', dataSrc: '@data-src', dataLazySrc: '@data-lazy-src', dataOriginal: '@data-original',
      });
      const comments = await tab.queryAll('.comment-content, .comment-body', {text: '@text'});
      const links = await tab.queryAll('a[href]', {
        url: '@href', text: '@text', className: '@class', download: '@download',
      });
      const appName = stripApkSuffix(firstValue(fields.name, structured.name));
      const size = rowField(rows, ['size', 'file size']) || cleanText(structured.fileSize);
      const directCandidates = links.map((link) => {
        const target = absoluteUrl(link.url, url);
        if (!isDownloadPage(target) && !isDirectFile(target)) return null;
        return {label: stripApkSuffix(link.text) || appName || 'APK', url: target, size};
      }).filter(Boolean);
      return {
        id: absoluteUrl(fields.id || structured.url || url, url),
        name: appName,
        packageName: rowField(rows, ['package name', 'package', 'id']),
        version: rowField(rows, ['version', 'latest version']) || cleanText(structured.softwareVersion),
        size,
        updatedAt: rowField(rows, ['updated', 'last updated']) || cleanText(structured.dateModified),
        category: rowField(rows, ['category', 'genre']) || cleanText(structured.applicationSubCategory || structured.applicationCategory),
        iconUrl: absoluteUrl(structuredImage(structured.image) || fields.iconUrl, url),
        summary: cleanText(fields.summary || structured.description),
        description: cleanText(fields.description || structured.description),
        screenshots: uniqueBy(screenshots.map((item) => ({url: imageValue(item, url)})).concat(
          structuredScreenshots(structured.screenshot).map((item) => ({url: absoluteUrl(item, url)})),
        ), 'url').map((item) => item.url),
        comments: uniqueBy(comments.map((item) => ({text: cleanText(item.text)})).filter((item) => item.text), 'text').map((item) => item.text),
        downloadCandidates: uniqueBy(directCandidates, 'url').slice(0, 12),
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
        const resolved = await inspectDownloadPage(candidates[index]);
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
      return {title: '搜索完成', summary: `关键词“${value}”返回 ${results.length} 条结果`, data: results};
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {title: '详情读取完成', summary: `已读取 ${app.name}；下载项 ${app.downloads.length} 个`, data: app};
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
