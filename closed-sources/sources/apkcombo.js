/** APKCombo source for APK Mesh. */
const ORIGIN = 'https://apkcombo.com';
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
  return /^https:\/\/apkcombo\.com\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_.]+\/?(?:[?#].*)?$/i.test(url || '');
}

function packageFromUrl(url) {
  return cleanText((url || '').split(/[?#]/)[0].split('/').filter(Boolean).pop());
}

function unique(items, key) {
  return items.filter((item, index, all) => item && all.findIndex((other) => other[key] === item[key]) === index);
}

function uniqueStrings(items) {
  return items.filter((item, index, all) => item && all.indexOf(item) === index);
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
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

function cardFromAnchor(tag, block, category = '') {
  const id = absoluteUrl(attribute(tag, 'href'));
  if (!isDetailUrl(id)) return null;
  const title = cleanText(attribute(tag, 'title').replace(/\s+APK(?:\s+Download)?$/i, ''));
  const nameMatch = /<span\b[^>]*class\s*=\s*["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(block || '');
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block || '');
  const name = cleanText((nameMatch && textFromHtml(nameMatch[1])) || title || (paragraph && textFromHtml(paragraph[1])));
  const image = /<img\b[^>]*>/i.exec(block || '');
  if (!name) return null;
  return {
    id,
    name,
    packageName: packageFromUrl(id),
    version: '',
    size: extractSize(block),
    updatedAt: '',
    category: cleanText(category),
    iconUrl: image ? absoluteUrl(attribute(image[0], 'data-src') || attribute(image[0], 'src')) : '',
  };
}

function parseSearchResults(html) {
  const results = [];
  for (const match of (html || '').matchAll(/<a\b([^>]*\bclass\s*=\s*["'][^"']*\bl_item\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
    results.push(cardFromAnchor(`<a${match[1]}>`, match[2]));
  }
  return unique(results.filter(Boolean), 'id');
}

function parseCatalogResults(html, category) {
  const results = [];
  for (const match of (html || '').matchAll(/<a\b([^>]*href\s*=\s*["'][^"']+["'][^>]*title\s*=\s*["'][^"']+\sAPK["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
    results.push(cardFromAnchor(`<a${match[1]}>`, match[2], category));
  }
  return unique(results.filter(Boolean), 'id').slice(0, 80);
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

function canonicalUrl(html, fallback = '') {
  const tag = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.exec(html || '');
  return absoluteUrl(tag ? attribute(tag[0], 'href') : fallback);
}

function parseScreenshots(html) {
  const gallery = /<div\b[^>]*id\s*=\s*["']gallery-screenshots["'][^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  if (!gallery) return [];
  return uniqueStrings([...gallery[1].matchAll(/<a\b[^>]*>/gi)]
    .map((match) => absoluteUrl(attribute(match[0], 'data-href')))
    .filter(Boolean));
}

function parseDetails(html, inputUrl) {
  const id = canonicalUrl(html, inputUrl);
  if (!isDetailUrl(id)) throw new Error('APKCombo detail page did not expose a valid canonical URL');
  const structured = parseStructuredApp(html);
  const header = /<div\b[^>]*class\s*=\s*["'][^"']*\bapp_header\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html || '');
  const name = cleanText(structured.name || (header && textFromHtml((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(header[1]) || [null, ''])[1])));
  const packageName = packageFromUrl(id);
  if (!name || !packageName) throw new Error('APKCombo detail page did not expose required app metadata');
  const downloadUrl = absoluteUrl(structured.installUrl || `${id.replace(/\/$/, '')}/download/apk`);
  return {
    id,
    name,
    packageName,
    version: cleanText(structured.softwareVersion),
    size: cleanText(structured.fileSize),
    updatedAt: cleanText(structured.dateModified || structured.datePublished),
    category: cleanText(structured.applicationSubCategory || structured.applicationCategory),
    iconUrl: absoluteUrl(structured.image || metaContent(html, 'og:image', 'property')),
    summary: cleanText(metaContent(html, 'description') || structured.description),
    description: cleanText(structured.description || metaContent(html, 'description')),
    screenshots: parseScreenshots(html),
    comments: [],
    downloadCandidates: downloadUrl ? [{label: `${name} ${cleanText(structured.fileFormat).includes('package-archive') ? 'APK' : 'Android package'}`, url: downloadUrl, size: cleanText(structured.fileSize)}] : [],
  };
}

function decodeDownloadUrl(href) {
  const match = /(?:[?&])u=([^&]+)/i.exec(decodeHtml(href));
  if (!match) return '';
  try {
    const url = decodeURIComponent(match[1]);
    return /^https:\/\/[^/]+\//i.test(url) ? url : '';
  } catch (_) {
    return '';
  }
}

function parseDownloads(html, candidate) {
  const downloads = [];
  for (const match of (html || '').matchAll(/<a\b([^>]*\bclass\s*=\s*["'][^"']*\bvariant\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = `<a${match[1]}>`;
    const url = decodeDownloadUrl(attribute(tag, 'href'));
    if (!url) continue;
    const type = cleanText((/<span\b[^>]*class\s*=\s*["'][^"']*\btype-[^"']+["'][^>]*>([\s\S]*?)<\/span>/i.exec(match[2]) || [null, ''])[1]);
    const version = cleanText((/<span\b[^>]*class\s*=\s*["'][^"']*\bvername\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(match[2]) || [null, ''])[1]);
    const specs = textFromHtml((/<div\b[^>]*class\s*=\s*["'][^"']*\bdescription\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(match[2]) || [null, ''])[1]);
    downloads.push({
      label: [version || candidate.label, type, specs].filter(Boolean).join(' · '),
      url,
      size: extractSize(specs) || cleanText(candidate.size),
      headers: {...HEADERS, Referer: candidate.url},
    });
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
  {id: `${ORIGIN}/category/game/`, name: '游戏', description: 'APKCombo 游戏榜单', paged: false, category: '游戏'},
  {id: `${ORIGIN}/category/app/`, name: '应用', description: 'APKCombo 应用榜单', paged: false, category: '应用'},
];

globalThis.source = {
  manifest: {
    id: 'apkcombo',
    name: 'APKCombo',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 APKCombo 公开搜索、榜单、详情、截图和 APK/XAPK 变体。',
    packageLookup: true,
    permissions: {
      network: ['*'],
      browser: false,
      download: true,
      install: false,
    },
    debugProjects: [
      {id: 'search-keyword', name: '搜索关键词', description: '检查 APKCombo 搜索与分页结果。', inputLabel: '关键词', placeholder: '例如 minecraft', defaultInput: 'minecraft'},
      {id: 'app-details', name: '获取应用详情', description: '读取元数据、截图和公开 APK/XAPK 变体。', inputLabel: '详情 URL', placeholder: '粘贴 apkcombo.com 详情 URL', defaultInput: 'https://apkcombo.com/minecraft-education-preview/com.mojang.minecraftedu_preview/'},
    ],
  },

  async catalog() {
    return {defaultTabId: CATALOG_TABS[0].id, tabs: CATALOG_TABS.map(({category, ...tab}) => tab)};
  },

  async catalogPage(tabId, page = 1) {
    const tab = CATALOG_TABS.find((item) => item.id === tabId);
    if (!tab) throw new TypeError('无效的 APKCombo 目录标签');
    if (Math.max(1, Number(page) || 1) > 1) return {apps: [], hasMore: false};
    const html = await fetchPage(tab.id);
    return {apps: html === null ? [] : parseCatalogResults(html, tab.category), hasMore: false};
  },

  async search(query, page = 1) {
    const value = cleanText(query);
    if (value.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    const number = Math.max(1, Number(page) || 1);
    if (number > 1) return [];
    const html = await fetchPage(`${ORIGIN}/search/${encodeURIComponent(value)}`);
    return html === null ? [] : parseSearchResults(html);
  },

  async packageLookupUrl(packageName) {
    const value = cleanText(packageName);
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value)) return '';
    const html = await fetchPage(`${ORIGIN}/search/${encodeURIComponent(value)}`);
    if (html === null) return '';
    const canonical = canonicalUrl(html);
    if (isDetailUrl(canonical) && packageFromUrl(canonical) === value) return canonical;
    const app = parseSearchResults(html).find((item) => item.packageName === value);
    return app ? app.id : '';
  },

  async detailsMetadata(url) {
    const id = absoluteUrl(url);
    if (!isDetailUrl(id)) throw new TypeError('无效的 APKCombo 详情地址');
    return parseDetails(await fetchText(id), id);
  },

  async resolveDownloads(candidates, requestId) {
    const resolved = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      try {
        const downloads = parseDownloads(await fetchText(candidates[index].url, candidates[index].url.replace(/\/download\/apk\/?$/, '')), candidates[index]);
        if (!downloads.length) throw new Error('APKCombo download page did not expose a public APK/XAPK URL');
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
      return {title: '搜索完成', summary: `APKCombo 返回 ${apps.length} 条结果`, data: apps};
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {title: '详情读取完成', summary: `${app.name}：${app.downloads.length} 个下载变体`, data: app};
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
