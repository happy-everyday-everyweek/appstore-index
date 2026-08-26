/** Download.it Android source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://en.download.it';
const SEARCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  Referer: `${ORIGIN}/`,
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
};
const CATALOG_TABS = [
  {id: 'games', name: '游戏', description: 'Download.it Android 游戏', query: 'game'},
  {id: 'tools', name: '工具', description: 'Download.it Android 工具', query: 'tools'},
  {id: 'music', name: '音乐', description: 'Download.it Android 音乐应用', query: 'music'},
];

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

function absoluteUrl(value, base = ORIGIN) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  const originMatch = /^(https?:\/\/[^/]+)/i.exec(base || ORIGIN);
  const origin = originMatch ? originMatch[1] : ORIGIN;
  if (url.startsWith('/')) return `${origin}${url}`;
  const prefix = String(base || ORIGIN).replace(/\/[^/]*$/, '');
  return `${prefix}/${url}`;
}

function isAndroidUrl(url) {
  return /^https:\/\/[^/?#]+\.en\.download\.it\/android\/?(?:[?#].*)?$/i.test(url || '');
}

function isDetailUrl(url) {
  return /^https:\/\/[a-z0-9-]+\.en\.download\.it\/android\/?(?:[?#].*)?$/i.test(url || '');
}

function isDirectApkUrl(url) {
  return /^https:\/\/dl\.download\.it\/android\/[^?#]+\.apk(?:[?#].*)?$/i.test(url || '');
}

function extractVersion(value) {
  const match = /\bv?\d+(?:\.\d+)+(?:[._-]*(?:alpha|beta|rc)\b)?/i.exec(cleanText(value));
  return match ? match[0].replace(/^v/i, '') : '';
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function uniqueStrings(values) {
  return values
    .map((value) => absoluteUrl(value))
    .filter((value, index, all) => value && all.indexOf(value) === index);
}

function stripSearchTitle(value) {
  let title = cleanText(value);
  title = title.replace(/\s+(?:android|windows|mac|linux|ios)\s*(?:[—–-].*)?$/i, '');
  return title.replace(/\s+APK\s*$/i, '').trim();
}

function stripDetailTitle(value) {
  let title = cleanText(value);
  title = title.replace(/\s+for\s+Android\b.*$/i, '');
  title = title.replace(/\s+[—–-]\s+(?:Free|Trial|Full).*$/i, '');
  return title.replace(/\s+APK\s*$/i, '').trim();
}

function searchSlug(query) {
  return cleanText(query)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function searchUrl(query, page) {
  const slug = searchSlug(query);
  const number = Math.max(1, Number(page) || 1);
  if (!slug) throw new TypeError('搜索关键词不能为空');
  return `${ORIGIN}/s/${encodeURIComponent(slug)}${number > 1 ? `?page=${number}` : ''}`;
}

function isChallengePage(text) {
  return /attention required|enable cookies|unable to access download\.it|cloudflare/i.test(text || '');
}

function ensurePageAvailable(text) {
  if (isChallengePage(text)) {
    throw new Error('Download.it 当前返回 Cloudflare 验证页');
  }
}

function firstValue(values) {
  for (const value of values || []) {
    const result = cleanText(value);
    if (result) return result;
  }
  return '';
}

function parseSearchRows(rows) {
  const results = [];
  for (const row of rows || []) {
    const id = absoluteUrl(row.href || '');
    if (!isAndroidUrl(id)) continue;
    const rawTitle = firstValue([row.title, row.h1, row.h2, row.h3, row.h4, row.text]);
    if (!rawTitle) continue;
    const name = stripSearchTitle(rawTitle);
    if (!name) continue;
    const description = extractSearchDescription(row.text || rawTitle) ||
      cleanSearchDescription(row.description);
    results.push({
      id,
      name,
      packageName: '',
      version: extractVersion(rawTitle),
      size: extractSize(rawTitle),
      updatedAt: '',
      category: 'Android',
      iconUrl: absoluteUrl(firstValue([row.image, row.dataImage, row.lazyImage])),
      description,
    });
  }
  return results.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.id === item.id) === index,
  );
}

function cleanSearchDescription(value) {
  const text = cleanText(value);
  if (/^(?:android|windows|mac|linux|ios)\s*[—–-]\s*(?:free|trial|full)/i.test(text)) {
    return '';
  }
  return text;
}

function extractSearchDescription(value) {
  const text = cleanText(value);
  const match = /\s+(?:android|windows|mac|linux|ios)\s*[—–-]\s*(?:(?:free|trial(?:\s+version)?|full)\s*)?(.+)$/i.exec(text);
  return match ? cleanText(match[1]) : '';
}

function parseJsonLd(values) {
  for (const value of values || []) {
    try {
      const parsed = JSON.parse(cleanText(value.text));
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const application = items.find((item) => {
        const itemType = String(item && item['@type'] || '');
        return item && (
          itemType === 'SoftwareApplication' ||
          itemType === 'MobileApplication' ||
          /(?:Software|Mobile)Application$/i.test(itemType)
        );
      });
      if (application) return application;
    } catch (_) {
      // Ignore unrelated JSON-LD blocks.
    }
  }
  return {};
}

function rowValue(rows, labels) {
  const expected = labels.map((label) => cleanText(label).toLowerCase());
  for (const row of rows || []) {
    const label = cleanText(row.label).replace(/:$/, '').toLowerCase();
    if (expected.includes(label)) return cleanText(row.value);
    for (const candidate of expected) {
      if (label.startsWith(`${candidate} `)) {
        return cleanText(row.value || label.slice(candidate.length));
      }
    }
    const text = cleanText(row.text);
    for (const candidate of expected) {
      const match = new RegExp(`^${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'i').exec(text);
      if (match) return cleanText(match[1]);
    }
  }
  return '';
}

function structuredImage(value) {
  if (Array.isArray(value)) return structuredImage(value[0]);
  if (value && typeof value === 'object') return value.url || value.contentUrl || '';
  return value || '';
}

function structuredAuthor(value) {
  if (Array.isArray(value)) return structuredAuthor(value[0]);
  if (value && typeof value === 'object') return value.name || '';
  return value || '';
}

function downloadHeaders(referer) {
  return {...SEARCH_HEADERS, Referer: referer};
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

globalThis.source = {
  manifest: {
    id: 'downloadit',
    name: 'Download.it',
    version: '1.1.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 Download.it 的 Android 应用搜索、详情、截图和 APK 下载项。',
    permissions: {
      network: [
        'download.it',
        'en.download.it',
        '*.en.download.it',
        'static.download.it',
        'dl.download.it',
        'cdn.ditdlm.com',
      ],
      browser: true,
      download: true,
      install: false,
    },
    debugProjects: [
      {
        id: 'search-keyword',
        name: '搜索关键词',
        description: '通过 Download.it 搜索 Android 应用。',
        inputLabel: '关键词',
        placeholder: '例如 traps',
        defaultInput: 'traps',
      },
      {
        id: 'app-details',
        name: '获取应用详情',
        description: '读取详情页元数据、截图和 APK 下载链接。',
        inputLabel: '应用详情 URL',
        placeholder: '粘贴 *.en.download.it/android URL',
        defaultInput: 'https://trap-beats.en.download.it/android',
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
        paged: false,
      })),
    };
  },

  async catalogPage(tabId, page = 1) {
    const tab = CATALOG_TABS.find((item) => item.id === tabId);
    if (!tab) throw new TypeError('无效的 Download.it 目录标签');
    if (Math.max(1, Number(page) || 1) > 1) return {apps: [], hasMore: false};
    return {apps: await this.search(tab.query, 1), hasMore: false};
  },

  async search(query, page = 1) {
    const normalized = cleanText(query);
    if (normalized.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    const tab = await apkmesh.browser.open(searchUrl(normalized, page));
    try {
      await tab.waitFor('body');
      const pageInfo = await tab.query({body: 'body@text'});
      ensurePageAvailable(pageInfo.body);
      const rows = await tab.queryAll('a[href*=".en.download.it/"]', {
        href: '@href',
        title: 'title@text',
        h1: 'h1@text',
        h2: 'h2@text',
        h3: 'h3@text',
        h4: 'h4@text',
        text: '@text',
        description: 'p@text',
        image: 'img@src',
        dataImage: 'img@data-src',
        lazyImage: 'img@data-lazy-src',
      });
      return parseSearchRows(rows);
    } finally {
      await tab.close();
    }
  },

  async detailsMetadata(url) {
    const id = absoluteUrl(url);
    if (!isDetailUrl(id)) throw new TypeError('无效的 Download.it Android 详情地址');
    const openUrl = id.replace(/\/$/, '');
    const tab = await apkmesh.browser.open(openUrl);
    try {
      await tab.waitFor('body');
      const pageInfo = await tab.query({
        body: 'body@text',
        canonical: 'link[rel="canonical"]@href',
        title: 'h1@text',
        summary: 'meta[name="description"]@content',
        subtitle: 'h2.im-subtitle@text',
        ogImage: 'meta[property="og:image"]@content',
        icon: 'article#prg-main img@src',
        downloadPage: 'a[href*="/android/download"]@href',
        description: 'h2.im-subtitle, main p, article p, .description p, .program-description@text',
      });
      ensurePageAvailable(pageInfo.body);
      const rows = await tab.queryAll(
        '#dlbtn-info .col-12.col-sm-4, #dlbtn-info .col-12.border-bottom, tr, dl > div, li, .info-item, .details-item',
        {
          label: '.font-weight-bold p, .label, .name, th, dt, p:first-child@text',
          value: '.val-wrapper, .value, .detail, td:last-child, dd, span@text',
          text: '@text',
        },
      );
      const jsonLd = parseJsonLd(await tab.queryAll('script[type="application/ld+json"]', {
        text: '@text',
      }));
      let screenshotNodes = await tab.queryAll(
        'a[href*="static.download.it/scrs/"]',
        {link: '@href'},
      );
      let screenshots = uniqueStrings(screenshotNodes.map((item) => item.link));
      if (!screenshots.length) {
        screenshotNodes = await tab.queryAll(
          'img[src*="/scrs/"], img[data-src*="/scrs/"], img[data-lazy-src*="/scrs/"]',
          {
            src: '@src',
            dataSrc: '@data-src',
            lazySrc: '@data-lazy-src',
          },
        );
        screenshots = uniqueStrings(screenshotNodes.map((item) =>
          firstValue([item.src, item.dataSrc, item.lazySrc]),
        ));
      }
      if (!screenshots.length) {
        const structuredScreenshot = structuredImage(jsonLd.screenshot);
        if (structuredScreenshot) screenshots = uniqueStrings([structuredScreenshot]);
      }
      const name = stripDetailTitle(firstValue([
        pageInfo.title,
        jsonLd.name,
      ]));
      const summary = firstValue([
        pageInfo.summary,
        jsonLd.description,
      ]);
      const version = firstValue([
        rowValue(rows, ['Version', 'Latest version']),
        jsonLd.softwareVersion,
      ]);
      const app = {
        id: absoluteUrl(pageInfo.canonical || id),
        name,
        packageName: '',
        version,
        size: rowValue(rows, ['Size', 'File size']) || extractSize(pageInfo.body),
        updatedAt: rowValue(rows, ['Updated', 'Last updated', 'Date']),
        category: rowValue(rows, ['Category']) || cleanText(jsonLd.applicationCategory || 'Android'),
        iconUrl: absoluteUrl(firstValue([pageInfo.icon, pageInfo.ogImage, structuredImage(jsonLd.image)])),
        summary,
        description: firstValue([pageInfo.subtitle, pageInfo.description, summary]),
        author: rowValue(rows, ['Developer', 'Author']) || structuredAuthor(jsonLd.author),
        screenshots,
        comments: [],
      };
      const downloadPage = absoluteUrl(pageInfo.downloadPage || `${openUrl}/download`, openUrl);
      app.downloadCandidates = downloadPage
        ? [{
          label: `${name || '应用'} APK`,
          url: downloadPage,
          size: app.size,
          headers: downloadHeaders(openUrl),
        }]
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
        const tab = await apkmesh.browser.open(candidate.url);
        let downloads;
        try {
          await tab.waitFor('a[href^="https://dl.download.it/android/"]');
          const pageInfo = await tab.query({body: 'body@text'});
          ensurePageAvailable(pageInfo.body);
          const links = await tab.queryAll(
            'a[href*="dl.download.it/android/"], a[href$=".apk"], a[href*=".apk?"]',
            {url: '@href', text: '@text'},
          );
          downloads = links
            .map((item) => ({
              label: cleanText(item.text) || candidate.label,
              url: absoluteUrl(item.url, candidate.url),
              size: candidate.size || '',
              headers: downloadHeaders(candidate.url),
            }))
            .filter((item) => isDirectApkUrl(item.url))
            .filter((item, itemIndex, all) =>
              all.findIndex((other) => other.url === item.url) === itemIndex,
            );
        } finally {
          await tab.close();
        }
        if (!downloads.length) throw new Error('Download.it 未返回有效 APK 下载链接');
        await reportDetailProgress(requestId, index, downloads, null);
        resolved.push(...downloads);
      } catch (error) {
        await reportDetailProgress(requestId, index, [], error);
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
        title: '搜索完成',
        summary: `关键词“${value}”返回 ${results.length} 条 Android 结果`,
        data: results.map((item) => ({
          name: item.name,
          id: item.id,
          version: item.version,
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
          author: app.author,
          screenshots: app.screenshots.length,
          downloads: app.downloads.length,
        },
      };
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
