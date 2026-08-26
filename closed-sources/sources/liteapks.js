/** LITEAPKS source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://liteapks.com';
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  Referer: `${ORIGIN}/`,
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
};
const CATALOG_TABS = [
  {id: 'games', name: '游戏', path: '/games'},
  {id: 'apps', name: '应用', path: '/apps'},
];

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    })[entity.toLowerCase()] || `&${entity};`);
}

function textFromHtml(value) {
  return decodeHtml(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')).trim();
}

function cleanText(value) {
  return decodeHtml(String(value || '').replace(/\s+/g, ' ')).trim();
}

function attribute(tag, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag || '');
  return match ? decodeHtml(match[2]).trim() : '';
}

function absoluteUrl(value, base = ORIGIN) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url.replace(/^http:\/\//i, 'https://');
  const origin = (/^(https?:\/\/[^/]+)/i.exec(base) || [null, ORIGIN])[1];
  if (url.startsWith('/')) return `${origin}${url}`;
  const directory = String(base).replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
  return `${directory}${url}`;
}

function isDetailUrl(url) {
  return /^https:\/\/(?:www\.)?liteapks\.com\/[a-z0-9][a-z0-9-]*\.html(?:[?#].*)?$/i.test(url || '');
}

function extractVersion(value) {
  const match = /\bv?(\d+(?:\.\d+)+(?:[-._][a-z0-9]+)*)\b/i.exec(textFromHtml(value));
  return match ? match[1] : '';
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:K|M|G|KB|MB|GB)\b/i.exec(textFromHtml(value));
  return match ? match[0] : '';
}

function uniqueBy(items, key) {
  return items.filter((item, index, all) => item && all.findIndex((other) => other[key] === item[key]) === index);
}

function imageUrl(block, base) {
  const tag = /<img\b[^>]*>/i.exec(block || '');
  if (!tag) return '';
  for (const name of ['data-src', 'data-lazy-src', 'src']) {
    const value = attribute(tag[0], name);
    if (value && !/data:image|android\.ico/i.test(value)) return absoluteUrl(value, base);
  }
  return '';
}

async function fetchText(url, referer = ORIGIN) {
  return apkmesh.request(url, {headers: {...HEADERS, Referer: referer}});
}

function isNotFound(error) {
  return /\b(?:HTTP\s+|status(?:\s+code)?\s*[:=]?\s*)404\b/i.test(String(error && error.message || error || ''));
}

async function fetchPage(url) {
  try {
    return await fetchText(url);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function parseCards(html) {
  const results = [];
  for (const match of String(html || '').matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
    const block = match[1];
    const link = /<a\b[^>]*href=["'][^"']+\.html["'][^>]*>/i.exec(block);
    if (!link) continue;
    const id = absoluteUrl(attribute(link[0], 'href'));
    if (!isDetailUrl(id)) continue;
    const title = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i.exec(block);
    const fallback = attribute(link[0], 'aria-label').replace(/^View\s+|\s+details$/gi, '');
    const name = textFromHtml(title ? title[1] : fallback);
    if (!name) continue;
    const text = textFromHtml(block);
    const versionLabel = /aria-label=["']Version\s+([^"']+)["']/i.exec(block);
    const metadata = /<p\b[^>]*class=["'][^"']*\btext-xs\b[^"']*\bfont-medium\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const metadataText = textFromHtml(metadata ? metadata[1] : '');
    results.push({
      id,
      name,
      packageName: '',
      version: extractVersion(versionLabel ? versionLabel[1] : metadataText),
      size: extractSize(metadataText),
      updatedAt: '',
      category: '',
      iconUrl: imageUrl(block, id),
      summary: '',
    });
  }
  return uniqueBy(results, 'id');
}

function parseBrowserCards(rows) {
  return uniqueBy((rows || []).map((row) => {
    const id = absoluteUrl(row.id);
    const metadata = cleanText(row.metadata);
    return {
      id,
      name: cleanText(row.name),
      packageName: '',
      version: extractVersion(row.version || metadata),
      size: extractSize(metadata),
      updatedAt: '',
      category: '',
      iconUrl: absoluteUrl(row.icon, id),
      summary: '',
    };
  }).filter((item) => isDetailUrl(item.id) && item.name), 'id');
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  const prefix = number > 1 ? `/page/${number}/` : '/';
  return `${ORIGIN}${prefix}?s=${encodeURIComponent(query)}`;
}

function catalogUrl(path, page) {
  const number = Math.max(1, Number(page) || 1);
  return number > 1 ? `${ORIGIN}${path}/page/${number}/` : `${ORIGIN}${path}`;
}

function hasNextPage(html) {
  return /<a\b[^>]*(?:rel=["']next["']|class=["'][^"']*\bnext\b[^"']*page-numbers)[^>]*>/i.test(html || '');
}

function firstMatch(html, pattern, group = 1) {
  const match = pattern.exec(html || '');
  return match ? textFromHtml(match[group]) : '';
}

function infoBarValue(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<div\\b[^>]*class=["'][^"']*info-bar-label[^"']*["'][^>]*>\\s*${escaped}\\s*<\\/div>([\\s\\S]*?)(?=<\\/div>\\s*<div\\b[^>]*class=["'][^"']*info-bar-item|<\\/section>)`, 'i');
  const match = pattern.exec(html || '');
  if (!match) return '';
  const value = /<div\b[^>]*class=["'][^"']*info-bar-value[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(match[1]);
  const sub = /<div\b[^>]*class=["'][^"']*info-bar-sub[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(match[1]);
  return textFromHtml(`${value ? value[1] : ''} ${sub ? sub[1] : ''}`);
}

function parseDetails(html, url) {
  const canonical = firstMatch(html, /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || url;
  const headline = firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const schemaName = firstMatch(html, /["']headline["']\s*:\s*["']([^"']+)["']/i);
  const name = schemaName || headline.replace(/\s+(?:Premium\s+)?v?\d+(?:\.\d+)+.*$/i, '').trim();
  const version = infoBarValue(html, 'VERSION').replace(/\s+Latest$/i, '') || extractVersion(headline);
  const size = infoBarValue(html, 'SIZE').replace(/\s+Total$/i, '') || extractSize(html);
  const genre = infoBarValue(html, 'GENRE');
  const updated = infoBarValue(html, 'UPDATED');
  const packageMatch = /play\.google\.com\/store\/apps\/details\?[^"']*\bid=([a-z0-9._]+)/i.exec(html || '');
  const iconBlock = /<div\b[^>]*class=["'][^"']*\bapp-info-icon\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  const descriptionMatch = /<div\b[^>]*id=["']descContent["'][^>]*>([\s\S]*?)(?=<\/div>\s*<div\b[^>]*(?:id=["']mod-info|class=["'][^"']*tab-content))/i.exec(html || '');
  const descriptionHtml = descriptionMatch ? descriptionMatch[1] : '';
  const screenshots = [];
  for (const match of descriptionHtml.matchAll(/<img\b[^>]*>/gi)) {
    const value = imageUrl(match[0], canonical);
    if (/^https:\/\/(?:www\.)?liteapks\.com\/wp-content\/uploads\//i.test(value)) screenshots.push(value);
  }
  const candidate = /<a\b[^>]*href=["']([^"']*\/download\/[a-z0-9-]+\/?)["'][^>]*>/i.exec(html || '');
  return {
    id: absoluteUrl(canonical),
    name,
    packageName: packageMatch ? packageMatch[1] : '',
    version,
    size,
    updatedAt: updated,
    category: genre,
    iconUrl: iconBlock ? imageUrl(iconBlock[1], canonical) : firstMatch(html, /<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i),
    summary: firstMatch(html, /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i),
    description: textFromHtml(descriptionHtml),
    screenshots: uniqueBy(screenshots.map((value) => ({value})), 'value').map((item) => item.value),
    comments: [],
    downloadCandidates: candidate ? [{label: `${name} ${version}`.trim(), url: absoluteUrl(candidate[1], canonical), size}] : [],
  };
}

async function reportProgress(requestId, index, downloads, error) {
  if (!requestId) return;
  try {
    await apkmesh.detailProgress(requestId, {index, downloads: downloads || [], error: error ? String(error) : null});
  } catch (_) {
    // Progress delivery must not abort resolution.
  }
}

globalThis.source = {
  manifest: {
    id: 'liteapks',
    name: 'LITEAPKS',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 LITEAPKS 的公开搜索、目录、应用详情和下载链接。',
    permissions: {network: ['liteapks.com', '*.liteapks.com'], browser: true, download: true, install: false},
    debugProjects: [
      {id: 'search-keyword', name: '搜索关键词', description: '读取搜索结果及分页。', inputLabel: '关键词', placeholder: '例如 minecraft', defaultInput: 'minecraft'},
      {id: 'app-details', name: '获取应用详情', description: '读取元数据并尝试解析公开下载页。', inputLabel: '详情 URL', placeholder: '粘贴 LITEAPKS 详情地址', defaultInput: 'https://liteapks.com/spotify-2.html'},
      {id: 'catalog', name: '检查目录', description: '读取游戏和应用目录首页。', inputLabel: '标签数量上限', placeholder: '0 表示全部', defaultInput: '0'},
    ],
  },

  async catalog() {
    return {defaultTabId: 'games', tabs: CATALOG_TABS.map((tab) => ({id: tab.id, name: tab.name, paged: true}))};
  },

  async catalogPage(tabId, page = 1) {
    const tab = CATALOG_TABS.find((item) => item.id === tabId);
    if (!tab) throw new TypeError('无效的 LITEAPKS 目录标签');
    const html = await fetchPage(catalogUrl(tab.path, page));
    if (html === null) return {apps: [], hasMore: false};
    return {apps: parseCards(html), hasMore: hasNextPage(html)};
  },

  async search(query, page = 1) {
    const value = cleanText(query);
    if (value.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    if ((Number(page) || 1) > 1) {
      const tab = await apkmesh.browser.open(searchUrl(value, page));
      try {
        const rows = await tab.queryAll('article', {
          id: 'a[href$=".html"]@href',
          name: 'h2@text',
          version: '[aria-label^="Version "]@text',
          metadata: 'p.text-xs.font-medium@text',
          icon: 'img@src',
        });
        return parseBrowserCards(rows);
      } finally {
        await tab.close();
      }
    }
    const html = await fetchPage(searchUrl(value, page));
    return html === null ? [] : parseCards(html);
  },

  async detailsMetadata(idOrUrl) {
    const url = absoluteUrl(idOrUrl);
    if (!isDetailUrl(url)) throw new TypeError('无效的 LITEAPKS 详情地址');
    return parseDetails(await fetchText(url), url);
  },

  async resolveDownloads(candidates, requestId) {
    const resolved = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      const candidate = candidates[index];
      try {
        const url = absoluteUrl(candidate && candidate.url);
        if (!/^https:\/\/(?:www\.)?liteapks\.com\/download\/[a-z0-9-]+\/?$/i.test(url)) throw new TypeError('无效的 LITEAPKS 下载页地址');
        const tab = await apkmesh.browser.open(url);
        let downloads;
        try {
          const links = await tab.queryAll('a[href$=".apk"], a[href*=".apk?"], a[href$=".xapk"], a[href*=".xapk?"]', {url: '@href', text: '@text'});
          downloads = links.map((item) => ({
            label: cleanText(item.text) || cleanText(candidate.label) || 'APK',
            url: absoluteUrl(item.url, url),
            size: extractSize(item.text) || cleanText(candidate.size),
            headers: {...HEADERS, Referer: url},
          })).filter((item) => /^https:\/\/(?:[a-z0-9-]+\.)?liteapks\.com\/[^?#]+\.(?:apk|xapk|apks)(?:[?#]|$)/i.test(item.url));
        } finally {
          await tab.close();
        }
        downloads = uniqueBy(downloads, 'url');
        if (!downloads.length) throw new Error('LITEAPKS 下载页未返回站内 APK 直链');
        resolved.push(...downloads);
        await reportProgress(requestId, index, downloads, null);
      } catch (error) {
        await reportProgress(requestId, index, [], error);
      }
    }
    return uniqueBy(resolved, 'url');
  },

  async details(idOrUrl) {
    const app = await this.detailsMetadata(idOrUrl);
    app.downloads = await this.resolveDownloads(app.downloadCandidates);
    delete app.downloadCandidates;
    return app;
  },

  async debug(projectId, input) {
    const value = cleanText(input);
    if (projectId === 'search-keyword') {
      const results = await this.search(value, 1);
      return {title: '搜索完成', summary: `返回 ${results.length} 条结果`, data: results};
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {title: '详情读取完成', summary: `已读取 ${app.name}；下载项 ${app.downloads.length} 个`, data: app};
    }
    if (projectId === 'catalog') {
      const catalog = await this.catalog();
      const limit = Math.max(0, Number(value) || 0);
      const tabs = [];
      for (const tab of (limit ? catalog.tabs.slice(0, limit) : catalog.tabs)) {
        const result = await this.catalogPage(tab.id, 1);
        tabs.push({id: tab.id, apps: result.apps.length, hasMore: result.hasMore});
      }
      return {title: '目录检查完成', summary: `检查 ${tabs.length} 个标签`, data: {tabs}};
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
