/** AN1 source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://an1.com';
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  Referer: `${ORIGIN}/`,
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
};
const CATALOG_TABS = [
  {id: 'games', name: '游戏', path: '/games/'},
  {id: 'apps', name: '应用', path: '/programmy/'},
  {id: 'mods', name: 'MOD', path: '/tags/mods/'},
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
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
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
  return /^https:\/\/(?:www\.)?an1\.com\/\d+-[^/?#]+\.html(?:[?#].*)?$/i.test(url || '');
}

function uniqueBy(items, key) {
  return items.filter((item, index, all) => item && all.findIndex((candidate) => candidate[key] === item[key]) === index);
}

function extractVersion(value) {
  const match = /\bv?(\d+(?:\.\d+)+(?:[-._][a-z0-9]+)*)\b/i.exec(cleanText(value));
  return match ? match[1] : '';
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
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
  const pattern = /<div\b[^>]*class=["'][^"']*\bitem_app\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bitem_app\b|<div\b[^>]*class=["'][^"']*\bnavigation\b|<\/article>|<\/main>|$)/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const block = match[1];
    const link = /<a\b([^>]*href=["'][^"']+\.html[^"']*["'][^>]*)>/i.exec(block);
    if (!link) continue;
    const id = absoluteUrl(attribute(`<a${link[1]}>`, 'href'));
    if (!isDetailUrl(id)) continue;
    const image = /<img\b[^>]*>/i.exec(block);
    const titleMatch = /<div\b[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const developerMatch = /<div\b[^>]*class=["'][^"']*\bdeveloper\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const name = cleanText(titleMatch ? titleMatch[1] : image ? attribute(image[0], 'alt') : '');
    if (!name) continue;
    results.push({
      id,
      name,
      packageName: '',
      version: '',
      size: '',
      updatedAt: '',
      category: cleanText(developerMatch ? developerMatch[1] : ''),
      iconUrl: image ? absoluteUrl(attribute(image[0], 'src')) : '',
      summary: '',
    });
  }
  return uniqueBy(results, 'id');
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  let url = `${ORIGIN}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
  if (number > 1) url += `&search_start=${number}&result_from=${(number - 1) * 10 + 1}`;
  return url;
}

function catalogUrl(path, page) {
  const number = Math.max(1, Number(page) || 1);
  return number > 1 ? `${ORIGIN}${path}page/${number}/` : `${ORIGIN}${path}`;
}

function hasNextPage(html) {
  return /<a\b[^>]*(?:name=["']nextlink["']|aria-label=["']Next|href=["'][^"']*\/page\/\d+\/)[^>]*>/i.test(html || '');
}

function firstMatch(html, pattern, group = 1) {
  const match = pattern.exec(html || '');
  return match ? cleanText(match[group]) : '';
}

function parseDetails(html, url) {
  const canonical = firstMatch(html, /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || url;
  const headline = firstMatch(html, /<h1\b[^>]*itemprop=["']headline["'][^>]*>([\s\S]*?)<\/h1>/i);
  const name = firstMatch(html, /<meta\b[^>]*itemprop=["']name["'][^>]*content=["']([^"']+)["']/i) ||
    headline.replace(/^Download\s+/i, '').replace(/\s+\d+(?:\.\d+)+\s+free on android.*$/i, '');
  const version = firstMatch(html, /itemprop=["']softwareVersion["'][^>]*>([\s\S]*?)<\/span>/i) || extractVersion(headline);
  const size = firstMatch(html, /itemprop=["']fileSize["'][^>]*>([\s\S]*?)<\/span>/i) || extractSize(html);
  const description = firstMatch(html, /<div\b[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/i);
  const category = firstMatch(html, /<a\b[^>]*href=["'][^"']*\/(?:games|programmy)\/[^"']+\/["'][^>]*itemprop=["']item["'][^>]*>[\s\S]*?<span\b[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/span>/i);
  const updatedAt = firstMatch(html, /<time\b[^>]*itemprop=["']datePublished["'][^>]*>([\s\S]*?)<\/time>/i);
  const iconTag = /<figure\b[^>]*class=["'][^"']*\bimg\b[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*>/i.exec(html || '');
  const packageMatch = /play\.google\.com\/store\/apps\/details\?id=([a-z0-9._]+)/i.exec(html || '');
  const screenshots = [];
  for (const match of String(html || '').matchAll(/<meta\b[^>]*itemprop=["']screenshot["'][^>]*content=["']([^"']+)["'][^>]*>/gi)) {
    const screenshot = absoluteUrl(match[1], canonical);
    if (/^https:\/\/(?:www\.)?an1\.com\/uploads\/screenshots\//i.test(screenshot)) screenshots.push(screenshot);
  }
  const downloadMatch = /<a\b([^>]*class=["'][^"']*\bdownload_line\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/i.exec(html || '') ||
    /<a\b([^>]*href=["'][^"']*\/file_\d+-dw\.html["'][^>]*)>([\s\S]*?)<\/a>/i.exec(html || '');
  const downloadPage = downloadMatch ? absoluteUrl(attribute(`<a${downloadMatch[1]}>`, 'href'), canonical) : '';
  return {
    id: absoluteUrl(canonical),
    name,
    packageName: packageMatch ? packageMatch[1] : '',
    version,
    size,
    updatedAt,
    category,
    iconUrl: iconTag ? absoluteUrl(attribute(iconTag[0], 'src'), canonical) : '',
    summary: firstMatch(html, /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i),
    description,
    screenshots: uniqueBy(screenshots.map((value) => ({value})), 'value').map((item) => item.value),
    comments: [],
    downloadCandidates: downloadPage ? [{label: `${name} ${version}`.trim(), url: downloadPage, size}] : [],
  };
}

function parseFinalDownloads(html, candidate) {
  const downloads = [];
  for (const match of String(html || '').matchAll(/<a\b([^>]*href=["']https:\/\/files\.an1\.(?:co|net)\/[^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = attribute(`<a${match[1]}>`, 'href');
    if (!/\.(?:apk|xapk|apks|zip)(?:[?#]|$)/i.test(url)) continue;
    if (/\/an1store\.apk(?:[?#]|$)/i.test(url)) continue;
    const text = cleanText(match[2]);
    const size = extractSize(text) || cleanText(candidate.size);
    const label = text.replace(/^Download\s*/i, '')
      .replace(/\(?\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b\)?/gi, '')
      .trim();
    downloads.push({
      label: label || cleanText(candidate.label) || 'APK',
      url,
      size,
      headers: {...HEADERS, Referer: cleanText(candidate.url)},
    });
  }
  return uniqueBy(downloads, 'url');
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
    // Progress reporting must not abort link resolution.
  }
}

