/** GetModsAPK source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://getmodsapk.com';
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  Referer: `${ORIGIN}/`,
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
};
const CATALOG_TABS = [
  {id: 'games', name: '游戏', path: '/games/'},
  {id: 'apps', name: '应用', path: '/apps/'},
];

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '})[entity.toLowerCase()] || `&${entity};`);
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

function normalizedPath(value) {
  const output = [];
  for (const part of String(value || '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') output.pop();
    else output.push(part);
  }
  return `/${output.join('/')}`;
}

function absoluteUrl(value, base = ORIGIN) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url.replace(/^http:\/\//i, 'https://');
  const origin = (/^(https?:\/\/[^/]+)/i.exec(base) || [null, ORIGIN])[1];
  if (url.startsWith('/')) return `${origin}${normalizedPath(url)}`;
  const basePath = String(base).replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
  return `${origin}${normalizedPath(`${basePath}${url}`)}`;
}

function isDetailUrl(url) {
  if (!/^https:\/\/(?:www\.)?getmodsapk\.com\/[^/?#]+\/?(?:[?#].*)?$/i.test(url || '')) return false;
  return !/^https:\/\/(?:www\.)?getmodsapk\.com\/(?:search|games|apps|download|about|contact|privacy-policy)\/?(?:[?#].*)?$/i.test(url || '');
}

function extractVersion(value) {
  const match = /\bv?(\d+(?:\.\d+)+(?:[-._][a-z0-9]+)*)\b/i.exec(textFromHtml(value));
  return match ? match[1] : '';
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(textFromHtml(value));
  return match ? match[0] : '';
}

function uniqueBy(items, key) {
  return items.filter((item, index, all) => item && all.findIndex((other) => other[key] === item[key]) === index);
}

async function fetchText(url, referer = ORIGIN) {
  return apkmesh.request(url, {headers: {...HEADERS, Referer: referer}});
}

function isNotFound(error) {
  return /\b(?:HTTP\s+|status(?:\s+code)?\s*[:=]?\s*)404\b/i.test(String(error && error.message || error || ''));
}

async function fetchPage(url, referer = ORIGIN) {
  try {
    return await fetchText(url, referer);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function parseCards(html) {
  const results = [];
  const pattern = /<a\b([^>]*class=["'][^"']*\brounded-xl\b[^"']*\bp-4\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const tag = `<a${match[1]}>`;
    const id = absoluteUrl(attribute(tag, 'href'));
    if (!isDetailUrl(id)) continue;
    const block = match[2];
    const title = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    const name = textFromHtml(title ? title[1] : '');
    if (!name) continue;
    const image = /<img\b[^>]*>/i.exec(block);
    const sizeMatch = /Size\s*:<\/span>\s*<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(block);
    const versionMatch = /<span\b[^>]*class=["'][^"']*text-xs[^"']*["'][^>]*>([\s\S]*?\bv?\d+(?:\.\d+)+[\s\S]*?)<\/span>/i.exec(block);
    const meta = textFromHtml(block);
    const categoryMatch = /<div\b[^>]*class=["'][^"']*text-sm[^"']*mt-1[^"']*["'][^>]*>\s*<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(block);
    results.push({
      id,
      name,
      packageName: '',
      version: extractVersion(versionMatch ? versionMatch[1] : meta),
      size: textFromHtml(sizeMatch ? sizeMatch[1] : '') || extractSize(meta),
      updatedAt: '',
      category: textFromHtml(categoryMatch ? categoryMatch[1] : ''),
      iconUrl: image ? absoluteUrl(attribute(image[0], 'src'), id) : '',
      summary: '',
    });
  }
  return uniqueBy(results, 'id');
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  return `${ORIGIN}/search?query=${encodeURIComponent(query)}${number > 1 ? `&page=${number}` : ''}`;
}

function catalogUrl(path, page) {
  const number = Math.max(1, Number(page) || 1);
  return `${ORIGIN}${path}${number > 1 ? `?page=${number}` : ''}`;
}

function hasNextPage(html, page) {
  const next = Math.max(1, Number(page) || 1) + 1;
  return new RegExp(`[?&]page=${next}(?:["'&]|$)`, 'i').test(html || '');
}

function firstMatch(html, pattern, group = 1) {
  const match = pattern.exec(html || '');
  return match ? textFromHtml(match[group]) : '';
}

function fieldValue(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<h3\\b[^>]*>\\s*${escaped}\\s*<\\/h3>\\s*(?:<p\\b[^>]*>([\\s\\S]*?)<\\/p>|<a\\b[^>]*>([\\s\\S]*?)<\\/a>)`, 'i').exec(html || '');
  return match ? textFromHtml(match[1] || match[2]) : '';
}

function parseDetails(html, url) {
  const canonical = firstMatch(html, /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || url;
  const headline = firstMatch(html, /<div\b[^>]*id=["']post-title["'][^>]*>[\s\S]*?<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const name = headline.replace(/\s+v?\d+(?:\.\d+)+.*$/i, '').trim();
  const version = fieldValue(html, 'Version').replace(/^v/i, '') || extractVersion(headline);
  const size = fieldValue(html, 'Size') || extractSize(html);
  const packageMatch = /play\.google\.com\/store\/apps\/details\?[^"']*\bid=([a-z0-9._]+)/i.exec(html || '');
  const iconBlock = /<div\b[^>]*id=["']post-thumbnail["'][^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  const icon = iconBlock ? /<img\b[^>]*>/i.exec(iconBlock[1]) : null;
  const descriptionMatch = /<div\b[^>]*class=["'][^"']*\bpost-content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  const descriptionHtml = descriptionMatch ? descriptionMatch[1] : '';
  const screenshots = [];
  for (const match of descriptionHtml.matchAll(/<img\b[^>]*>/gi)) {
    const image = absoluteUrl(attribute(match[0], 'src'), canonical);
    if (/^https:\/\/(?:www\.)?getmodsapk\.com\/storage\//i.test(image)) screenshots.push(image);
  }
  const downloadMatch = /<a\b[^>]*href=["']([^"']+\/download\/?)["'][^>]*>/i.exec(html || '');
  const downloadUrl = downloadMatch ? absoluteUrl(downloadMatch[1], canonical) : `${absoluteUrl(canonical).replace(/\/$/, '')}/download`;
  return {
    id: absoluteUrl(canonical),
    name,
    packageName: packageMatch ? packageMatch[1] : '',
    version,
    size,
    updatedAt: fieldValue(html, 'Last Updated'),
    category: fieldValue(html, 'Category'),
    iconUrl: icon ? absoluteUrl(attribute(icon[0], 'src'), canonical) : '',
    summary: firstMatch(html, /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i),
    description: textFromHtml(descriptionHtml),
    author: fieldValue(html, 'Publisher'),
    screenshots: uniqueBy(screenshots.map((value) => ({value})), 'value').map((item) => item.value),
    comments: [],
    downloadCandidates: [{label: `${name} ${version}`.trim(), url: downloadUrl, size}],
  };
}

function parseDownloadChoices(html, pageUrl) {
  const choices = [];
  const pattern = /<a\b([^>]*class=["'][^"']*\bdownload-links\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const url = absoluteUrl(attribute(`<a${match[1]}>`, 'href'), pageUrl);
    if (!/^https:\/\/(?:www\.)?getmodsapk\.com\/[^/?#]+\/download\/\d+\/?$/i.test(url)) continue;
    const prefix = String(html).slice(Math.max(0, match.index - 1800), match.index);
    const versions = [...prefix.matchAll(/\bv?\d+(?:\.\d+)+(?:[-._][a-z0-9]+)*/gi)];
    const version = versions.length ? versions[versions.length - 1][0].replace(/^v/i, '') : '';
    choices.push({url, version, size: extractSize(match[2])});
  }
  return uniqueBy(choices, 'url');
}

