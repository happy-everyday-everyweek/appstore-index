/** APKTodo metadata source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://apktodo.io';
const RECOMMENDED_TAB_ID = 'recommended';
const SEARCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  Referer: `${ORIGIN}/`,
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => ({
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
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

function attribute(tag, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escapedName}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i').exec(tag || '');
  return match ? decodeHtml(match[2]).trim() : '';
}

function resolveUrl(url, baseUrl) {
  const value = cleanText(url);
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  const base = /^https?:\/\/[^/]+/i.exec(baseUrl || '');
  const origin = base ? base[0] : ORIGIN;
  return value.startsWith('/') ? `${origin}${value}` : `${origin}/${value}`;
}

function absoluteUrl(url) {
  return resolveUrl(url, ORIGIN);
}

function isApkTodoUrl(url) {
  return /^https:\/\/(?:apktodo\.io|[^/.]+\.apktodo\.io)\//i.test(`${url}/`);
}

function imageUrl(block) {
  const imageMatch = /<img\b[^>]*>/i.exec(block || '');
  if (!imageMatch) return '';
  for (const name of ['data-src', 'data-lazy-src', 'data-original', 'src']) {
    const value = attribute(imageMatch[0], name);
    if (value && !/no-image/i.test(value)) return absoluteUrl(value);
  }
  return '';
}

function extractVersion(value) {
  const match = /\bv?\d+(?:\.\d+)+(?:[A-Za-z][\w.-]*)?/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function parseSearchResults(html) {
  const entries = [];
  const pattern = /<a\b([^>]*\bclass\s*=\s*['"][^'"]*\bblog\b[^'"]*\bsearch\b[^'"]*['"][^>]*)>([\s\S]*?)<\/a>\s*<\/li>/gi;
  for (const match of html.matchAll(pattern)) {
    const openingTag = `<a${match[1]}>`;
    const id = absoluteUrl(attribute(openingTag, 'href'));
    if (!isApkTodoUrl(id)) continue;
    const block = match[2];
    const titleMatch = /<div\b[^>]*\bclass\s*=\s*['"][^'"]*\btitle\b[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const timeMatch = /<time\b[^>]*>/i.exec(block);
    const name = cleanText(titleMatch ? titleMatch[1] : attribute(openingTag, 'title'));
    if (!name) continue;
    entries.push({
      id,
      name,
      packageName: '',
      version: '',
      size: '',
      updatedAt: timeMatch ? attribute(timeMatch[0], 'datetime') : '',
      category: '',
      iconUrl: imageUrl(block),
    });
  }
  return entries;
}

function parseGridResults(html) {
  const entries = [];
  const pattern = /<a\b([^>]*\bclass\s*=\s*['"][^'"]*\bapk_new\b[^'"]*['"][^>]*)>([\s\S]*?)<\/a>\s*<\/li>/gi;
  for (const match of html.matchAll(pattern)) {
    const openingTag = `<a${match[1]}>`;
    const id = absoluteUrl(attribute(openingTag, 'href'));
    if (!isApkTodoUrl(id)) continue;
    const block = match[2];
    const titleMatch = /<h3\b[^>]*\bclass\s*=\s*['"][^'"]*\btitle\b[^'"]*['"][^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    const categoryMatch = /<div\b[^>]*\bclass\s*=\s*['"][^'"]*\bcategory\b[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const metaMatch = /<div\b[^>]*\bclass\s*=\s*['"][^'"]*\bmeta\b[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const versionMatch = /<span\b[^>]*\bclass\s*=\s*['"][^'"]*\btext_meta\b[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i.exec(block);
    const meta = metaMatch ? textFromHtml(metaMatch[1]) : '';
    const name = cleanText(titleMatch ? titleMatch[1] : attribute(openingTag, 'title'));
    if (!name) continue;
    entries.push({
      id,
      name,
      packageName: '',
      version: extractVersion(versionMatch ? versionMatch[1] : meta),
      size: extractSize(meta),
      updatedAt: '',
      category: cleanText(categoryMatch ? categoryMatch[1] : ''),
      iconUrl: imageUrl(block),
    });
  }
  return entries;
}

function parseIconResults(html) {
  const entries = [];
  const pattern = /<a\b([^>]*\bclass\s*=\s*['"][^'"]*\bapk-icon\b[^'"]*['"][^>]*)>([\s\S]*?)<\/a>\s*<\/li>/gi;
  for (const match of html.matchAll(pattern)) {
    const openingTag = `<a${match[1]}>`;
    const id = absoluteUrl(attribute(openingTag, 'href'));
    if (!isApkTodoUrl(id)) continue;
    const block = match[2];
    const titleMatch = /<p\b[^>]*\bclass\s*=\s*['"][^'"]*\btitle\b[^'"]*['"][^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const categoryMatch = /<p\b[^>]*\bclass\s*=\s*['"][^'"]*\bcate\b[^'"]*['"][^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const versionMatch = /<div\b[^>]*\bclass\s*=\s*['"][^'"]*\bctVersion\b[^'"]*['"][^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const sizeMatch = /<div\b[^>]*\bclass\s*=\s*['"][^'"]*\bctSize\b[^'"]*['"][^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const name = cleanText(titleMatch ? titleMatch[1] : attribute(openingTag, 'title'));
    if (!name) continue;
    entries.push({
      id,
      name,
      packageName: '',
      version: extractVersion(versionMatch ? versionMatch[1] : ''),
      size: extractSize(sizeMatch ? sizeMatch[1] : ''),
      updatedAt: '',
      category: cleanText(categoryMatch ? categoryMatch[1] : ''),
      iconUrl: imageUrl(block),
    });
  }
  return entries;
}

function rowField(rows, label) {
  const expected = cleanText(label).toLowerCase();
  const row = rows.find((item) => cleanText(item.label).toLowerCase() === expected);
  return row ? cleanText(row.value) : '';
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  const suffix = number > 1 ? `&page=${number}` : '';
  return `${ORIGIN}/?s=${encodeURIComponent(query)}${suffix}`;
}

function catalogPageUrl(tabId, page) {
  const number = Math.max(1, Number(page) || 1);
  const base = absoluteUrl(tabId).replace(/\/+$/, '');
  return number > 1 ? `${base}/page/${number}/` : `${base}/`;
}

function hasNextPage(html) {
  return /\brel\s*=\s*['"]next['"]/i.test(html || '') ||
    /\bclass\s*=\s*['"][^'"]*\bnext\b[^'"]*['"]/i.test(html || '');
}

async function fetchText(url, referer = ORIGIN) {
  return apkmesh.request(url, {
    headers: {...SEARCH_HEADERS, Referer: referer},
  });
}

function isNotFoundError(error) {
  const message = error && error.message ? error.message : String(error || '');
  return /\bHTTP\s+404\b/i.test(message) ||
    /\bstatus(?:\s+code)?\s*[:=]?\s*404\b/i.test(message);
}

async function fetchSearchText(url) {
  try {
    return await fetchText(url);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function downloadHeaders(referer) {
  return {...SEARCH_HEADERS, Referer: referer};
}

function isApkDownloadUrl(url) {
  if (/^https:\/\/files\.apktodo\.store\/[^?#]+\.(?:apk|apks|xapk|zip)(?:[?#]|$)/i.test(url)) {
    return true;
  }
  return /^https:\/\/(?:www\.)?apktodo\.net\/download\/mod\/[^?#]+/i.test(url);
}

function isApkTodoLandingUrl(url) {
  return /^https:\/\/(?:www\.)?apktodo\.net\/(?!download(?:\/|$))[^?#]+\/?$/i.test(url);
}

function isPcDownloadPage(html) {
  return /\bfor\s+PC\b/i.test(textFromHtml(html));
}

function downloadLabel(value) {
  return cleanText(value)
    .replace(/^Download\s+/i, '')
    .replace(/\s*\[[^\]]+\]\s*$/, '')
    .trim() || 'APK';
}

function parseDownloadTargets(html, referer) {
  const entries = [];
  function addTarget(openingTag, body) {
    const url = resolveUrl(attribute(openingTag, 'href'), referer);
    if (!url) return;
    const text = textFromHtml(body);
    entries.push({
      label: downloadLabel(text),
      url,
      size: extractSize(text),
      text,
      headers: downloadHeaders(referer),
    });
  }

  const anchorPattern = /<a\b([^>]*\bclass\s*=\s*['"][^'"]*\bitem-apk\b[^'"]*['"][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    addTarget(`<a${match[1]}>`, match[2]);
  }

  const containerPattern = /<div\b([^>]*\bclass\s*=\s*['"][^'"]*\bitem-apk\b[^'"]*['"][^>]*)>([\s\S]*?)<\/div>/gi;
  for (const match of html.matchAll(containerPattern)) {
    const anchorMatch = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(match[2]);
    if (anchorMatch) addTarget(`<a${anchorMatch[1]}>`, anchorMatch[2]);
  }
  return entries;
}

function parseDownloadLinks(html, referer) {
  if (isPcDownloadPage(html)) return [];
  return parseDownloadTargets(html, referer)
      .filter((item) => isApkDownloadUrl(item.url))
      .map((item) => ({
        label: item.label,
        url: item.url,
        size: item.size,
        headers: item.headers,
      }));
}

function uniqueDownloads(items) {
  return items.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.url === item.url) === index,
  );
}

function fallbackLandingUrls(downloadPage, appName) {
  const urls = [];
  let normalizedName = cleanText(appName).toLowerCase();
  try {
    normalizedName = normalizedName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (_) {
    // Older QuickJS builds can continue with the original name.
  }
  const nameSlug = normalizedName
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (nameSlug) urls.push(`https://apktodo.net/${nameSlug}/`);
  const hostMatch = /^https:\/\/([a-z0-9-]+)\.apktodo\.io\//i.exec(downloadPage || '');
  if (!urls.length && hostMatch) {
    urls.push(`https://apktodo.net/${hostMatch[1].toLowerCase()}/`);
  }
  return urls;
}

async function fetchOptionalText(url, referer) {
  try {
    return await fetchText(url, referer);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function downloadsFromLanding(landingUrl, referer) {
  const landingHtml = await fetchOptionalText(landingUrl, referer);
  if (landingHtml === null) return [];
  const landingLink = /<div\b[^>]*\bclass\s*=\s*['"][^'"]*\bbtn_download\b[^'"]*['"][^>]*>[\s\S]*?<a\b([^>]*)>/i.exec(landingHtml);
  if (!landingLink) return [];
  const landingTag = `<a${landingLink[1]}>`;
  const landingDownloadUrl = resolveUrl(attribute(landingTag, 'href'), landingUrl);
  if (!/^https:\/\/(?:www\.)?apktodo\.net\/download\//i.test(landingDownloadUrl)) return [];
  const downloadHtml = await fetchOptionalText(landingDownloadUrl, landingUrl);
  return downloadHtml === null ? [] : parseDownloadLinks(downloadHtml, landingDownloadUrl);
}

async function resolveDownloadPage(candidate) {
  const downloadPage = cleanText(candidate && candidate.url);
  if (!downloadPage) return [];
  const prepareHtml = await fetchText(downloadPage, downloadPage);
  const linkMatch = /<div\b[^>]*\bid\s*=\s*['"]download-container['"][^>]*>[\s\S]*?<a\b([^>]*)>/i.exec(prepareHtml);
  if (!linkMatch) return [];
  const downloadTag = `<a${linkMatch[1]}>`;
  const downloadUrl = resolveUrl(attribute(downloadTag, 'href'), downloadPage);
  if (!downloadUrl) return [];

  const downloadHtml = await fetchText(downloadUrl, downloadUrl);
  const downloads = parseDownloadLinks(downloadHtml, downloadUrl);
  const landingUrls = parseDownloadTargets(downloadHtml, downloadUrl)
    .filter((item) => isApkTodoLandingUrl(item.url))
    .map((item) => item.url);
  if (!downloads.length && !landingUrls.length) {
    landingUrls.push(...fallbackLandingUrls(downloadPage, candidate.label));
  }

  for (const landingUrl of landingUrls.filter((url, index, all) => all.indexOf(url) === index)) {
    downloads.push(...await downloadsFromLanding(landingUrl, downloadUrl));
  }
  return uniqueDownloads(downloads);
}

function parseStructuredData(nodes) {
  for (const node of nodes || []) {
    try {
      const value = JSON.parse(cleanText(node.text));
      if (value && (value['@type'] === 'MobileApplication' || value['@type'] === 'SoftwareApplication')) {
        return value;
      }
    } catch (_) {
      // A page can contain unrelated or malformed JSON-LD blocks.
    }
  }
  return {};
}

function uniqueStrings(values) {
  return values.filter((value, index, all) => value && all.indexOf(value) === index);
}

async function reportDetailProgress(requestId, index, downloads, error) {
  if (!requestId) return;
  try {
    await apkmesh.detailProgress(requestId, {
      index,
      downloads: downloads || [],
      error: error ? String(error) : null,
    });
  } catch (_) {
    // Progress delivery must not abort link resolution.
  }
}

const CATALOG_TABS = [
  {id: RECOMMENDED_TAB_ID, name: '推荐', paged: false},
  {id: `${ORIGIN}/games/`, name: '游戏', description: 'Android 游戏', paged: true},
  {id: `${ORIGIN}/apps/`, name: '应用', description: 'Android 应用', paged: true},
];

globalThis.source = {
  manifest: {
    id: 'apktodo',
    name: 'APKTodo',
    version: '1.2.1',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 APKTodo 应用元数据、截图、详情和下载项。',
    permissions: {
      network: ['*'],
      browser: true,
      download: true,
      install: true,
    },
    debugProjects: [
      {
        id: 'search-keyword',
        name: '搜索关键词',
        description: '读取 APKTodo 搜索结果并检查子域名详情地址。',
        inputLabel: '关键词',
        placeholder: '例如 hello',
        defaultInput: 'hello',
      },
      {
        id: 'app-details',
        name: '获取应用详情',
        description: '打开 APKTodo 子域名详情页，读取元数据、截图和下载页地址。',
        inputLabel: '应用详情 URL',
        placeholder: '粘贴源详情页 URL',
        defaultInput: 'https://grok.apktodo.io/',
      },
      {
        id: 'catalog',
        name: '检查目录标签',
        description: '调用源目录接口，汇总每个标签返回的应用数量。',
        inputLabel: '标签数量上限',
        placeholder: '0 表示全部',
        defaultInput: '0',
      },
    ],
  },

  async catalog() {
    return {
      defaultTabId: RECOMMENDED_TAB_ID,
      tabs: CATALOG_TABS,
    };
  },

  async catalogPage(tabId, page = 1) {
    const number = Math.max(1, Number(page) || 1);
    if (tabId === RECOMMENDED_TAB_ID) {
      if (number > 1) return {apps: [], hasMore: false};
      const html = await fetchText(`${ORIGIN}/`);
      return {apps: parseGridResults(html).slice(0, 24), hasMore: false};
    }

    const id = absoluteUrl(tabId).replace(/\/+$/, '') + '/';
    if (!new RegExp(`^${ORIGIN}/(?:games|apps)/$`, 'i').test(id)) {
      throw new TypeError('无效的目录标签地址');
    }
    const html = await fetchSearchText(catalogPageUrl(id, number));
    if (html === null) return {apps: [], hasMore: false};
    return {
      apps: parseIconResults(html),
      hasMore: hasNextPage(html),
    };
  },

  async search(query, page = 1) {
    const normalized = cleanText(query);
    if (normalized.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    const html = await fetchSearchText(searchUrl(normalized, page));
    return html === null ? [] : parseSearchResults(html);
  },

  async detailsMetadata(url) {
    const id = absoluteUrl(url);
    if (!isApkTodoUrl(id)) throw new TypeError('无效的 APKTodo 详情地址');

    const openUrl = /\/$/.test(id) ? id : `${id}/`;
    const tab = await apkmesh.browser.open(openUrl);
    try {
      await tab.waitFor('.page_single_new');
      const app = await tab.query({
        id: 'link[rel="canonical"]@href',
        name: '.page_single_new .thumb_title h1.title@text',
        category: '.page_single_new .thumb_title .cate@text',
        iconUrl: '.page_single_new .thumb_title img@data-src',
        summary: 'meta[name="description"]@content',
        downloadPage: '.page_single_new .btn_download a@href',
      });
      const rows = await tab.queryAll('.table_info tr', {
        label: 'th@text',
        value: 'td@text',
      });
      const structured = parseStructuredData(await tab.queryAll('script[type="application/ld+json"]', {text: '@text'}));
      const screenshotNodes = await tab.queryAll('.apk-slider-holder img.ss-item', {
        src: '@src',
        dataSrc: '@data-src',
      });
      const commentNodes = await tab.queryAll('.comment-content, .comment-body', {text: '@text'});
      const screenshots = screenshotNodes.map((item) => absoluteUrl(item.dataSrc || item.src || ''));
      const structuredScreenshots = Array.isArray(structured.screenshot)
        ? structured.screenshot.map((item) => typeof item === 'string' ? item : item && item.url)
        : structured.screenshot && Array.isArray(structured.screenshot.url)
          ? structured.screenshot.url
          : structured.screenshot && structured.screenshot.url
            ? [structured.screenshot.url]
            : [];

      app.id = absoluteUrl(app.id || id);
      app.name = rowField(rows, 'Name') || cleanText(app.name || structured.name || '');
      app.name = app.name.replace(/\s+APK(?:\s+v?\d[\w.-]*)?\s*$/i, '').trim();
      app.packageName = '';
      app.version = rowField(rows, 'Last version') || cleanText(structured.softwareVersion || '');
      app.size = rowField(rows, 'Size') || cleanText(structured.fileSize || '');
      app.updatedAt = rowField(rows, 'Updated') || cleanText(structured.dateModified || structured.datePublished || '');
      app.category = rowField(rows, 'Category') || cleanText(app.category || structured.applicationSubCategory || structured.applicationCategory || '');
      app.iconUrl = absoluteUrl(app.iconUrl || structured.thumbnailUrl || structured.image || '');
      app.summary = cleanText(app.summary || structured.description || '');
      const descriptionResult = await tab.query({description: '.apk_content@text'});
      app.description = cleanText(descriptionResult.description || '');
      app.screenshots = uniqueStrings(screenshots.concat(structuredScreenshots.map(absoluteUrl)));
      app.comments = uniqueStrings(commentNodes.map((item) => cleanText(item.text)));
      app.downloadPage = resolveUrl(app.downloadPage || '', openUrl);
      app.downloadCandidates = app.downloadPage
        ? [{label: app.name || 'APK', url: app.downloadPage, size: app.size || ''}]
        : [];
      return app;
    } finally {
      await tab.close();
    }
  },

  async resolveDownloads(candidates, requestId) {
    const resolved = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      const candidate = candidates[index];
      try {
        const downloads = await resolveDownloadPage(candidate);
        await reportDetailProgress(requestId, index, downloads, null);
        resolved.push(...downloads);
      } catch (error) {
        await reportDetailProgress(requestId, index, [], error);
      }
    }
    return uniqueDownloads(resolved);
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
      return {
        title: '搜索完成',
        summary: `关键词“${value}”返回 ${results.length} 条结果`,
        data: results.map((item) => ({
          name: item.name,
          id: item.id,
          updatedAt: item.updatedAt,
          iconUrl: item.iconUrl,
        })),
      };
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {
        title: '详情读取完成',
        summary: `已读取 ${app.name}；下载项 ${app.downloads.length} 个`,
        data: {
          name: app.name,
          version: app.version,
          size: app.size,
          category: app.category,
          updatedAt: app.updatedAt,
          screenshots: app.screenshots.length,
          downloadPage: app.downloadPage,
          downloads: app.downloads.length,
        },
      };
    }
    if (projectId === 'catalog') {
      const catalog = await this.catalog();
      const limit = Math.max(0, Number(value) || 0);
      const selected = limit > 0 ? catalog.tabs.slice(0, limit) : catalog.tabs;
      const tabs = [];
      for (const tab of selected) {
        const result = await this.catalogPage(tab.id, 1);
        tabs.push({id: tab.id, name: tab.name, apps: result.apps.length, hasMore: result.hasMore});
      }
      return {
        title: '目录标签检查完成',
        summary: `检查标签 ${tabs.length} 个`,
        data: {tabs},
      };
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
