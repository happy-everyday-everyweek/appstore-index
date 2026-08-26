/** Uptodown source for APK Mesh. */
const ORIGIN = 'https://en.uptodown.com';
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
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

function absoluteUrl(value, base = ORIGIN) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  const origin = (/^https?:\/\/[^/]+/i.exec(base || '') || [ORIGIN])[0];
  return url.startsWith('/') ? `${origin}${url}` : `${origin}/${url}`;
}

function isDetailUrl(url) {
  return /^https:\/\/[a-z0-9-]+\.en\.uptodown\.com\/android\/?(?:[?#].*)?$/i.test(url || '');
}

function metaContent(html, key, property = 'name') {
  const pattern = new RegExp(`<meta\\b[^>]*\\b${property}\\s*=\\s*["']${key}["'][^>]*>`, 'i');
  const tag = pattern.exec(html || '');
  return tag ? attribute(tag[0], 'content') : '';
}

function firstAttribute(html, pattern, name) {
  const match = pattern.exec(html || '');
  return match ? attribute(match[0], name) : '';
}

function firstText(html, pattern) {
  const match = pattern.exec(html || '');
  return match ? textFromHtml(match[1]) : '';
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function tableValue(html, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<th\\b[^>]*>\\s*${escaped}\\s*<\\/th>\\s*<td\\b[^>]*>([\\s\\S]*?)<\\/td>`, 'i');
  return firstText(html, pattern);
}

function unique(items, key) {
  return items.filter((item, index, all) => item && all.findIndex((other) => other[key] === item[key]) === index);
}

function uniqueStrings(items) {
  return items.filter((item, index, all) => item && all.indexOf(item) === index);
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

function parseCards(html) {
  const results = [];
  const pattern = /<div\b([^>]*\bclass\s*=\s*["'][^"']*\bitem\b[^"']*["'][^>]*)>([\s\S]*?)(?=<div\b[^>]*\bclass\s*=\s*["'][^"']*\bitem\b|<\/div>\s*<\/div>\s*<div\s+id=["']button-list-more)/gi;
  for (const match of (html || '').matchAll(pattern)) {
    const opening = `<div${match[1]}>`;
    if (!attribute(opening, 'class').split(/\s+/).includes('item')) continue;
    const block = match[2];
    const link = /<div\b[^>]*class\s*=\s*["'][^"']*\bname\b[^"']*["'][^>]*>\s*<a\b[^>]*href\s*=\s*["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/i.exec(block) ||
      /<a\b[^>]*href\s*=\s*["'][^"']+["'][^>]*>[\s\S]*?<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i.exec(block);
    if (!link) continue;
    const id = absoluteUrl(attribute(link[0], 'href'));
    const name = textFromHtml(link[1]);
    if (!isDetailUrl(id) || !name) continue;
    const image = /<img\b[^>]*\bclass\s*=\s*["'][^"']*\bapp_card_img\b[^"']*["'][^>]*>/i.exec(block);
    results.push({
      id,
      name,
      packageName: '',
      version: '',
      size: '',
      updatedAt: '',
      category: 'Android',
      iconUrl: image ? absoluteUrl(attribute(image[0], 'src') || attribute(image[0], 'data-src')) : '',
    });
  }
  return unique(results, 'id');
}

function mapApiCards(payload) {
  if (!Array.isArray(payload)) throw new Error('Uptodown search endpoint returned invalid JSON');
  return unique(payload.map((item) => {
    const id = absoluteUrl(item && (item.appURL || item.url));
    if (!item || !isDetailUrl(id) || !cleanText(item.name)) return null;
    return {
      id,
      name: cleanText(item.name),
      packageName: '',
      version: '',
      size: '',
      updatedAt: '',
      category: cleanText(item.platformName || 'Android'),
      iconUrl: absoluteUrl(item.iconURL || ''),
    };
  }).filter(Boolean), 'id');
}

async function searchPage(query, page) {
  const number = Math.max(1, Number(page) || 1);
  if (number === 1) {
    const html = await fetchPage(`${ORIGIN}/android/search?query=${encodeURIComponent(query)}`);
    return html === null ? [] : parseCards(html);
  }
  const text = await fetchPage(
    `${ORIGIN}/android/apps/search?page=${number}&query=${encodeURIComponent(query)}`,
    `${ORIGIN}/android/search?query=${encodeURIComponent(query)}`,
  );
  if (text === null) return [];
  try {
    return mapApiCards(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Uptodown returned invalid search JSON: ${error}`);
    throw error;
  }
}

function parseJsonLd(html) {
  for (const match of (html || '').matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(match[1]);
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        const candidate = item && item.mainEntity ? item.mainEntity : item;
        const types = candidate && candidate['@type'];
        if (candidate && (types === 'MobileApplication' || (Array.isArray(types) && types.includes('MobileApplication')))) return candidate;
      }
    } catch (_) {
      // Ignore unrelated malformed structured-data blocks.
    }
  }
  return {};
}

function structuredScreenshots(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => absoluteUrl(typeof item === 'string' ? item : item && item.url)).filter(Boolean);
}