globalThis.source = {
  manifest: {
    id: 'an1',
    name: 'AN1',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 AN1 的公开搜索、目录、应用详情、截图和 APK 下载链接。',
    permissions: {
      network: ['an1.com', 'files.an1.net', 'files.an1.co'],
      browser: false,
      download: true,
      install: false,
    },
    debugProjects: [
      {
        id: 'search-keyword', name: '搜索关键词',
        description: '读取 AN1 搜索结果及分页。',
        inputLabel: '关键词', placeholder: '例如 minecraft', defaultInput: 'minecraft',
      },
      {
        id: 'app-details', name: '获取应用详情',
        description: '读取元数据、截图和最终 APK 直链。',
        inputLabel: '详情 URL', placeholder: '粘贴 AN1 详情地址',
        defaultInput: 'https://an1.com/4718-war-machines.html',
      },
      {
        id: 'catalog', name: '检查目录',
        description: '读取游戏、应用和 MOD 目录首页。',
        inputLabel: '标签数量上限', placeholder: '0 表示全部', defaultInput: '0',
      },
    ],
  },

  async catalog() {
    return {
      defaultTabId: 'games',
      tabs: CATALOG_TABS.map((tab) => ({id: tab.id, name: tab.name, paged: true})),
    };
  },

  async catalogPage(tabId, page = 1) {
    const tab = CATALOG_TABS.find((item) => item.id === tabId);
    if (!tab) throw new TypeError('无效的 AN1 目录标签');
    const html = await fetchPage(catalogUrl(tab.path, page));
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
    const url = absoluteUrl(idOrUrl);
    if (!isDetailUrl(url)) throw new TypeError('无效的 AN1 详情地址');
    return parseDetails(await fetchText(url), url);
  },

  async resolveDownloads(candidates, requestId) {
    const resolved = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      const candidate = candidates[index];
      try {
        const url = absoluteUrl(candidate && candidate.url);
        if (!/^https:\/\/(?:www\.)?an1\.com\/file_\d+-dw\.html$/i.test(url)) {
          throw new TypeError('无效的 AN1 下载页地址');
        }
        const downloads = parseFinalDownloads(await fetchText(url, url), {...candidate, url});
        if (!downloads.length) throw new Error('AN1 下载页未返回可用的 APK 直链');
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
      return {
        title: '详情读取完成',
        summary: `已读取 ${app.name}；下载项 ${app.downloads.length} 个`,
        data: app,
      };
    }
    if (projectId === 'catalog') {
      const catalog = await this.catalog();
      const limit = Math.max(0, Number(value) || 0);
      const tabs = [];
      for (const tab of (limit ? catalog.tabs.slice(0, limit) : catalog.tabs)) {
        const page = await this.catalogPage(tab.id, 1);
        tabs.push({id: tab.id, apps: page.apps.length, hasMore: page.hasMore});
      }
      return {title: '目录检查完成', summary: `检查 ${tabs.length} 个标签`, data: {tabs}};
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
