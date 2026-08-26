/** LatestModAPKs public-page source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://www.latestmodapks.com';
const CATALOG_TABS = [
  {id: 'featured', name: '推荐', paged: false},
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

function textFromHtml(value) {
  return cleanText(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
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
  return /^https:\/\/(?:[a-z0-9-]+\.)?latestmodapks\.com(?:\/|$)/i.test(cleanText(url));
}

const RESERVED_PATHS = new Set([
  'apps', 'games', 'category', 'blog', 'about-us', 'contact-us', 'privacy-policy',
  'disclaimer', 'dmca', 'search', 'author', 'feed', 'wp-admin', 'wp-content',
]);

function isAppUrl(url) {
  const value = cleanText(url);
  const pathMatch = /^https:\/\/(?:www\.)?latestmodapks\.com\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(value);
  if (pathMatch) return !RESERVED_PATHS.has(pathMatch[1].toLowerCase());
  const subdomainMatch = /^https:\/\/([a-z0-9-]+)\.latestmodapks\.com\/?(?:[?#].*)?$/i.exec(value);
  return Boolean(subdomainMatch && subdomainMatch[1].toLowerCase() !== 'www');
}

function isChallenge(page) {
  const value = `${cleanText(page && page.title)} ${cleanText(page && page.body)}`;
  return /just a moment|security verification|enable javascript and cookies to continue/i.test(value);
}

function assertPublicPage(page) {
  if (isChallenge(page)) throw new Error('LatestModAPKs is protected by a Cloudflare verification page');
  if (/\b(?:404|page not found|nothing found)\b/i.test(cleanText(page && page.title))) return false;
  return true;
}

function stripApkSuffix(value) {
  return cleanText(value)
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

function unwrappedImageUrl(value, baseUrl) {
  const url = absoluteUrl(value, baseUrl);
  const wrapped = /[?&]url=([^&]+)/i.exec(url);
  if (wrapped) {
    try {
      const decoded = decodeURIComponent(wrapped[1]);
      if (isHttpUrl(decoded)) return decoded;
    } catch (_) {
      // Keep the resize URL when it does not contain valid encoding.
    }
  }
  return url;
}

function imageValue(item, baseUrl) {
  return unwrappedImageUrl(firstValue(item.dataSrc, item.dataLazySrc, item.dataOriginal, item.src), baseUrl);
}

function uniqueBy(items, field) {
  return items.filter((item, index, all) =>
    item && item[field] && all.findIndex((candidate) => candidate[field] === item[field]) === index,
  );
}

function listingUrl(kind, page) {
  const number = Math.max(1, Number(page) || 1);
  if (kind === 'featured') return `${ORIGIN}/`;
  const base = absoluteUrl(kind).replace(/\/+$/, '');
  return number > 1 ? `${base}/page/${number}/` : `${base}/`;
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  const suffix = number > 1 ? `&paged=${number}` : '';
  return `${ORIGIN}/?s=${encodeURIComponent(query)}${suffix}`;
}

async function readPage(tab, readySelector) {
  try {
    await tab.waitFor(readySelector);
  } catch (_) {
    // Querying the current DOM below provides a useful verification error.
  }
  return tab.query({
    title: 'title@text',
    body: 'body@text',
    canonical: 'link[rel="canonical"]@href',
    next: 'a[rel="next"]@href',
    nextPage: 'a.next.page-numbers@href',
  });
}

async function loadListing(url) {
  const tab = await apkmesh.browser.open(url);
  try {
    const page = await readPage(tab, 'main a[href]');
    if (!assertPublicPage(page)) return {apps: [], hasMore: false};
    const nodes = await tab.queryAll(
      'main a.card-grp, main a.app-container, main a.slider-app-wrapper, main article a[href], main .editor-app-display a[href]',
      {
        url: '@href',
        text: '@text',
        name: '.app-name-homepage@text',
        sliderName: '.app-name@text',
        cardTitle: '.card-title@text',
        heading: 'h2@text',
        smallHeading: 'h3@text',
        version: '.version-wrap@text',
        src: 'img@src',
        dataSrc: 'img@data-src',
        dataLazySrc: 'img@data-lazy-src',
        dataOriginal: 'img@data-original',
        alt: 'img@alt',
      },
    );
    const apps = nodes.map((item) => {
      const id = absoluteUrl(item.url, url).replace(/#.*$/, '');
      if (!isAppUrl(id)) return null;
      const text = cleanText(item.text);
      const name = stripApkSuffix(firstValue(
        item.name,
        item.sliderName,
        item.cardTitle,
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
        version: extractVersion(firstValue(item.version, text)),
        size: extractSize(text),
        updatedAt: '',
        category: '',
        iconUrl: imageValue(item, url),
      };
    }).filter(Boolean);
    return {apps: uniqueBy(apps, 'id'), hasMore: Boolean(page.next || page.nextPage)};
  } finally {
    await tab.close();
  }
}

async function loadCategoryTabs(section, label) {
  const url = `${ORIGIN}/${section}/`;
  const tab = await apkmesh.browser.open(url);
  try {
    const page = await readPage(tab, 'main .category-item a[href]');
    assertPublicPage(page);
    const nodes = await tab.queryAll('main .category-item a[href]', {
      url: '@href',
      text: '@text',
      heading: 'h2, h3@text',
    });
    const pattern = new RegExp(`^https://(?:www\\.)?latestmodapks\\.com/${section}/[^/?#]+/?$`, 'i');
    return uniqueBy(nodes.map((item) => {
      const id = absoluteUrl(item.url, url);
      const name = firstValue(item.heading, item.text);
      return pattern.test(id) && name
        ? {id, name: `${label} · ${name}`, paged: true}
        : null;
    }).filter(Boolean), 'id');
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
      // Ignore unrelated or malformed JSON-LD blocks.
    }
  }
  return {};
}

function structuredImage(value) {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' ? value.url || value.contentUrl || '' : '';
}

function structuredScreenshots(value) {
  return (Array.isArray(value) ? value : value ? [value] : []).map(structuredImage).filter(Boolean);
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
  return isSourceUrl(url) && /\/download\/?(?:[?#].*)?$/i.test(url);
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
    label: stripApkSuffix(link.text) || fallbackLabel || 'APK',
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
        url: '@href', text: '@text', className: '@class', download: '@download',
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
  throw new Error(`LatestModAPKs download page did not expose an APK link: ${candidate.url}`);
}

async function reportProgress(requestId, index, downloads, error) {
  if (!requestId) return;
  try {
    await apkmesh.detailProgress(requestId, {
      index, downloads: downloads || [], error: error ? String(error) : null,
    });
  } catch (_) {
    // Progress reporting must not mask the resolver result.
  }
}

globalThis.source = {
  manifest: {
    id: 'latestmodapks',
    name: 'LatestModAPKs',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '通过受隔离的浏览器读取 LatestModAPKs 公开页面、详情、截图和下载项。',
    permissions: {network: ['*'], browser: true, download: true, install: false},
    debugProjects: [
      {
        id: 'search-keyword',
        name: '搜索关键词',
        description: '在 LatestModAPKs 公开搜索页检查应用与游戏结果。',
        inputLabel: '关键词',
        placeholder: '例如 minecraft',
        defaultInput: 'minecraft',
      },
      {
        id: 'app-details',
        name: '获取应用详情',
        description: '读取 LatestModAPKs 详情页元数据、截图和公开下载链接。',
        inputLabel: '应用详情 URL',
        placeholder: '粘贴 LatestModAPKs 应用 URL',
        defaultInput: 'https://minecraft.latestmodapks.com/',
      },
    ],
  },

  async catalog() {
    const appTabs = await loadCategoryTabs('apps', '应用');
    const gameTabs = await loadCategoryTabs('games', '游戏');
    return {defaultTabId: 'featured', tabs: CATALOG_TABS.concat(appTabs, gameTabs)};
  },

  async catalogPage(tabId, page = 1) {
    const number = Math.max(1, Number(page) || 1);
    if (tabId === 'featured' && number > 1) return {apps: [], hasMore: false};
    if (tabId !== 'featured' && !/^https:\/\/(?:www\.)?latestmodapks\.com\/(?:apps|games)\/[^/?#]+\/?$/i.test(tabId)) {
      throw new TypeError('无效的目录标签');
    }
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
    if (!isAppUrl(url)) throw new TypeError('无效的 LatestModAPKs 详情地址');
    const tab = await apkmesh.browser.open(url);
    try {
      const page = await readPage(tab, 'main, article');
      assertPublicPage(page);
      const fields = await tab.query({
        id: 'link[rel="canonical"]@href',
        name: 'h1.entry-title, h1@text',
        version: '.appver@text',
        iconUrl: '.download-title-block img@src',
        summary: 'meta[name="description"]@content',
        description: '.app-detailes-main-block, article .entry-content@text',
      });
      const rows = await tab.queryAll('table.app-info-main-block tr, table tr', {
        label: 'th, .app-name-table-key@text',
        value: 'td, .app-name-table-value@text',
      });
      const structured = structuredApplication(await tab.queryAll('script[type="application/ld+json"]', {text: '@text'}));
      const screenshots = await tab.queryAll('.app-screenshots img, .screenshots-wrapper img, [class*="screenshot"] img', {
        src: '@src', dataSrc: '@data-src', dataLazySrc: '@data-lazy-src', dataOriginal: '@data-original',
      });
      const comments = await tab.queryAll('.comment-content, .comment-body', {text: '@text'});
      const links = await tab.queryAll('a[href]', {
        url: '@href', text: '@text', className: '@class', download: '@download',
      });
      const appName = stripApkSuffix(firstValue(fields.name, structured.name));
      const size = rowField(rows, ['size', 'file size']) || cleanText(structured.fileSize);
      const candidates = links.map((link) => {
        const target = absoluteUrl(link.url, url);
        if (!isDownloadPage(target) && !isDirectFile(target)) return null;
        return {label: stripApkSuffix(link.text) || appName || 'APK', url: target, size};
      }).filter(Boolean);
      return {
        id: absoluteUrl(fields.id || structured.url || url, url),
        name: appName,
        packageName: rowField(rows, ['package name', 'package']),
        version: rowField(rows, ['version', 'latest version']) || cleanText(fields.version || structured.softwareVersion),
        size,
        updatedAt: rowField(rows, ['last updated', 'updated']) || cleanText(structured.dateModified),
        category: rowField(rows, ['category', 'genre']) || cleanText(structured.applicationSubCategory || structured.applicationCategory),
        iconUrl: unwrappedImageUrl(fields.iconUrl || structuredImage(structured.image), url),
        summary: cleanText(fields.summary || structured.description),
        description: textFromHtml(fields.description || structured.description),
        screenshots: uniqueBy(screenshots.map((item) => ({url: imageValue(item, url)})).concat(
          structuredScreenshots(structured.screenshot).map((item) => ({url: unwrappedImageUrl(item, url)})),
        ), 'url').map((item) => item.url),
        comments: uniqueBy(comments.map((item) => ({text: cleanText(item.text)})).filter((item) => item.text), 'text').map((item) => item.text),
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
