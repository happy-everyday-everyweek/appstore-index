/** APKMirror source for APK Mesh. */
const ORIGIN = 'https://www.apkmirror.com';
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
    })[entity.toLowerCase()] || `&${entity};`);
}

function cleanText(value) {
  return decodeHtml(String(value || '').replace(/\s+/g, ' ')).trim();
}

function textFromHtml(value) {
  return cleanText(String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function attribute(tag, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = new RegExp(`\\b${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag || '');
  if (quoted) return decodeHtml(quoted[2]).trim();
  const unquoted = new RegExp(`\\b${escapedName}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag || '');
  return unquoted ? decodeHtml(unquoted[1]).trim() : '';
}

function absoluteUrl(value, base = ORIGIN) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${ORIGIN}${url}`;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${url}`;
}

function isApkMirrorUrl(url) {
  return /^https:\/\/(?:[^/]+\.)?apkmirror\.com\//i.test(url);
}

function isChallengePage(html) {
  return /Enable JavaScript and cookies to continue|Just a moment\.\.\.|cf-mitigated/i.test(html || '');
}

function downloadHeaders(referer) {
  return {...SEARCH_HEADERS, Referer: referer};
}

function extractVersion(value) {
  const match = /\bv?\d+(?:\.\d+)+(?:[ _.-]*(?:alpha|beta|rc)\b)?/i.exec(cleanText(value));
  return match ? match[0].replace(/^v/i, '') : '';
}

function stripVersion(value) {
  return cleanText(value)
    .replace(/\s+\bv?\d+(?:\.\d+)+(?:[ _.-]*(?:alpha|beta|rc)\b)?\s*$/i, '')
    .replace(/\s+APK(?:\s+Download)?(?:\s+by\b.*)?$/i, '')
    .trim();
}

function metaContent(html, name) {
  const pattern = new RegExp(`<meta\\b[^>]*\\bname\\s*=\\s*["']${name}["'][^>]*>`, 'i');
  const match = pattern.exec(html || '');
  return match ? attribute(match[0], 'content') : '';
}

function firstTagText(html, pattern) {
  const match = pattern.exec(html || '');
  return match ? textFromHtml(match[1]) : '';
}

function firstClassText(html, className) {
  const escapedName = String(className).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escapedName}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    'i',
  );
  const match = pattern.exec(html || '');
  return match ? textFromHtml(match[1]) : '';
}

function firstAttribute(html, pattern, name) {
  const match = pattern.exec(html || '');
  return match ? attribute(match[0], name) : '';
}

