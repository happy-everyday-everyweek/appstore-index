/** PlayMods public-page source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://playmods.net';
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  Referer: `${ORIGIN}/`,
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
};
const CATALOG_TABS = [
  {id: 'games', name: '游戏', paged: true, path: '/game/category/all/newest-mod'},
  {id: 'apps', name: '应用', paged: true, path: '/apps/category/all/newest'},
];

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

function absoluteUrl(value, baseUrl = ORIGIN) {
  const url = cleanText(value);
  if (!url || /^javascript:|^data:/i.test(url)) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url.replace(/^http:\/\//i, 'https://');
  const origin = (/^https?:\/\/[^/]+/i.exec(baseUrl) || [ORIGIN])[0];
  if (url.startsWith('/')) return `${origin}${url}`;
  const directory = String(baseUrl).replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
  return `${directory}${url}`;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(cleanText(value));
}

function normalizeDetailUrl(value) {
  const url = absoluteUrl(value).replace(/[?#].*$/, '').replace(/\/+$/, '');
  const match = /^https:\/\/(?:www\.)?playmods\.net((?:\/[^/]+)*)$/i.exec(url);
  if (!match) return '';
  const path = /^(?:\/(?:pt|tr|ar|vi|es|th|id|ru|it|hi|de|fr|zh|tw|ja|ko))?\/(game|apps)\/([^/]+)\/([^/]+)$/i.exec(match[1]);
  if (!path) return '';
  return `${ORIGIN}/${path[1].toLowerCase()}/${path[2]}/${path[3]}`;
}

function isDownloadPage(value) {
  const url = absoluteUrl(value).replace(/[?#].*$/, '').replace(/\/+$/, '');
  return /^https:\/\/(?:www\.)?playmods\.net\/(?:game|apps)\/[^/]+\/[^/]+\/download$/i.test(url);
}

function extractVersion(value) {
  const match = /\bv?(\d+(?:\.\d+)+(?:[-._][a-z0-9]+)*)\b/i.exec(textFromHtml(value));
  return match ? match[1] : '';
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(textFromHtml(value));
  return match ? match[0].replace(/\s+/g, '') : '';
}

function uniqueBy(items, field) {
  return items.filter((item, index, all) => item && item[field] &&
    all.findIndex((candidate) => candidate && candidate[field] === item[field]) === index);
}

function firstMatch(html, pattern, group = 1) {
  const match = pattern.exec(html || '');
  return match ? textFromHtml(match[group]) : '';
}

function metaContent(html, name, attributeName = 'name') {
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  const tag = tags.find((item) => cleanText(attribute(item, attributeName)).toLowerCase() === name.toLowerCase());
  return tag ? cleanText(attribute(tag, 'content')) : '';
}

function imageFromHtml(html, baseUrl) {
  const tag = /<img\b[^>]*>/i.exec(html || '');
  if (!tag) return '';
  for (const name of ['data-src', 'data-lazy-src', 'data-original', 'data-tacitly-src', 'src']) {
    const url = absoluteUrl(attribute(tag[0], name), baseUrl);
    if (isTrustedImage(url) && !/game-(?:tacitly|printscreen)-icon/i.test(url)) return url;
  }
  return '';
}

function isTrustedImage(value) {
  return /^https:\/\/(?:[a-z0-9-]+\.)*(?:niceapkdown\.shop|playmods\.net)\//i.test(value || '');
}

function parseCards(html) {
  const chunks = String(html || '').split(/<div\b[^>]*class=["']\s*media-item\s*["'][^>]*>/i).slice(1);
  const apps = [];
  for (const block of chunks) {
    const link = /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<h2\b|<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["']/i.exec(block);
    const rawUrl = link ? (link[1] || link[2]) : '';
    const id = normalizeDetailUrl(rawUrl);
    if (!id) continue;
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
    if (!heading) continue;
    const summary = firstMatch(heading[1], /<span\b[^>]*class=["'][^"']*\bcommon-game-combination-name\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const name = textFromHtml(heading[1].replace(/<span\b[^>]*class=["'][^"']*\bcommon-game-combination-name\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, ''));
    if (!name) continue;
    const metadata = firstMatch(block, /<p\b[^>]*class=["'][^"']*\bmedia-item-content-opts\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    const category = firstMatch(block, /<p\b[^>]*class=["'][^"']*\bmedia-item-content-desc\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    apps.push({
      id,
      name,
      packageName: '',
      version: extractVersion(metadata),
      size: extractSize(metadata),
      updatedAt: '',
      category,
      iconUrl: imageFromHtml(block.slice(0, 5000), id),
      summary,
    });
  }
  return uniqueBy(apps, 'id');
}

function hasNextPage(html) {
  return /<link\b[^>]*rel=["']next["'][^>]*>|<a\b[^>]*rel=["']next["'][^>]*>/i.test(html || '');
}

function isNotFound(error) {
  return /\b(?:HTTP\s+|status(?:\s+code)?\s*[:=]?\s*)404\b/i.test(String(error && error.message || error || ''));
}

async function fetchPage(url, referer = ORIGIN) {
  try {
    return await apkmesh.request(url, {headers: {...HEADERS, Referer: referer}});
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  const suffix = number > 1 ? `?page=${number}` : '';
  return `${ORIGIN}/search/${encodeURIComponent(query)}${suffix}`;
}

function catalogUrl(tab, page) {
  const number = Math.max(1, Number(page) || 1);
  return `${ORIGIN}${tab.path}${number > 1 ? `?page=${number}` : ''}`;
}

function parseDetails(html, requestedUrl) {
  const canonicalTag = (String(html || '').match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i) || [])[0] || '';
  const canonical = normalizeDetailUrl(attribute(canonicalTag, 'href')) || requestedUrl;
  const header = firstMatch(html, /<h1\b[^>]*class=["'][^"']*\bmedia-item-content1-name\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
  const nameMatch = /<span\b[^>]*class=["'][^"']*\bappName\b[^"']*["'][^>]*>\s*<span\b[^>]*>[\s\S]*?<\/span>\s*([^<]+?)\s*<\/span>/i.exec(html || '');
  const name = cleanText(nameMatch ? nameMatch[1] : header
    .replace(/\s+(?:Mod\s+)?Apk\b[\s\S]*$/i, '')
    .replace(/\s+v?\d+(?:\.\d+)+[\s\S]*$/i, ''));
  const versionBlock = /<div\b[^>]*class=["'][^"']*\bmedia-item-version1\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  const version = extractVersion(versionBlock ? versionBlock[1] : header);
  const updatedAt = firstMatch(versionBlock ? versionBlock[1] : '', /<span\b[^>]*class=["'][^"']*\boperate-cstTime\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ||
    metaContent(html, 'article:modified_time', 'property');
  const size = firstMatch(html, /<a\b[^>]*class=["'][^"']*\bbtn-download1\b[^"']*\bptn\b[^"']*["'][^>]*>[\s\S]*?\(([^)]+)\)/i) || extractSize(html);
  const category = firstMatch(html, /Category\s*:\s*<a\b[^>]*>[\s\S]*?<strong\b[^>]*>([\s\S]*?)<\/strong>/i);
  const iconBlock = /<div\b[^>]*class=["'][^"']*\bmedia-item-pic1\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  const descriptionBlock = /<div\b[^>]*class=["'][^"']*\boperate-dsep-content\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bdetail-sec\b[^"']*\boperate-display\b)/i.exec(html || '');
  const screenshotBlock = /<div\b[^>]*class=["'][^"']*\bdetail-screenshot\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bdetail-sec\b)/i.exec(html || '');
  const screenshots = [];
  for (const tag of String(screenshotBlock ? screenshotBlock[1] : '').match(/<img\b[^>]*>/gi) || []) {
    const image = imageFromHtml(tag, canonical);
    if (image) screenshots.push({url: image});
  }
  const summary = metaContent(html, 'description');
  const packageMatch = /,\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\s*$/i.exec(summary);
  const downloadLink = /<a\b[^>]*href=["']([^"']+\/download)["'][^>]*class=["'][^"']*(?:\bdownload-layer-pt\b|\bbtn-download1\b[^"']*\bptn\b)[^"']*["']/i.exec(html || '') ||
    /<a\b[^>]*class=["'][^"']*(?:\bdownload-layer-pt\b|\bbtn-download1\b[^"']*\bptn\b)[^"']*["'][^>]*href=["']([^"']+\/download)["']/i.exec(html || '');
  const downloadUrl = downloadLink ? absoluteUrl(downloadLink[1], canonical) : `${canonical}/download`;
  return {
    id: canonical,
    name,
    packageName: packageMatch ? packageMatch[1] : '',
    version,
    size: extractSize(size),
    updatedAt,
    category,
    iconUrl: imageFromHtml(iconBlock ? iconBlock[1] : '', canonical) || metaContent(html, 'og:image', 'property'),
    summary,
    description: textFromHtml(descriptionBlock ? descriptionBlock[1] : ''),
    screenshots: uniqueBy(screenshots, 'url').map((item) => item.url),
    comments: [],
    downloadCandidates: isDownloadPage(downloadUrl) ? [{
      label: `${name} ${version}`.trim() || 'APK',
      url: downloadUrl,
      size: extractSize(size),
    }] : [],
  };
}

function parseDownload(html, candidate) {
  const tag = (String(html || '').match(/<script\b[^>]*id=["']downloadStatejs_id["'][^>]*>/i) || [])[0] || '';
  if (!tag) throw new Error('PlayMods 下载页缺少版本数据');
  const type = cleanText(attribute(tag, 'fileType')).toLowerCase();
  const downloadType = cleanText(attribute(tag, 'downloadType'));
  const versionId = cleanText(attribute(tag, 'versionId'));
  const resourceUrl = absoluteUrl(attribute(tag, 'resourceUrl'), candidate.url);
  let url = '';
  if (downloadType === '0' && /^\d+$/.test(versionId) && /^(?:apk|xapk|apks)$/i.test(type)) {
    url = `${ORIGIN}/download/version/${versionId}?scheme=https`;
  } else if (isHttpUrl(resourceUrl)) {
    url = resourceUrl;
  }
  if (!url) throw new Error('PlayMods 下载页未提供可用的 APK 链接');
  return {
    label: `${cleanText(candidate.label) || 'PlayMods'}${type ? ` (${type.toUpperCase()})` : ''}`,
    url,
    size: cleanText(candidate.size),
    headers: {...HEADERS, Accept: 'application/octet-stream,*/*;q=0.8', Referer: candidate.url},
  };
}

