/** Aptoide source for APK Mesh. */
const ORIGIN = 'https://en.aptoide.com';
const API_ORIGIN = 'https://ws2-cache.aptoide.com/api/7';
const PAGE_SIZE = 20;
const CATALOG_TABS = [
  {id: 'apps-trending', name: '热门应用', description: 'Aptoide 热门 Android 应用', path: '/apps/trending', category: '应用'},
  {id: 'apps-latest', name: '最新应用', description: 'Aptoide 最新 Android 应用', path: '/apps/latest', category: '应用'},
  {id: 'games-trending', name: '热门游戏', description: 'Aptoide 热门 Android 游戏', path: '/games/trending', category: '游戏'},
  {id: 'games-latest', name: '最新游戏', description: 'Aptoide 最新 Android 游戏', path: '/games/latest', category: '游戏'},
];
const REQUEST_HEADERS = {
  Accept: 'application/json,text/plain,*/*',
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
    })[entity.toLowerCase()] || `&${entity};`);
}

function cleanText(value) {
  return decodeHtml(String(value || '').replace(/\s+/g, ' ')).trim();
}

function isAptoideUrl(value) {
  return /^https:\/\/(?:[a-z0-9-]+\.)+aptoide\.com\//i.test(String(value || ''));
}

function isDetailUrl(value) {
  return /^https:\/\/(?:[a-z0-9-]+\.)+aptoide\.com\/app(?:[/?#]|$)/i.test(String(value || ''));
}

function appUrl(uname) {
  const value = cleanText(uname).replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) return '';
  return `https://${value}.en.aptoide.com/app`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

function absoluteHttpsUrl(value) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return /^https:\/\//i.test(url) ? url : '';
}

function uniqueStrings(values) {
  return (values || []).filter((value, index, all) => {
    const item = cleanText(value);
    return item && all.indexOf(value) === index;
  });
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  const offset = (number - 1) * PAGE_SIZE;
  const params = [
    `cdn=web`,
    `q=bXlDUFU9YXJtNjQtdjhhLGFybWVhYmktdjdhLGFybWVhYmkmbGVhbmJhY2s9MA`,
    `aab=1`,
    `mature=false`,
    `language=en_US`,
    `country=gb`,
    `not_apk_tags=`,
    `query=${encodeURIComponent(query)}`,
    `limit=${PAGE_SIZE}`,
    `offset=${offset}`,
    `origin=SITE`,
    `store_name=aptoide-web`,
  ];
  return `${API_ORIGIN}/apps/search?${params.join('&')}`;
}

async function fetchText(url) {
  return apkmesh.request(url, {headers: REQUEST_HEADERS});
}

async function fetchJson(url) {
  const response = await fetchText(url);
  try {
    return JSON.parse(response);
  } catch (error) {
    throw new Error(`Aptoide returned invalid JSON: ${error}`);
  }
}

function parseSearchResults(payload) {
  const list = payload && payload.datalist && Array.isArray(payload.datalist.list)
    ? payload.datalist.list
    : [];
  return mapApiApps(list);
}

function mapApiApps(list, category = '') {
  return (list || []).map((item) => {
    const id = appUrl(item && item.uname);
    const file = item && item.file ? item.file : {};
    if (!id || !item || !cleanText(item.name)) return null;
    return {
      id,
      name: cleanText(item.name),
      packageName: cleanText(item.package),
      version: cleanText(file.vername),
      size: typeof item.size === 'string' ? cleanText(item.size) : formatBytes(item.size || file.filesize),
      updatedAt: cleanText(item.updated || item.modified),
      category,
      iconUrl: absoluteHttpsUrl(item.icon),
    };
  }).filter(Boolean).filter((item, index, all) =>
    all.findIndex((candidate) => candidate.id === item.id) === index,
  );
}

function catalogUrl(tab, page) {
  const number = Math.max(1, Number(page) || 1);
  return `${ORIGIN}${tab.path}${number > 1 ? `?page=${number}` : ''}`;
}

function parseCatalogPage(html, tab) {
  const match = /<script\b[^>]*\bid\s*=\s*['"]__NEXT_DATA__['"][^>]*>([\s\S]*?)<\/script>/i.exec(html || '');
  if (!match) throw new Error('Aptoide catalog data was not found');
  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Aptoide returned invalid catalog data: ${error}`);
  }
  const pageProps = payload && payload.props && payload.props.pageProps;
  const grid = pageProps && pageProps.gridApps;
  if (!grid || !Array.isArray(grid.list)) {
    throw new Error('Aptoide catalog app list was not found');
  }
  return {
    apps: mapApiApps(grid.list, tab.category),
    hasMore: grid.list.length > 0 && grid.next !== null && grid.next !== undefined,
  };
}

function isNotFoundError(error) {
  const message = error && error.message ? error.message : String(error || '');
  return /\bHTTP\s+404\b/i.test(message) ||
    /\bstatus(?:\s+code)?\s*[:=]?\s*404\b/i.test(message);
}

async function fetchCatalogText(url) {
  try {
    return await fetchText(url);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function parseJsonLd(nodes) {
  for (const node of nodes || []) {
    try {
      const value = JSON.parse(String(node.text || '').trim());
      const values = Array.isArray(value) ? value : [value];
      const application = values.find((item) => item && (
        item['@type'] === 'MobileApplication' || item['@type'] === 'SoftwareApplication'
      ));
      if (application) return application;
    } catch (_) {
      // A page can contain unrelated JSON-LD blocks.
    }
  }
  return {};
}

function parseNextData(nodes) {
  for (const node of nodes || []) {
    try {
      const value = JSON.parse(String(node.text || '').trim());
      const pageProps = value && value.props && value.props.pageProps;
      if (pageProps && pageProps.app) return pageProps;
    } catch (_) {
      // Keep the JSON-LD fallback available when Next data changes.
    }
  }
  return {};
}

function structuredScreenshots(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.url)) return value.url;
  return value ? [value] : [];
}

function mapStructuredDetails(url, structured) {
  const publisher = structured.publisher && structured.publisher.name;
  const screenshots = structuredScreenshots(structured.screenshot || structured.image)
    .map((item) => absoluteHttpsUrl(typeof item === 'string' ? item : item && item.url))
    .filter((item) => item && isAptoideUrl(item));
  const downloadUrl = absoluteHttpsUrl(structured.downloadUrl);
  return {
    id: url,
    name: cleanText(structured.name),
    packageName: '',
    version: cleanText(structured.softwareVersion),
    size: cleanText(structured.fileSize),
    updatedAt: cleanText(structured.dateModified || structured.datePublished),
    category: cleanText(structured.applicationSubCategory || structured.applicationCategory),
    iconUrl: absoluteHttpsUrl(structured.image),
    summary: cleanText(structured.description),
    description: cleanText(structured.description),
    screenshots: uniqueStrings(screenshots),
    comments: [],
    downloadCandidates: downloadUrl && isAptoideUrl(downloadUrl)
      ? [{label: 'APK', url: downloadUrl, size: cleanText(structured.fileSize)}]
      : [],
    _publisher: cleanText(publisher),
  };
}

function mapNextDetails(url, pageProps) {
  const app = pageProps.app || {};
  const file = app.file || {};
  const media = app.media || {};
  const groups = Array.isArray(pageProps.groups) ? pageProps.groups : [];
  const screenshots = (Array.isArray(media.screenshots) ? media.screenshots : [])
    .map((item) => absoluteHttpsUrl(item && item.url))
    .filter((item) => item && isAptoideUrl(item));
  const candidates = [file.path, file.pathAlt]
    .map(absoluteHttpsUrl)
    .filter((item) => item && isAptoideUrl(item));
  const comments = (Array.isArray(pageProps.reviews) ? pageProps.reviews : [])
    .map((review) => {
      const title = cleanText(review && review.title);
      const body = cleanText(review && review.body);
      return [title, body].filter(Boolean).join(': ');
    })
    .filter(Boolean);
  return {
    id: url,
    name: cleanText(app.name),
    packageName: cleanText(app.package),
    version: cleanText(file.vername),
    size: formatBytes(file.filesize || app.size),
    updatedAt: cleanText(app.updated || file.added),
    category: cleanText((groups[0] && (groups[0].title || groups[0].name)) || ''),
    iconUrl: absoluteHttpsUrl(app.icon),
    summary: cleanText(media.news || media.summary),
    description: cleanText(media.description),
    screenshots: uniqueStrings(screenshots),
    comments: uniqueStrings(comments),
    downloadCandidates: uniqueStrings(candidates).map((item) => ({
      label: 'APK',
      url: item,
      size: formatBytes(file.filesize || app.size),
    })),
    _publisher: cleanText(app.developer && app.developer.name),
  };
}

function normalizeDetails(app, url, fallback) {
  const result = {...app};
  result.id = absoluteHttpsUrl(result.id) || url;
  result.name = cleanText(result.name || fallback.name);
  result.packageName = cleanText(result.packageName);
  result.version = cleanText(result.version);
  result.size = cleanText(result.size);
  result.updatedAt = cleanText(result.updatedAt);
  result.category = cleanText(result.category);
  result.iconUrl = absoluteHttpsUrl(result.iconUrl);
  result.summary = cleanText(result.summary);
  result.description = cleanText(result.description || result.summary);
  result.screenshots = uniqueStrings(result.screenshots).filter(isAptoideUrl);
  result.comments = uniqueStrings(result.comments);
  result.downloadCandidates = (result.downloadCandidates || [])
    .filter((item) => item && isAptoideUrl(item.url))
    .map((item) => ({
      label: cleanText(item.label) || 'APK',
      url: absoluteHttpsUrl(item.url),
      size: cleanText(item.size),
    }))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index);
  delete result._publisher;
  return result;
}

async function reportDetailProgress(requestId, index, download, error) {
  if (!requestId) return;
  try {
    await apkmesh.detailProgress(requestId, {
      index,
      download: download || null,
      error: error ? String(error) : null,
    });
  } catch (_) {
    // Progress delivery must not abort link resolution.
  }
}

globalThis.source = {
  manifest: {
    id: 'aptoide',
    name: 'Aptoide',
    version: '1.1.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: 'Reads Aptoide search results and app detail pages, including APK downloads.',
    permissions: {
      network: ['*.aptoide.com'],
      browser: true,
      download: true,
      install: true,
    },
    debugProjects: [
      {
        id: 'search-keyword',
        name: 'Search by keyword',
        description: 'Search Aptoide apps through its public web API.',
        inputLabel: 'Keyword',
        placeholder: 'For example bombsquad',
        defaultInput: 'bombsquad',
      },
      {
        id: 'app-details',
        name: 'Read app details',
        description: 'Read metadata, screenshots, reviews and the APK download link.',
        inputLabel: 'App detail URL',
        placeholder: 'Paste an Aptoide app URL',
        defaultInput: 'https://micro-battles-3.en.aptoide.com/app',
      },
    ],
  },

  async catalog() {
    return {
      defaultTabId: CATALOG_TABS[0].id,
      tabs: CATALOG_TABS.map((tab) => ({
        id: tab.id,
        name: tab.name,
        description: tab.description,
        paged: true,
      })),
    };
  },

  async catalogPage(tabId, page = 1) {
    const tab = CATALOG_TABS.find((item) => item.id === tabId);
    if (!tab) throw new TypeError('无效的 Aptoide 目录标签');
    const html = await fetchCatalogText(catalogUrl(tab, page));
    return html === null ? {apps: [], hasMore: false} : parseCatalogPage(html, tab);
  },

  async search(query, page = 1) {
    const normalized = cleanText(query);
    if (normalized.length < 2) throw new TypeError('Search keyword must contain at least 2 characters');
    const payload = await fetchJson(searchUrl(normalized, page));
    return parseSearchResults(payload);
  },

  async detailsMetadata(url) {
    const id = cleanText(url);
    if (!isDetailUrl(id)) throw new TypeError('Invalid Aptoide app detail URL');
    const tab = await apkmesh.browser.open(id);
    try {
      await tab.waitFor('script#__NEXT_DATA__');
      const nextNodes = await tab.queryAll('script#__NEXT_DATA__', {text: '@text'});
      const pageProps = parseNextData(nextNodes);
      if (pageProps.app) {
        return normalizeDetails(mapNextDetails(id, pageProps), id, {});
      }
      const structuredNodes = await tab.queryAll('script[type="application/ld+json"]', {text: '@text'});
      const structured = parseJsonLd(structuredNodes);
      if (!structured.name) throw new Error('Aptoide app data was not found');
      return normalizeDetails(mapStructuredDetails(id, structured), id, structured);
    } finally {
      await tab.close();
    }
  },

  async resolveDownloads(candidates, requestId) {
    const resolved = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      const candidate = candidates[index];
      try {
        if (!candidate || !isAptoideUrl(candidate.url)) throw new Error('Untrusted Aptoide download URL');
        const download = {
          label: cleanText(candidate.label) || 'APK',
          url: absoluteHttpsUrl(candidate.url),
          size: cleanText(candidate.size),
        };
        await reportDetailProgress(requestId, index, download, null);
        resolved.push(download);
      } catch (error) {
        await reportDetailProgress(requestId, index, null, error);
      }
    }
    return resolved.filter((item, index, all) =>
      all.findIndex((candidate) => candidate.url === item.url) === index,
    );
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
        title: 'Search completed',
        summary: `Aptoide returned ${results.length} apps for "${value}"`,
        data: results.map((item) => ({
          name: item.name,
          packageName: item.packageName,
          version: item.version,
          id: item.id,
        })),
      };
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {
        title: 'Details loaded',
        summary: `Loaded ${app.name} with ${app.downloads.length} download(s)`,
        data: {
          name: app.name,
          packageName: app.packageName,
          version: app.version,
          size: app.size,
          category: app.category,
          updatedAt: app.updatedAt,
          screenshots: app.screenshots.length,
          comments: app.comments.length,
          downloads: app.downloads.length,
        },
      };
    }
    throw new Error(`Unknown debug project: ${projectId}`);
  },
};
