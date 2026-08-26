/** APKAward public-page source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://apkaward.com';
const REQUEST_HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  Referer: `${ORIGIN}/`,
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
};

const CATALOG_TABS = [
  {id: 'featured', name: '推荐', paged: false, route: ''},
  {id: 'popular', name: '热门', paged: true, route: 'popular', customPaging: true},
  {id: 'new', name: '最新', paged: true, route: 'new', customPaging: true},
  {id: 'mod', name: 'Mod', paged: true, route: 'mod'},
  {id: 'editors-choice', name: '编辑精选', paged: true, route: 'editors-choice', customPaging: true},
  {id: 'tool', name: '工具', paged: true, route: 'tool'},
  {id: 'action', name: '动作', paged: true, route: 'action'},
  {id: 'adventure', name: '冒险', paged: true, route: 'adventure'},
  {id: 'arcade', name: '街机', paged: true, route: 'arcade'},
  {id: 'board', name: '棋牌', paged: true, route: 'board'},
  {id: 'card', name: '卡牌', paged: true, route: 'card'},
  {id: 'casual', name: '休闲', paged: true, route: 'casual'},
  {id: 'educational', name: '教育', paged: true, route: 'educational'},
  {id: 'psp', name: 'PSP', paged: true, route: 'psp'},
  {id: 'puzzle', name: '解谜', paged: true, route: 'puzzle'},
  {id: 'roguelike', name: 'Roguelike', paged: true, route: 'roguelike'},
  {id: 'racing', name: '竞速', paged: true, route: 'racing'},
  {id: 'role-playing', name: '角色扮演', paged: true, route: 'role-playing'},
  {id: 'simulation', name: '模拟', paged: true, route: 'simulation'},
  {id: 'sports', name: '体育', paged: true, route: 'sports'},
  {id: 'strategy', name: '策略', paged: true, route: 'strategy'},
];

const RESERVED_PATHS = new Set([
  '', 'popular', 'new', 'mod', 'editors-choice', 'tool', 'action', 'adventure',
  'arcade', 'board', 'card', 'casual', 'educational', 'psp', 'puzzle', 'roguelike',
  'racing', 'role-playing', 'simulation', 'sports', 'strategy', 'search', 'category',
  'topics', 'update', 'contact', 'privacy-policy', 'dmca-copyright-infringement-notification',
  'gpu', 'how-to-install-apks-xapk-zip-games', 'how-to-set-apk-obb',
  'how-to-place-data-files-for-android-games',
]);

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#039);/gi, (_, entity) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#039': "'",
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
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag || '');
  return match ? decodeHtml(match[2]).trim() : '';
}

function absoluteUrl(value, baseUrl = ORIGIN) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url.replace(/^http:\/\//i, 'https://');
  if (url.startsWith('/')) return `${ORIGIN}${url}`;
  const directory = baseUrl.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
  return `${directory}${url}`;
}

function canonicalSourceUrl(value) {
  const url = absoluteUrl(value).replace(/[?#].*$/, '').replace(/\/+$/, '');
  return url.replace(/^https:\/\/www\.apkaward\.com/i, ORIGIN);
}

function isAppUrl(value) {
  const match = /^https:\/\/apkaward\.com\/([^/?#]+)$/i.exec(canonicalSourceUrl(value));
  return Boolean(match && !RESERVED_PATHS.has(match[1].toLowerCase()) &&
    !/^\d+$/.test(match[1]));
}

function isDownloadPage(value) {
  return /^https:\/\/apkaward\.com\/\d+\/download\/[a-z0-9_.-]+$/i.test(canonicalSourceUrl(value));
}

function isDirectFile(value) {
  return /^https:\/\/(?:[a-z0-9-]+\.)?apkawards\.com\/[^?#]+\.(?:apk|apks|xapk|zip|obb)(?:[?#].*)?$/i
    .test(cleanText(value));
}

function stripApkSuffix(value) {
  return cleanText(value)
    .replace(/^Download\s+/i, '')
    .replace(/\s+(?:MOD\s+)?(?:APK|APKS|XAPK)(?:\s*\+[^\d][\s\S]*)?$/i, '')
    .replace(/\s+-\s+Download(?:\s+Free)?[\s\S]*$/i, '')
    .trim();
}

function extractVersion(value) {
  const match = /\bv?\d+(?:\.\d+)+(?:[a-z][\w.-]*)?/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function imageUrl(tag, baseUrl) {
  for (const name of ['data-src', 'data-lazy-src', 'data-original', 'src']) {
    const value = attribute(tag, name);
    if (value && !/^data:/i.test(value)) return absoluteUrl(value, baseUrl);
  }
  return '';
}

function uniqueBy(items, field) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || !item[field] || seen.has(item[field])) return false;
    seen.add(item[field]);
    return true;
  });
}

function isNotFoundError(error) {
  const message = error && error.message ? error.message : String(error || '');
  return /\bHTTP\s+404\b/i.test(message) || /\bstatus(?:\s+code)?\s*[:=]?\s*404\b/i.test(message);
}

function assertPublicPage(html) {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  const title = textFromHtml(titleMatch ? titleMatch[1] : '');
  if (/attention required|just a moment|security verification/i.test(title) ||
      /sorry, you have been blocked|enable javascript and cookies to continue/i.test(html || '')) {
    throw new Error('APKAward is protected by a Cloudflare verification page');
  }
  return !/^404\b|page not found/i.test(title);
}

async function fetchHtml(url) {
  const html = await apkmesh.request(url, {headers: REQUEST_HEADERS});
  if (!assertPublicPage(html)) throw new Error(`APKAward page not found: ${url}`);
  return html;
}

async function fetchPageOrNull(url) {
  try {
    const html = await apkmesh.request(url, {headers: REQUEST_HEADERS});
    return assertPublicPage(html) ? html : null;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function listingUrl(tab, page) {
  const number = Math.max(1, Number(page) || 1);
  if (tab.id === 'featured') return `${ORIGIN}/`;
  if (number === 1) return `${ORIGIN}/${tab.route}`;
  if (tab.customPaging) return `${ORIGIN}/${tab.route}-${number}`;
  return `${ORIGIN}/${tab.route}/page/${number}`;
}

function hasNextPage(html) {
  return /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bNext\b[^"']*["'][^>]*>/i.test(html || '') ||
    /<a\b[^>]*\brel\s*=\s*["']next["'][^>]*>/i.test(html || '');
}

function parseListing(html, category = '') {
  const apps = [];
  const pattern = /<a\b([^>]*\bclass\s*=\s*["'][^"']*\bpic\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const tag = `<a${match[1]}>`;
    const id = canonicalSourceUrl(attribute(tag, 'href'));
    if (!isAppUrl(id)) continue;
    const imageMatch = /<img\b[^>]*>/i.exec(match[2]);
    const title = attribute(tag, 'title');
    const name = stripApkSuffix(imageMatch ? attribute(imageMatch[0], 'alt') : title) ||
      stripApkSuffix(title) || textFromHtml(match[2]);
    if (!name) continue;
    const following = String(html || '').slice(match.index + match[0].length, match.index + match[0].length + 900);
    const versionMatch = /<i\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:cmz|emo)\b[^"']*["'][^>]*>([\s\S]*?)<\/i>/i.exec(following);
    apps.push({
      id,
      name,
      packageName: packageFromImage(imageMatch ? imageUrl(imageMatch[0], id) : ''),
      version: extractVersion(versionMatch ? textFromHtml(versionMatch[1]) : title),
      size: '',
      updatedAt: '',
      category,
      iconUrl: imageMatch ? imageUrl(imageMatch[0], id) : '',
    });
  }
  return uniqueBy(apps, 'id');
}

function packageFromImage(value) {
  const match = /\/(?:games|apps)\/([^/]+)\/img\//i.exec(cleanText(value));
  return match ? decodeURIComponent(match[1]) : '';
}

function metaContent(html, selector) {
  const pattern = new RegExp(`<meta\\b[^>]*${selector}[^>]*>`, 'i');
  const match = pattern.exec(html || '');
  return match ? attribute(match[0], 'content') : '';
}

function canonicalFromHtml(html, fallback) {
  const links = String(html || '').match(/<link\b[^>]*>/gi) || [];
  const canonical = links.find((tag) => /\brel\s*=\s*["']canonical["']/i.test(tag));
  return canonicalSourceUrl(canonical ? attribute(canonical, 'href') : fallback);
}

function rowField(html, labels) {
  const expected = labels.map((item) => item.toLowerCase());
  const pattern = /<li\b[^>]*>[\s\S]*?<strong\b[^>]*>([\s\S]*?)<\/strong>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/li>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const label = textFromHtml(match[1]).toLowerCase().replace(/:$/, '');
    if (expected.includes(label)) return textFromHtml(match[2]);
  }
  return '';
}

function parseScreenshots(html, baseUrl) {
  const sectionMatch = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bimage-x\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  if (!sectionMatch) return [];
  return uniqueBy((sectionMatch[1].match(/<img\b[^>]*>/gi) || []).map((tag) => ({
    url: imageUrl(tag, baseUrl),
  })).filter((item) => item.url), 'url').map((item) => item.url);
}

function parseComments(html) {
  const comments = [];
  const pattern = /<section\b[^>]*\bclass\s*=\s*["'][^"']*\bcomment-content\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const text = textFromHtml(match[1]);
    if (text) comments.push({text});
  }
  return uniqueBy(comments, 'text').slice(0, 20).map((item) => item.text);
}

function parseDescription(html) {
  const match = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bmore-show\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html || '');
  return match ? textFromHtml(match[1]) : '';
}

function parseDownloadCandidates(html, baseUrl, fallbackName) {
  const candidates = [];
  const pattern = /<a\b([^>]*\bclass\s*=\s*["'][^"']*\baabbadownpk\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const url = canonicalSourceUrl(absoluteUrl(attribute(`<a${match[1]}>`, 'href'), baseUrl));
    if (!isDownloadPage(url)) continue;
    const text = textFromHtml(match[2]);
    candidates.push({
      label: cleanText(text.replace(/\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/gi, '')) || fallbackName || 'APK',
      url,
      size: extractSize(text),
    });
  }
  return uniqueBy(candidates, 'url').slice(0, 12);
}

function parseDirectDownloads(html, candidate) {
  const results = [];
  const pattern = /<a\b([^>]*\bclass\s*=\s*["'][^"']*\bdowmapk\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const url = absoluteUrl(attribute(`<a${match[1]}>`, 'href'), candidate.url);
    if (!isDirectFile(url)) continue;
    const text = textFromHtml(match[2]);
    const parsedLabel = cleanText(text.replace(/\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/gi, ''));
    results.push({
      label: /^Download\s*\(\s*\)$/i.test(parsedLabel)
        ? candidate.label || 'APK'
        : parsedLabel || candidate.label || 'APK',
      url,
      size: extractSize(text) || candidate.size || '',
      headers: {Referer: candidate.url},
    });
  }
  return uniqueBy(results, 'url');
}

async function resolveCandidate(candidate) {
  const pageUrl = canonicalSourceUrl(candidate && candidate.url);
  if (!isDownloadPage(pageUrl)) throw new TypeError('Invalid APKAward download page');
  const html = await fetchHtml(pageUrl);
  const downloads = parseDirectDownloads(html, {...candidate, url: pageUrl});
  if (!downloads.length) throw new Error(`APKAward download page did not expose a supported file: ${pageUrl}`);
  return downloads;
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
    // Progress delivery must not mask a successfully resolved link.
  }
}

globalThis.source = {
  manifest: {
    id: 'apkaward',
    name: 'APKAward',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 APKAward 公开页面的目录、搜索、详情、截图和下载项。',
    permissions: {
      network: ['apkaward.com', '*.apkaward.com', 'apkawards.com', '*.apkawards.com'],
      browser: false,
      download: true,
      install: false,
    },
    debugProjects: [
      {
        id: 'search-keyword',
        name: '搜索关键词',
        description: '检查 APKAward 公开分类页中的匹配结果。',
        inputLabel: '关键词',
        placeholder: '例如 minecraft',
        defaultInput: 'minecraft',
      },
      {
        id: 'app-details',
        name: '获取应用详情',
        description: '读取 APKAward 详情页并解析公开下载链接。',
        inputLabel: '应用详情 URL',
        placeholder: '粘贴 APKAward 应用 URL',
        defaultInput: 'https://apkaward.com/dont-starve-pocket-edition',
      },
    ],
  },

  async catalog() {
    return {
      defaultTabId: 'featured',
      tabs: CATALOG_TABS.map(({id, name, paged}) => ({id, name, paged})),
    };
  },

  async catalogPage(tabId, page = 1) {
    const tab = CATALOG_TABS.find((item) => item.id === tabId);
    if (!tab) throw new TypeError('无效的 APKAward 目录标签');
    const number = Math.max(1, Number(page) || 1);
    if (!tab.paged && number > 1) return {apps: [], hasMore: false};
    const html = await fetchPageOrNull(listingUrl(tab, number));
    if (html === null) return {apps: [], hasMore: false};
    return {
      apps: parseListing(html, tab.name).slice(0, tab.paged ? 30 : 36),
      hasMore: tab.paged && hasNextPage(html),
    };
  },

  async search(query, page = 1) {
    const normalized = cleanText(query).toLowerCase();
    if (normalized.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    const number = Math.max(1, Number(page) || 1);
    const tabs = ['popular', 'new', 'mod', 'tool', 'editors-choice']
      .map((id) => CATALOG_TABS.find((item) => item.id === id));
    const pages = await Promise.all(tabs.map((tab) => fetchPageOrNull(listingUrl(tab, number))));
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const apps = pages.flatMap((html) => html ? parseListing(html) : []);
    return uniqueBy(apps, 'id').filter((app) => {
      const searchable = `${app.name} ${app.id.replace(ORIGIN, '').replace(/[-_/]+/g, ' ')}`.toLowerCase();
      return tokens.every((token) => searchable.includes(token));
    });
  },

  async detailsMetadata(value) {
    const requestedUrl = canonicalSourceUrl(value);
    if (!isAppUrl(requestedUrl)) throw new TypeError('无效的 APKAward 详情地址');
    const html = await fetchHtml(requestedUrl);
    const id = canonicalFromHtml(html, requestedUrl);
    if (!isAppUrl(id)) throw new Error('APKAward detail page did not expose a valid canonical URL');
    const headingMatch = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    const iconUrl = absoluteUrl(metaContent(html, 'property\\s*=\\s*["\']og:image["\']'), id);
    const name = stripApkSuffix(headingMatch ? textFromHtml(headingMatch[1]) :
      metaContent(html, 'property\\s*=\\s*["\']og:title["\']'));
    const candidates = parseDownloadCandidates(html, id, name);
    const summary = cleanText(metaContent(html, 'name\\s*=\\s*["\']description["\']') ||
      metaContent(html, 'property\\s*=\\s*["\']og:description["\']'));
    return {
      id,
      name,
      packageName: packageFromImage(iconUrl),
      version: cleanText(metaContent(html, 'itemprop\\s*=\\s*["\']softwareVersion["\']')) ||
        rowField(html, ['version']),
      size: candidates.length ? candidates[0].size : '',
      updatedAt: rowField(html, ['updated']) ||
        cleanText(metaContent(html, 'itemprop\\s*=\\s*["\']dateModified["\']')),
      category: rowField(html, ['category']) ||
        cleanText(metaContent(html, 'itemprop\\s*=\\s*["\']applicationCategory["\']')),
      iconUrl,
      summary,
      description: parseDescription(html) || summary,
      screenshots: parseScreenshots(html, id),
      comments: parseComments(html),
      downloadCandidates: candidates,
    };
  },

  async resolveDownloads(candidates, requestId) {
    const downloads = [];
    const errors = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      try {
        const resolved = await resolveCandidate(candidates[index]);
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

  async details(value) {
    const app = await this.detailsMetadata(value);
    app.downloads = await this.resolveDownloads(app.downloadCandidates);
    delete app.downloadCandidates;
    return app;
  },

  async debug(projectId, input) {
    const value = cleanText(input);
    if (projectId === 'search-keyword') {
      const results = await this.search(value, 1);
      return {title: '搜索完成', summary: `关键词“${value}”返回 ${results.length} 条结果`, data: results};
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {title: '详情读取完成', summary: `已读取 ${app.name}；下载项 ${app.downloads.length} 个`, data: app};
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