function selectSrcset(value) {
  const candidates = cleanText(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (!candidates.length) return '';
  return candidates[candidates.length - 1].split(/\s+/)[0];
}

function imageUrl(imageTag) {
  return absoluteUrl(
    attribute(imageTag, 'src') ||
    attribute(imageTag, 'data-src') ||
    attribute(imageTag, 'data-lazy-src') ||
    attribute(imageTag, 'data-original') ||
    selectSrcset(attribute(imageTag, 'srcset')),
  );
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  const url = `${ORIGIN}/?post_type=app_release&searchtype=apk&bundles%5B%5D=apkm_bundles&bundles%5B%5D=apk_files&s=${encodeURIComponent(query)}`;
  return number > 1 ? `${url}&page=${number}` : url;
}

function categoryFromUrl(url) {
  return 'APKMirror';
}

function parseSearchResults(html) {
  if (isChallengePage(html)) throw new Error('APKMirror search is protected by Cloudflare');
  const results = [];
  const rowPattern = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bappRow\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass\s*=\s*["'][^"']*\bappRow\b|$)/gi;
  const titlePattern = /<h5\b[^>]*\bclass\s*=\s*["'][^"']*\bappRowTitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h5>/i;
  for (const match of html.matchAll(rowPattern)) {
    const row = match[1];
    const titleBlock = titlePattern.exec(row);
    const titleLink = titleBlock
      ? /<a\b[^>]*>/i.exec(titleBlock[1])
      : null;
    const id = titleLink ? absoluteUrl(attribute(titleLink[0], 'href')) : '';
    const title = titleBlock ? textFromHtml(titleBlock[1]) : '';
    if (!id || !isApkMirrorUrl(id) || !title) continue;
    const imageTag = /<img\b[^>]*>/i.exec(row);
    const updatedAt = firstClassText(row, 'dateyear_utc');
    const version = extractVersion(title);
    results.push({
      id,
      name: stripVersion(title),
      packageName: '',
      version,
      size: '',
      updatedAt,
      category: categoryFromUrl(id),
      iconUrl: imageTag ? imageUrl(imageTag[0]) : '',
    });
  }
  return results.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.id === item.id) === index,
  );
}

function browserSearchResults(rows) {
  return rows.map((item) => {
    const id = absoluteUrl(item.id || '');
    const title = cleanText(item.name || '');
    if (!id || !isApkMirrorUrl(id) || !title) return null;
    return {
      id,
      name: stripVersion(title),
      packageName: '',
      version: extractVersion(title),
      size: '',
      updatedAt: cleanText(item.updatedAt || ''),
      category: categoryFromUrl(id),
      iconUrl: absoluteUrl(item.iconUrl || ''),
    };
  }).filter(Boolean);
}

function sectionBetween(html, startToken, endToken) {
  const start = html.indexOf(startToken);
  if (start < 0) return '';
  const end = html.indexOf(endToken, start + startToken.length);
  return html.slice(start, end < 0 ? html.length : end);
}

function sectionByAnchor(html, name, endName) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEndName = String(endName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startPattern = new RegExp(`<a\\b[^>]*\\bname\\s*=\\s*["']${escapedName}["'][^>]*>`, 'i');
  const endPattern = new RegExp(`<a\\b[^>]*\\bname\\s*=\\s*["']${escapedEndName}["'][^>]*>`, 'i');
  const startMatch = startPattern.exec(html || '');
  if (!startMatch) return '';
  const remainder = (html || '').slice(startMatch.index + startMatch[0].length);
  const endMatch = endPattern.exec(remainder);
  const end = endMatch
    ? startMatch.index + startMatch[0].length + endMatch.index
    : (html || '').length;
  return (html || '').slice(startMatch.index, end);
}

function extractFileSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function extractInfoValue(html, label) {
  const pattern = new RegExp(
    `<span\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\binfoSlide-name\\b[^"']*["'][^>]*>\\s*${label}\\s*:?\\s*<\\/span>([\\s\\S]*?)<\\/p>`,
    'i',
  );
  const match = pattern.exec(html || '');
  return match ? textFromHtml(match[1]) : '';
}

function parseVariantRows(html) {
  const start = html.indexOf('variants-table');
  if (start < 0) return [];
  const end = html.indexOf('listWidget', start);
  const table = html.slice(start, end < 0 ? html.length : end);
  const rowPattern = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\btable-row\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass\s*=\s*["'][^"']*\btable-row\b[^"']*["']|$)/gi;
  const variants = [];
  for (const match of table.matchAll(rowPattern)) {
    const row = match[1];
    const cellMatches = [...row.matchAll(/<div\b[^>]*\bclass\s*=\s*["'][^"']*\btable-cell\b[^"']*["'][^>]*>/gi)];
    if (cellMatches.length < 5) continue;
    const cells = cellMatches.map((cell, index) => {
      const endIndex = index + 1 < cellMatches.length ? cellMatches[index + 1].index : row.length;
      return textFromHtml(row.slice(cell.index, endIndex));
    });
    const linkMatch = /<a\b[^>]*href\s*=\s*["'][^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(row);
    const url = linkMatch ? absoluteUrl(attribute(linkMatch[0], 'href')) : '';
    if (!url || !isApkMirrorUrl(url) || !cells[0] || /^variant$/i.test(cells[0])) continue;
    const type = /BUNDLE/i.test(cells[0]) ? 'BUNDLE' : /APK/i.test(cells[0]) ? 'APK' : '';
    const version = linkMatch ? textFromHtml(linkMatch[1]) : cleanText(cells[0]);
    variants.push({
      url,
      label: [version, cleanText(cells[1]), cleanText(cells[2]), cleanText(cells[3]), type]
        .filter(Boolean).join(' · '),
      size: '',
    });
  }
  return variants;
}

function parseDetailsHtml(html, url) {
  if (isChallengePage(html)) throw new Error('APKMirror detail page is protected by Cloudflare');
  const canonical = absoluteUrl(firstAttribute(html, /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i, 'href') || url);
  const title = firstTagText(html, /<h1\b[^>]*\bclass\s*=\s*["'][^"']*\bapp-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
  const version = extractVersion(title);
  const descriptionSection = sectionByAnchor(html, 'description', 'gallery');
  const descriptionStart = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bnotes\b[^"']*["'][^>]*>/i.exec(descriptionSection);
  const descriptionContentStart = descriptionStart
    ? descriptionStart.index + descriptionStart[0].length
    : -1;
  const showMoreIndex = descriptionContentStart < 0
    ? -1
    : descriptionSection.indexOf('show-more', descriptionContentStart);
  const showMoreOffset = showMoreIndex < 0
    ? -1
    : descriptionSection.lastIndexOf('<div', showMoreIndex);
  const descriptionRaw = descriptionContentStart < 0
    ? ''
    : descriptionSection.slice(
        descriptionStart.index,
        showMoreOffset < 0 ? descriptionSection.length : showMoreOffset,
      );
  const description = cleanText(textFromHtml(descriptionRaw)
    .replace(/Advertisement\s+Remove ads, dark theme, and more with Premium/gi, ''));
  const whatsNewSection = sectionByAnchor(html, 'whatsnew', 'description');
  const whatsNew = textFromHtml((/<div\b[^>]*\bclass\s*=\s*["'][^"']*\bnotes\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(whatsNewSection) || [null, ''])[1]);
  const galleryStart = html.indexOf('gallery-container');
  const galleryEnd = galleryStart < 0 ? -1 : html.indexOf('</div>', galleryStart);
  const screenshotSection = galleryStart < 0
    ? ''
    : html.slice(galleryStart, galleryEnd < 0 ? html.length : galleryEnd);
  const screenshots = [...screenshotSection.matchAll(/<img\b[^>]*>/gi)]
    .map((match) => absoluteUrl(
      selectSrcset(attribute(match[0], 'srcset')) ||
      attribute(match[0], 'data-src') ||
      attribute(match[0], 'src'),
    ))
    .filter(Boolean);
  const categoryMatch = /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bplay-category\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(html);
  const updatedAt = firstClassText(html, 'dateyear_utc');
  const packageLink = /<a\b[^>]*\bhref\s*=\s*["'][^"']*\/store\/apps\/details\?id=([^&"']+)[^"']*["'][^>]*>/i.exec(html);
  const variants = parseVariantRows(html);
  return {
    id: canonical,
    name: stripVersion(title),
    packageName: packageLink ? decodeHtml(packageLink[1]) : '',
    version,
    size: extractFileSize(extractInfoValue(html, 'File size')),
    updatedAt,
    category: categoryMatch ? textFromHtml(categoryMatch[1]) : 'APKMirror',
    iconUrl: absoluteUrl(firstAttribute(html, /<img\b[^>]*\bid\s*=\s*["']primaryimage["'][^>]*>/i, 'src')),
    summary: whatsNew || metaContent(html, 'description'),
    description: description || metaContent(html, 'description'),
    screenshots,
    comments: [],
    _variants: variants,
  };
}

function browserDetails(value) {
  return (async () => {
    const tab = await apkmesh.browser.open(value);
    try {
      await tab.waitFor('.app-title');
      const app = await tab.query({
        id: 'link[rel="canonical"]@href',
        name: '.app-title@text',
        iconUrl: '#primaryimage@src',
        summary: 'meta[name="description"]@content',
        category: '.play-category@text',
        updatedAt: '.dateyear_utc@text',
        whatsNew: '#whatsnew .notes@text',
        description: '#description .notes@text',
      });
      const variants = await tab.queryAll('.variants-table > .table-row', {
        version: '.table-cell:nth-child(1) a@text',
        url: '.table-cell:nth-child(1) a@href',
        type: '.table-cell:nth-child(1)@text',
        arch: '.table-cell:nth-child(2)@text',
        minAndroidVersion: '.table-cell:nth-child(3)@text',
        dpi: '.table-cell:nth-child(4)@text',
      });
      const screenshots = await tab.queryAll('.gallery-container img', {
        src: '@src',
        srcset: '@srcset',
        dataSrc: '@data-src',
      });
      const packageLink = await tab.query({packageName: 'a[href*="/store/apps/details?id="]@href'});
      const packageMatch = /[?&]id=([^&]+)/i.exec(packageLink.packageName || '');
      return {
        id: absoluteUrl(app.id || value),
        name: stripVersion(app.name || ''),
        packageName: packageMatch ? decodeHtml(packageMatch[1]) : '',
        version: extractVersion(app.name || ''),
        size: '',
        updatedAt: cleanText(app.updatedAt || ''),
        category: cleanText(app.category || 'APKMirror'),
        iconUrl: absoluteUrl(app.iconUrl || ''),
        summary: cleanText(app.whatsNew || app.summary || ''),
        description: cleanText(app.description || app.summary || ''),
        screenshots: screenshots.map((item) => imageUrl(`<img src="${item.src || ''}" srcset="${item.srcset || ''}" data-src="${item.dataSrc || ''}">`)).filter(Boolean),
        comments: [],
        _variants: variants.filter((item) => item.url).map((item) => ({
          url: absoluteUrl(item.url),
          label: [cleanText(item.version), cleanText(item.arch), cleanText(item.minAndroidVersion), cleanText(item.dpi), /BUNDLE/i.test(item.type || '') ? 'BUNDLE' : 'APK']
            .filter(Boolean).join(' · '),
          size: '',
        })),
      };
    } finally {
      await tab.close();
    }
  })();
}

function extractDownloadButtonUrl(html) {
  const match = /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bdownloadButton\b[^"']*["'][^>]*>/i.exec(html || '');
  return match ? absoluteUrl(attribute(match[0], 'href')) : '';
}

function extractFinalDownloadUrl(html) {
  const start = html.indexOf('card-with-tabs');
  const scope = start < 0 ? html : html.slice(start);
  const links = [...scope.matchAll(/<a\b[^>]*href\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi)]
    .map((match) => absoluteUrl(match[2]))
    .filter((candidate) => candidate && candidate !== '#');
  return links.find((candidate) => /downloadr\d*\.apkmirror\.com|\.apk(?:m|s)?(?:[?#]|$)|download\.php/i.test(candidate)) || '';
}

async function resolveDownload(item) {
  const html = await fetchText(item.url);
  const redirect = extractDownloadButtonUrl(html);
  if (!redirect) return null;
  const redirectHtml = await fetchText(redirect, item.url);
  const direct = extractFinalDownloadUrl(redirectHtml);
  if (!direct || !isApkMirrorUrl(direct)) return null;
  return {...item, url: direct, size: item.size || extractFileSize(extractInfoValue(html, 'File size')), headers: downloadHeaders(item.url)};
}

async function resolveDownloadWithBrowser(item) {
  const tab = await apkmesh.browser.open(item.url);
  try {
    await tab.waitFor('.downloadButton');
    const first = await tab.query({url: '.downloadButton@href'});
    const redirect = absoluteUrl(first.url || '');
    await tab.close();
    if (!redirect) return null;
    const second = await apkmesh.browser.open(redirect);
    try {
      await second.waitFor('.card-with-tabs');
      const links = await second.queryAll('.card-with-tabs a[href]', {url: '@href'});
      const direct = links
        .map((item) => absoluteUrl(item.url || ''))
        .find((candidate) => /downloadr\d*\.apkmirror\.com|\.apk(?:m|s)?(?:[?#]|$)|download\.php/i.test(candidate)) || '';
      return direct && isApkMirrorUrl(direct)
        ? {...item, url: direct, headers: downloadHeaders(item.url)}
        : null;
    } finally {
      await second.close();
    }
  } catch (error) {
    try { await tab.close(); } catch (_) {}
    throw error;
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (_) {
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
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

async function resolveDownloadCandidate(item) {
  try {
    return await resolveDownload(item);
  } catch (_) {
    try {
      return await resolveDownloadWithBrowser(item);
    } catch (_) {
      return null;
    }
  }
}

async function fetchText(url, referer = ORIGIN) {
  return apkmesh.request(url, {
    headers: downloadHeaders(referer),
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

async function detailsMetadata(value) {
  const normalized = absoluteUrl(value);
  if (!/^https:\/\/www\.apkmirror\.com\/apk\//i.test(normalized)) {
    throw new TypeError('Invalid APKMirror detail URL');
  }
  let app;
  try {
    app = parseDetailsHtml(await fetchText(normalized), normalized);
  } catch (error) {
    app = await browserDetails(normalized);
  }
  app.downloadCandidates = app._variants || [];
  delete app._variants;
  return app;
}

async function detailsWithDownloads(value) {
  const app = await detailsMetadata(value);
  app.downloads = await mapLimit(app.downloadCandidates, 3, resolveDownloadCandidate);
  app.downloads = app.downloads.filter(Boolean).filter((item, index, all) =>
    all.findIndex((candidate) => candidate.url === item.url) === index,
  );
  delete app.downloadCandidates;
  return app;
}

globalThis.source = {
  manifest: {
    id: 'apkmirror',
    name: 'APKMirror',
    version: '1.1.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: 'APKMirror 版本搜索、详情、变体和下载源。',
    permissions: {
      network: ['*'],
      browser: true,
      download: true,
      install: true,
    },
    debugProjects: [
      {
        id: 'search-keyword',
        name: 'Search APKMirror',
        description: 'Search APKMirror and inspect parsed release rows.',
        inputLabel: 'Keyword',
        placeholder: 'For example hello',
        defaultInput: 'hello',
      },
      {
        id: 'app-details',
        name: 'Read release details',
        description: 'Read release metadata, variants, and resolved download URLs.',
        inputLabel: 'Detail URL',
        placeholder: 'Paste an APKMirror release URL',
        defaultInput: 'https://www.apkmirror.com/apk/hello-heart/hello-heart-for-heart-health/hello-heart-for-heart-health-5-6-3-release/',
      },
    ],
  },

  async catalog() {
    return {
      defaultTabId: `${ORIGIN}/categories/game_action/`,
      tabs: [
        {id: `${ORIGIN}/categories/game_action/`, name: 'Action Games', description: 'Android action games', paged: false},
        {id: `${ORIGIN}/categories/game_adventure/`, name: 'Adventure Games', description: 'Android adventure games', paged: false},
        {id: `${ORIGIN}/categories/health_and_fitness/`, name: 'Health and Fitness', description: 'Health and fitness apps', paged: false},
      ],
    };
  },

  async catalogPage(tabId, page = 1) {
    const id = absoluteUrl(tabId);
    if (!/^https:\/\/www\.apkmirror\.com\/categories\/[^/?#]+\/?$/i.test(id)) {
      throw new TypeError('Invalid APKMirror catalog tab URL');
    }
    if (Math.max(1, Number(page) || 1) > 1) return {apps: [], hasMore: false};
    const url = id.replace(/\/+$/, '') + '/';
    try {
      const html = await fetchSearchText(url);
      if (html === null) return {apps: [], hasMore: false};
      return {
        apps: parseSearchResults(html),
        hasMore: false,
      };
    } catch (error) {
      const tab = await apkmesh.browser.open(url);
      try {
        await tab.waitFor('.appRow');
        const apps = browserSearchResults(await tab.queryAll('.appRow', {
          id: '.appRowTitle a@href',
          name: '.appRowTitle a@text',
          iconUrl: 'img.ellipsisText@src',
          updatedAt: '.dateyear_utc@text',
        }));
        return {apps, hasMore: false};
      } finally {
        await tab.close();
      }
    }
  },

  async search(query, page = 1) {
    const normalized = cleanText(query);
    if (normalized.length < 2) throw new TypeError('Search keyword must contain at least 2 characters');
    const url = searchUrl(normalized, page);
    try {
      const html = await fetchSearchText(url);
      if (html === null) return [];
      return parseSearchResults(html);
    } catch (error) {
      const tab = await apkmesh.browser.open(url);
      try {
        await tab.waitFor('.appRow');
        return browserSearchResults(await tab.queryAll('.appRow', {
          id: '.appRowTitle a@href',
          name: '.appRowTitle a@text',
          iconUrl: 'img.ellipsisText@src',
          updatedAt: '.dateyear_utc@text',
        }));
      } finally {
        await tab.close();
      }
    }
  },

  async detailsMetadata(url) {
    return detailsMetadata(url);
  },

  async resolveDownloads(candidates, requestId) {
    const resolved = await mapLimit(candidates || [], 3, async (item, index) => {
      const download = await resolveDownloadCandidate(item);
      await reportDetailProgress(requestId, index, download, download ? null : '无法解析下载链接');
      return download;
    });
    return resolved.filter(Boolean).filter((item, index, all) =>
      all.findIndex((candidate) => candidate.url === item.url) === index,
    );
  },

  async details(url) {
    return detailsWithDownloads(url);
  },

  async debug(projectId, input) {
    const value = cleanText(input);
    if (projectId === 'search-keyword') {
      const results = await this.search(value);
      return {
        title: 'Search completed',
        summary: `Found ${results.length} APKMirror releases for ${value}`,
        data: results.map((item) => ({
          name: item.name,
          id: item.id,
          version: item.version,
          updatedAt: item.updatedAt,
          iconUrl: item.iconUrl,
        })),
      };
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {
        title: 'Details completed',
        summary: `Read ${app.name} with ${(app.downloads || []).length} downloads`,
        data: {
          name: app.name,
          packageName: app.packageName,
          version: app.version,
          size: app.size,
          updatedAt: app.updatedAt,
          category: app.category,
          description: app.description,
          screenshots: app.screenshots,
          downloads: app.downloads,
        },
      };
    }
    throw new Error(`Unknown debug project: ${projectId}`);
  },
};