async function reportProgress(requestId, index, downloads, error) {
  if (!requestId) return;
  try {
    await apkmesh.detailProgress(requestId, {
      index,
      downloads: downloads || [],
      error: error ? String(error && error.message || error) : null,
    });
  } catch (_) {
    // Progress delivery must not hide the resolver result.
  }
}

globalThis.source = {
  manifest: {
    id: 'playmods',
    name: 'PlayMods',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 PlayMods 公开搜索、分类、详情和下载页；下载会跳转到站点动态 CDN。',
    permissions: {network: ['*'], browser: false, download: true, install: false},
    debugProjects: [
      {id: 'search-keyword', name: '搜索关键词', description: '读取 PlayMods 搜索结果及分页。', inputLabel: '关键词', placeholder: '例如 minecraft', defaultInput: 'minecraft'},
      {id: 'app-details', name: '获取应用详情', description: '读取元数据、截图并解析公开下载页。', inputLabel: '详情 URL', placeholder: '粘贴 PlayMods 应用或游戏 URL', defaultInput: 'https://playmods.net/game/minecraft(invincible)/com.mojang.minecraftpe'},
      {id: 'catalog', name: '检查目录', description: '读取游戏和应用分类首页。', inputLabel: '标签数量上限', placeholder: '0 表示全部', defaultInput: '0'},
    ],
  },

  async catalog() {
    return {defaultTabId: 'games', tabs: CATALOG_TABS.map(({id, name, paged}) => ({id, name, paged}))};
  },

  async catalogPage(tabId, page = 1) {
    const tab = CATALOG_TABS.find((item) => item.id === tabId);
    if (!tab) throw new TypeError('无效的 PlayMods 目录标签');
    const html = await fetchPage(catalogUrl(tab, page));
    if (html === null) return {apps: [], hasMore: false};
    return {apps: parseCards(html), hasMore: hasNextPage(html)};
  },

  async search(query, page = 1) {
    const value = cleanText(query);
    if (value.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    const html = await fetchPage(searchUrl(value, page));
    return html === null ? [] : parseCards(html);
  },

  async detailsMetadata(idOrUrl) {
    const url = normalizeDetailUrl(idOrUrl);
    if (!url) throw new TypeError('无效的 PlayMods 详情地址');
    const html = await fetchPage(url);
    if (html === null) throw new Error('PlayMods 详情页不存在');
    const app = parseDetails(html, url);
    if (!app.name) throw new Error('PlayMods 详情页未返回应用名称');
    return app;
  },

  async resolveDownloads(candidates, requestId) {
    const resolved = [];
    const errors = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      const candidate = candidates[index];
      try {
        if (!candidate || !isDownloadPage(candidate.url)) throw new TypeError('无效的 PlayMods 下载页地址');
        const html = await fetchPage(candidate.url, candidate.url.replace(/\/download$/, ''));
        if (html === null) throw new Error('PlayMods 下载页不存在');
        const downloads = [parseDownload(html, candidate)];
        resolved.push(...downloads);
        await reportProgress(requestId, index, downloads, null);
      } catch (error) {
        errors.push(error);
        await reportProgress(requestId, index, [], error);
      }
    }
    const downloads = uniqueBy(resolved, 'url');
    if (!downloads.length && errors.length) throw errors[0];
    return downloads;
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
