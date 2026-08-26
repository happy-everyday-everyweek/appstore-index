/** APKPure Lite source for APK Mesh. */
const ORIGIN = 'https://apkpure.net';
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  Referer: `${ORIGIN}/`,
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    })[entity.toLowerCase()] || `&${entity};`);
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
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag || '');
  return match ? decodeHtml(match[2]).trim() : '';
}

function absoluteUrl(value) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  return url.startsWith('/') ? `${ORIGIN}${url}` : `${ORIGIN}/${url}`;
}

function isDetailUrl(url) {
  return /^https:\/\/apkpure\.net\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_.]+\/?(?:[?#].*)?$/i.test(url || '');
}

function unique(items, key) {
  return items.filter((item, index, all) => item && all.findIndex((other) => other[key] === item[key]) === index);
}

function uniqueStrings(items) {
  return items.filter((item, index, all) => item && all.indexOf(item) === index);
}

function formatBytes(value) {
  let amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

async function fetchText(url, referer = ORIGIN) {
  return apkmesh.request(url, {headers: {...HEADERS, Referer: referer}});
}

function notFound(error) {
  return /\bHTTP\s+404\b|\bstatus(?:\s+code)?\s*[:=]?\s*404\b/i.test(String(error && error.message || error || ''));
}

async function fetchPage(url, referer) {
  try {
    return await fetchText(url, referer);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

function mapCard(openingTag, block, fallback = {}) {
  const id = absoluteUrl(attribute(openingTag, 'href') || fallback.id);
  const packageName = cleanText(attribute(openingTag, 'data-dt-pkg') || fallback.packageName || (id.split('/').filter(Boolean).pop()));
  const name = cleanText(
    attribute(openingTag, 'title').replace(/\s+APK(?:\s+Download)?$/i, '') ||
    textFromHtml((/<(?:div|p)\b[^>]*class\s*=\s*["'][^"']*(?:title|grid-item-title)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|p)>/i.exec(block || '') || [null, ''])[1]) ||
    fallback.name,
  );
  const image = /<img\b[^>]*>/i.exec(block || '');
  if (!isDetailUrl(id) || !name || !packageName) return null;
  return {
    id,
    name,
    packageName,
    version: cleanText(fallback.version),
    size: cleanText(fallback.size),
    updatedAt: cleanText(fallback.updatedAt),
    category: cleanText(fallback.category),
    iconUrl: image ? absoluteUrl(attribute(image[0], 'data-original') || attribute(image[0], 'src')) : cleanText(fallback.iconUrl),
  };
}

function parseSearchResults(html) {
  const results = [];
  const brand = /<div\b[^>]*class\s*=\s*["'][^"']*\bbrand-top\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html || '');
  if (brand) {
    const link = /<a\b[^>]*class\s*=\s*["'][^"']*\btop\b[^"']*["'][^>]*>/i.exec(brand[1]);
    if (link) results.push(mapCard(link[0], brand[1]));
  }
  for (const match of (html || '').matchAll(/<a\b([^>]*\bclass\s*=\s*["'][^"']*\bapk-item\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
    results.push(mapCard(`<a${match[1]}>`, match[2]));
  }
  return unique(results.filter(Boolean), 'id');
}

function parseCatalogResults(html, category) {
  const results = [];
  for (const match of (html || '').matchAll(/<div\b([^>]*\bclass\s*=\s*["'][^"']*\bgrid-row\b[^"']*["'][^>]*)>([\s\S]*?)(?=<div\b[^>]*\bclass\s*=\s*["'][^"']*\bgrid-row\b|<\/section>|<\/ul>)/gi)) {
    const opening = `<div${match[1]}>`;
    const link = /<a\b[^>]*href\s*=\s*["'][^"']+["'][^>]*>/i.exec(match[2]);
    if (!link) continue;
    results.push(mapCard(link[0], match[2], {
      packageName: attribute(opening, 'data-dt-pkg'),
      version: attribute(opening, 'data-dt-version'),
      size: formatBytes(attribute(opening, 'data-dt-file-size')),
      category,
    }));
  }
  return unique(results.filter(Boolean), 'id');
}

function parseStructuredApp(html) {
  for (const match of (html || '').matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const app = values.find((item) => item && item['@type'] === 'MobileApplication');
      if (app) return app;
    } catch (_) {
      // Ignore unrelated malformed structured-data blocks.
    }
  }
  return {};
}

function metaContent(html, key, property = 'name') {
  const pattern = new RegExp(`<meta\\b[^>]*\\b${property}\\s*=\\s*["']${key}["'][^>]*>`, 'i');
  const tag = pattern.exec(html || '');
  return tag ? attribute(tag[0], 'content') : '';
}

function informationValue(html, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<div\\b[^>]*data-title\\s*=\\s*["']${escaped}["'][^>]*>[\\s\\S]*?<\\/div>\\s*<(?:div|a)\\b[^>]*class\\s*=\\s*["'][^"']*\\badditional-info\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:div|a)>`, 'i');
  const match = pattern.exec(html || '');
  return match ? textFromHtml(match[1]) : '';
}

function structuredScreenshots(value) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => absoluteUrl(typeof item === 'string' ? item : item && item.url)).filter(Boolean);
}

function parseDetails(html, inputUrl) {
  const canonicalTag = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.exec(html || '');
  const id = absoluteUrl(canonicalTag ? attribute(canonicalTag[0], 'href') : inputUrl);
  if (!isDetailUrl(id)) throw new Error('APKPure detail page did not expose a valid canonical URL');
  const structured = parseStructuredApp(html);
  const body = /<body\b[^>]*>/i.exec(html || '');
  const header = /<div\b[^>]*class\s*=\s*["'][^"']*\bhead-app-info\b[^"']*["'][^>]*>/i.exec(html || '');
  const packageName = cleanText((header && attribute(header[0], 'data-package_name')) || (body && attribute(body[0], 'data-package-name')) || id.split('/').filter(Boolean).pop());
  const icon = /<img\b[^>]*class\s*=\s*["'][^"']*\bapp-icon-img\b[^"']*["'][^>]*>/i.exec(html || '');
  const name = cleanText(structured.name || metaContent(html, 'og:title', 'property').replace(/\s+APK\b.*$/i, ''));
  if (!name || !packageName) throw new Error('APKPure detail page did not expose required app metadata');
  const fileSize = formatBytes(body && attribute(body[0], 'data-dt-filesize')) || informationValue(html, 'FileSize');
  return {
    id,
    name,
    packageName,
    version: cleanText(structured.version || (body && attribute(body[0], 'data-dt-version'))),
    size: fileSize,
    updatedAt: cleanText(structured.datePublished),
    category: cleanText(structured.applicationSubCategory || structured.applicationCategory),
    iconUrl: absoluteUrl(icon ? attribute(icon[0], 'src') : metaContent(html, 'og:image', 'property')),
    summary: cleanText(metaContent(html, 'description')),
    description: cleanText(structured.description || metaContent(html, 'description')),
    screenshots: uniqueStrings(structuredScreenshots(structured.screenshot)),
    comments: [],
    downloadCandidates: [{label: `${name} ${cleanText(body && attribute(body[0], 'data-dt-apkid')).includes('/XAPK/') ? 'XAPK' : 'APK'}`, url: `${id.replace(/\/$/, '')}/download`, size: fileSize}],
  };
}

function parseDownloads(html, candidate) {
  const downloads = [];
  for (const match of (html || '').matchAll(/<a\b[^>]*href\s*=\s*(["'])(https:\/\/d\.apkpure\.net\/b\/(?:APK|XAPK)\/[^"']+)\1[^>]*>/gi)) {
    const tag = match[0];
    const url = decodeHtml(match[2]);
    const type = /\/XAPK\//i.test(url) ? 'XAPK' : 'APK';
    const title = cleanText(attribute(tag, 'title'));
    const baseLabel = title || candidate.label || 'APKPure';
    downloads.push({label: new RegExp(`\\b${type}\\b`, 'i').test(baseLabel) ? baseLabel : `${baseLabel} ${type}`, url, size: cleanText(candidate.size), headers: {...HEADERS, Referer: candidate.url}});
  }
  return unique(downloads, 'url');
}

async function progress(requestId, index, downloads, error) {
  if (!requestId) return;
  try {
    await apkmesh.detailProgress(requestId, {index, downloads: downloads || [], error: error ? String(error) : null});
  } catch (_) {
    // Progress delivery must not abort resolution.
  }
}

const CATALOG_TABS = [
  {id: `${ORIGIN}/game`, name: '游戏', description: 'APKPure Lite 热门游戏', paged: false, category: '游戏'},
  {id: `${ORIGIN}/app`, name: '应用', description: 'APKPure Lite 热门应用', paged: false, category: '应用'},
];

globalThis.source = {
  manifest: {
    id: 'apkpure',
    name: 'APKPure',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '使用 APKPure 官方 Lite 站点读取搜索、详情、截图和下载项。',
    packageLookup: true,
    permissions: {
      network: ['apkpure.net', 'd.apkpure.net'],
      browser: false,
      download: true,
      install: false,
    },
    debugProjects: [
      {id: 'search-keyword', name: '搜索关键词', description: '通过 APKPure Lite 搜索 Android 应用。', inputLabel: '关键词', placeholder: '例如 minecraft', defaultInput: 'minecraft'},
      {id: 'app-details', name: '获取应用详情', description: '读取 APKPure Lite 详情、截图和下载链接。', inputLabel: '详情 URL', placeholder: '粘贴 apkpure.net 详情 URL', defaultInput: 'https://apkpure.net/minecraft-trial-game/com.mojang.minecrafttrialpe'},
    ],
  },

  async catalog() {
    return {defaultTabId: CATALOG_TABS[0].id, tabs: CATALOG_TABS.map(({category, ...tab}) => tab)};
  },

  async catalogPage(tabId, page = 1) {
    const tab = CATALOG_TABS.find((item) => item.id === tabId);
    if (!tab) throw new TypeError('无效的 APKPure 目录标签');
    if (Math.max(1, Number(page) || 1) > 1) return {apps: [], hasMore: false};
    const html = await fetchPage(tab.id);
    return {apps: html === null ? [] : parseCatalogResults(html, tab.category), hasMore: false};
  },

  async search(query, page = 1) {
    const value = cleanText(query);
    if (value.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    if (Math.max(1, Number(page) || 1) > 1) return [];
    const html = await fetchPage(`${ORIGIN}/search?q=${encodeURIComponent(value)}`);
    return html === null ? [] : parseSearchResults(html);
  },

  async packageLookupUrl(packageName) {
    const value = cleanText(packageName);
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value)) return '';
    const html = await fetchPage(`${ORIGIN}/search?q=${encodeURIComponent(value)}`);
    if (html === null) return '';
    const app = parseSearchResults(html).find((item) => item.packageName === value);
    return app ? app.id : '';
  },

  async detailsMetadata(url) {
    const id = absoluteUrl(url);
    if (!isDetailUrl(id)) throw new TypeError('无效的 APKPure Lite 详情地址');
    return parseDetails(await fetchText(id), id);
  },

  async resolveDownloads(candidates, requestId) {
    const resolved = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      try {
        const downloads = parseDownloads(await fetchText(candidates[index].url, candidates[index].url.replace(/\/download$/, '')), candidates[index]);
        if (!downloads.length) throw new Error('APKPure download page did not expose a public APK/XAPK URL');
        resolved.push(...downloads);
        await progress(requestId, index, downloads, null);
      } catch (error) {
        await progress(requestId, index, [], error);
      }
    }
    return unique(resolved, 'url');
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
      const apps = await this.search(value, 1);
      return {title: '搜索完成', summary: `APKPure Lite 返回 ${apps.length} 条结果`, data: apps};
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {title: '详情读取完成', summary: `${app.name}：${app.downloads.length} 个下载项`, data: app};
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