function parseDetails(html, inputUrl) {
  const structured = parseJsonLd(html);
  const canonical = absoluteUrl(firstAttribute(html, /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i, 'href') || inputUrl);
  if (!isDetailUrl(canonical)) throw new Error('Uptodown detail page did not expose a valid canonical URL');
  const name = cleanText(structured.name || firstText(html, /<h1\b[^>]*id\s*=\s*["']detail-app-name["'][^>]*>([\s\S]*?)<\/h1>/i));
  if (!name) throw new Error('Uptodown detail page did not expose an app name');
  const iconTag = /<div\b[^>]*class\s*=\s*["'][^"']*\bicon\b[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*>/i.exec(html || '');
  const downloadPage = absoluteUrl(firstAttribute(html, /<a\b[^>]*id\s*=\s*["']button-download-page-link["'][^>]*>/i, 'href'), canonical);
  const fileType = tableValue(html, 'File type').toUpperCase();
  return {
    id: canonical,
    name,
    packageName: tableValue(html, 'Package Name'),
    version: cleanText(structured.softwareVersion || firstText(html, /<div\b[^>]*class\s*=\s*["']version["'][^>]*>([\s\S]*?)<\/div>/i)),
    size: tableValue(html, 'Size'),
    updatedAt: tableValue(html, 'Date'),
    category: cleanText(structured.applicationSubCategory || tableValue(html, 'Category')),
    iconUrl: absoluteUrl(structured.image || (iconTag ? attribute(iconTag[0], 'src') : '')),
    summary: cleanText(metaContent(html, 'description') || structured.description),
    description: cleanText(structured.description || metaContent(html, 'description')),
    screenshots: uniqueStrings(structuredScreenshots(structured.screenshot)),
    comments: [...(html || '').matchAll(/<div\b[^>]*class\s*=\s*["'][^"']*\bcomment-content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)]
      .map((match) => textFromHtml(match[1])).filter(Boolean),
    downloadCandidates: downloadPage ? [{label: `${name} ${fileType || 'APK'}`, url: downloadPage, size: tableValue(html, 'Size'), fileType}] : [],
  };
}

async function resolveCandidate(candidate) {
  const html = await fetchText(candidate.url, candidate.url.replace(/\/download(?:[/?#].*)?$/i, ''));
  const button = /<button\b[^>]*id\s*=\s*["']detail-download-button["'][^>]*>/i.exec(html || '');
  if (!button) throw new Error('Uptodown download page did not expose a download button');
  const fileType = cleanText(candidate.fileType).toUpperCase();
  if (fileType && fileType !== 'APK') {
    throw new Error(`Uptodown serves ${fileType} through its installer; no standalone APK URL is public`);
  }
  const token = attribute(button[0], 'data-url');
  const external = absoluteUrl(attribute(button[0], 'data-url-ext'), candidate.url);
  const url = external || (token ? `https://dw.uptodown.com/dwn/${token}` : '');
  if (!/^https:\/\/(?:dw\.uptodown\.com|[^/]+\.en\.uptodown\.com)\//i.test(url)) {
    throw new Error('Uptodown returned an untrusted download URL');
  }
  return {label: candidate.label || 'APK', url, size: candidate.size || '', headers: {...HEADERS, Referer: candidate.url}};
}

async function progress(requestId, index, download, error) {
  if (!requestId) return;
  try {
    await apkmesh.detailProgress(requestId, {index, download: download || null, error: error ? String(error) : null});
  } catch (_) {
    // Progress delivery must not abort resolution.
  }
}

const CATALOG_TABS = [
  {id: `${ORIGIN}/android/latest-updates`, name: '最近更新', paged: false},
  {id: `${ORIGIN}/android/games`, name: '游戏', paged: false},
  {id: `${ORIGIN}/android/tools`, name: '工具', paged: false},
  {id: `${ORIGIN}/android/communication`, name: '通讯', paged: false},
  {id: `${ORIGIN}/android/productivity`, name: '效率', paged: false},
];

globalThis.source = {
  manifest: {
    id: 'uptodown',
    name: 'Uptodown',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 Uptodown 公开页面的 Android 搜索、目录、详情和 APK 下载项。',
    packageLookup: false,
    permissions: {
      network: ['en.uptodown.com', '*.en.uptodown.com', 'dw.uptodown.com'],
      browser: false,
      download: true,
      install: false,
    },
    debugProjects: [
      {id: 'search-keyword', name: '搜索关键词', description: '检查 Uptodown 搜索与分页结果。', inputLabel: '关键词', placeholder: '例如 minecraft', defaultInput: 'minecraft'},
      {id: 'app-details', name: '获取应用详情', description: '读取元数据、截图和公开 APK 下载链接。', inputLabel: '详情 URL', placeholder: '粘贴 *.en.uptodown.com/android URL', defaultInput: 'https://f-droid.en.uptodown.com/android'},
    ],
  },

  async catalog() {
    return {defaultTabId: CATALOG_TABS[0].id, tabs: CATALOG_TABS};
  },

  async catalogPage(tabId, page = 1) {
    const tab = CATALOG_TABS.find((item) => item.id === tabId);
    if (!tab) throw new TypeError('无效的 Uptodown 目录标签');
    if (Math.max(1, Number(page) || 1) > 1) return {apps: [], hasMore: false};
    const html = await fetchPage(tab.id);
    return {apps: html === null ? [] : parseCards(html), hasMore: false};
  },

  async search(query, page = 1) {
    const value = cleanText(query);
    if (value.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    return searchPage(value, page);
  },

  async detailsMetadata(url) {
    const id = absoluteUrl(url);
    if (!isDetailUrl(id)) throw new TypeError('无效的 Uptodown Android 详情地址');
    return parseDetails(await fetchText(id), id);
  },

  async resolveDownloads(candidates, requestId) {
    const downloads = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      try {
        const download = await resolveCandidate(candidates[index]);
        downloads.push(download);
        await progress(requestId, index, download, null);
      } catch (error) {
        await progress(requestId, index, null, error);
      }
    }
    return unique(downloads, 'url');
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
      return {title: '搜索完成', summary: `返回 ${apps.length} 条结果`, data: apps};
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {title: '详情读取完成', summary: `${app.name}：${app.downloads.length} 个 APK 下载项`, data: app};
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