function parseFinalDownload(html, pageUrl, choice, candidate) {
  const match = /<a\b([^>]*\bid=["']download-button["'][^>]*)>([\s\S]*?)<\/a>/i.exec(html || '');
  if (!match) return null;
  const url = attribute(`<a${match[1]}>`, 'href');
  if (!/^https:\/\/files\.5modapk\.com\/[^?#]+\.(?:apk|xapk|apks|zip)(?:[?#]|$)/i.test(url)) return null;
  let fileName = url.split('/').pop().replace(/[?#].*$/, '');
  try {
    fileName = decodeURIComponent(fileName);
  } catch (_) {
    // Keep the encoded filename if the upstream URL is malformed.
  }
  return {
    label: cleanText(fileName.replace(/\.(?:apk|xapk|apks|zip)$/i, '').replace(/[-_]+/g, ' ')) || cleanText(candidate.label) || 'APK',
    url,
    size: choice.size || extractSize(match[2]) || cleanText(candidate.size),
    headers: {...HEADERS, Referer: pageUrl},
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
    id: 'getmodsapk',
    name: 'GetModsAPK',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 GetModsAPK 的公开搜索、目录、应用详情、截图和 APK 下载链接。',
    permissions: {network: ['getmodsapk.com', 'files.5modapk.com'], browser: false, download: true, install: false},
    debugProjects: [
      {id: 'search-keyword', name: '搜索关键词', description: '读取搜索结果及分页。', inputLabel: '关键词', placeholder: '例如 minecraft', defaultInput: 'minecraft'},
      {id: 'app-details', name: '获取应用详情', description: '读取元数据、截图和最终下载链接。', inputLabel: '详情 URL', placeholder: '粘贴 GetModsAPK 详情地址', defaultInput: 'https://getmodsapk.com/5472-youtube-premium-free-apk-mod/'},
      {id: 'catalog', name: '检查目录', description: '读取游戏和应用目录首页。', inputLabel: '标签数量上限', placeholder: '0 表示全部', defaultInput: '0'},
    ],
  },

  async catalog() {
    return {defaultTabId: 'games', tabs: CATALOG_TABS.map((tab) => ({id: tab.id, name: tab.name, paged: true}))};
  },

  async catalogPage(tabId, page = 1) {
    const tab = CATALOG_TABS.find((item) => item.id === tabId);
    if (!tab) throw new TypeError('无效的 GetModsAPK 目录标签');
    const html = await fetchPage(catalogUrl(tab.path, page));
    if (html === null) return {apps: [], hasMore: false};
    return {apps: parseCards(html), hasMore: hasNextPage(html, page)};
  },

  async search(query, page = 1) {
    const value = cleanText(query);
    if (value.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    const html = await fetchPage(searchUrl(value, page));
    return html === null ? [] : parseCards(html);
  },

  async detailsMetadata(idOrUrl) {
    const url = absoluteUrl(idOrUrl);
    if (!isDetailUrl(url)) throw new TypeError('无效的 GetModsAPK 详情地址');
    return parseDetails(await fetchText(url), url);
  },

  async resolveDownloads(candidates, requestId) {
    const resolved = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      const candidate = candidates[index];
      try {
        const pageUrl = absoluteUrl(candidate && candidate.url);
        if (!/^https:\/\/(?:www\.)?getmodsapk\.com\/[^/?#]+\/download\/?$/i.test(pageUrl)) throw new TypeError('无效的 GetModsAPK 下载页地址');
        const html = await fetchText(pageUrl, pageUrl.replace(/\/download\/?$/, '/'));
        const choices = parseDownloadChoices(html, pageUrl);
        const downloads = [];
        for (const choice of choices) {
          const finalHtml = await fetchText(choice.url, pageUrl);
          const download = parseFinalDownload(finalHtml, choice.url, choice, candidate);
          if (download) downloads.push(download);
        }
        const unique = uniqueBy(downloads, 'url');
        if (!unique.length) throw new Error('GetModsAPK 下载页未返回可用的 APK 直链');
        resolved.push(...unique);
        await reportProgress(requestId, index, unique, null);
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
