/** PDALIFE public-page source for APK Mesh's QuickJS contract. */
const ORIGIN = 'https://pdalife.com';
const FEATURED_TAB_ID = 'featured';
const CATALOG_TABS = [
  {id: FEATURED_TAB_ID, name: '推荐', paged: false},
  {id: `${ORIGIN}/android/games/`, name: '安卓游戏', paged: true},
  {id: `${ORIGIN}/android/programmy/`, name: '安卓应用', paged: true},
];

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    })[entity.toLowerCase()]);
}

function cleanText(value) {
  return decodeHtml(String(value || '').replace(/\s+/g, ' ')).trim();
}

function absoluteUrl(value, baseUrl = ORIGIN) {
  const url = cleanText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  const originMatch = /^https?:\/\/[^/]+/i.exec(baseUrl);
  const origin = originMatch ? originMatch[0] : ORIGIN;
  if (url.startsWith('/')) return `${origin}${url}`;
  const directory = baseUrl.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
  return `${directory}${url}`;
}

function canonicalSourceUrl(value) {
  const url = absoluteUrl(value).replace(/[?#].*$/, '');
  const match = /^https:\/\/(?:www\.)?pdalife\.com(\/.*)$/i.exec(url);
  return match ? `${ORIGIN}${match[1].replace(/\/{2,}/g, '/')}` : '';
}

function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(cleanText(value));
}

function isAppUrl(value) {
  return /^https:\/\/pdalife\.com\/[a-z0-9][a-z0-9-]*-android-a\d+\.html$/i.test(
    canonicalSourceUrl(value),
  );
}

function firstValue(...values) {
  return values.map(cleanText).find(Boolean) || '';
}

function imageValue(item, baseUrl) {
  return absoluteUrl(firstValue(
    item.dataSrc,
    item.dataLazySrc,
    item.dataOriginal,
    item.src,
  ), baseUrl);
}

function screenshotUrl(item, baseUrl) {
  return imageValue(item, baseUrl).replace(/\/th_([^/]+)$/i, '/$1');
}

function extractVersion(value) {
  const match = /\bv?\d+(?:\.\d+)+(?:[A-Za-z][\w.-]*)?/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function extractSize(value) {
  const match = /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.exec(cleanText(value));
  return match ? match[0] : '';
}

function uniqueBy(items, field) {
  return items.filter((item, index, all) =>
    item && item[field] && all.findIndex((candidate) => candidate[field] === item[field]) === index,
  );
}

function packageNameFromStoreUrl(value) {
  const match = /[?&]id=([^&#]+)/i.exec(cleanText(value));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]).trim();
  } catch (_) {
    return match[1].trim();
  }
}

function searchSlug(query) {
  return encodeURIComponent(cleanText(query).toLowerCase().replace(/\s+/g, '-'));
}

function searchUrl(query, page) {
  const number = Math.max(1, Number(page) || 1);
  const base = `${ORIGIN}/search/${searchSlug(query)}`;
  return number > 1 ? `${base}/page-${number}/` : `${base}/`;
}

function listingUrl(tabId, page) {
  const number = Math.max(1, Number(page) || 1);
  const base = canonicalSourceUrl(tabId).replace(/\/+$/, '');
  return number > 1 ? `${base}/page-${number}/` : `${base}/`;
}

function isNotFound(page) {
  return /\b(?:404|page not found)\b/i.test(`${cleanText(page.title)} ${cleanText(page.heading)}`);
}

function assertPublicPage(page) {
  const value = `${cleanText(page.title)} ${cleanText(page.body)}`;
  if (/just a moment|security verification|enable javascript and cookies to continue/i.test(value)) {
    throw new Error('PDALIFE is protected by a Cloudflare verification page');
  }
}

async function pageState(tab, readySelector) {
  try {
    await tab.waitFor(readySelector);
  } catch (_) {
    // Inspect the current DOM below to distinguish an empty page from a challenge.
  }
  return tab.query({
    title: 'title@text',
    heading: 'h1@text',
    body: 'body@text',
    maxPage: '.js-load_more@data-max_page',
    currentPage: '.js-load_more@data-current_page',
  });
}

function mapCatalogItems(nodes, pageUrl) {
  return uniqueBy((nodes || []).map((item) => {
    const id = canonicalSourceUrl(absoluteUrl(item.url, pageUrl));
    const name = cleanText(item.name || item.alt);
    if (!isAppUrl(id) || !name) return null;
    return {
      id,
      name,
      packageName: '',
      version: extractVersion(item.version),
      size: '',
      updatedAt: cleanText(item.updatedAt),
      category: cleanText(item.category),
      iconUrl: imageValue(item, pageUrl),
    };
  }).filter(Boolean), 'id');
}

async function loadCatalogListing(url) {
  const tab = await apkmesh.browser.open(url);
  try {
    const page = await pageState(tab, 'ul.catalog-list, li.slim-app__item, h1');
    assertPublicPage(page);
    if (isNotFound(page)) return {apps: [], hasMore: false};
    let nodes = await tab.queryAll('ul.catalog-list > li.catalog-item', {
      url: '.catalog-item__title a@href',
      name: '.catalog-item__title@text',
      version: '.catalog-item__version@text',
      updatedAt: '.catalog-item__date@text',
      category: '.catalog-item__genre-button@text',
      src: '.catalog-item__poster img@src',
      dataSrc: '.catalog-item__poster img@data-src',
      dataLazySrc: '.catalog-item__poster img@data-lazy-src',
      dataOriginal: '.catalog-item__poster img@data-original',
      alt: '.catalog-item__poster img@alt',
    });
    if (!nodes.length) {
      nodes = await tab.queryAll('main li.slim-app__item', {
        url: 'a.slim-app__link@href',
        name: '.slim-app__title@text',
        src: 'img@src',
        dataSrc: 'img@data-src',
        dataLazySrc: 'img@data-lazy-src',
        dataOriginal: 'img@data-original',
        alt: 'img@alt',
      });
    }
    const currentPage = Math.max(1, Number(page.currentPage) || 1);
    const maxPage = Math.max(currentPage, Number(page.maxPage) || currentPage);
    return {apps: mapCatalogItems(nodes, url).slice(0, 24), hasMore: currentPage < maxPage};
  } finally {
    await tab.close();
  }
}

async function loadFeatured() {
  const tab = await apkmesh.browser.open(`${ORIGIN}/`);
  try {
    const page = await pageState(tab, 'li.js-feed-item');
    assertPublicPage(page);
    const nodes = await tab.queryAll('li.js-updated-item, li.js-feed-item:not(:has(.js-updated-item))', {
      url: '.feed__item-title@href',
      name: '.feed__item-title@text',
      version: '.feed__item-caption@text',
      category: '.feed__item-tags a@text',
      src: '.feed__item-pictogram img@src',
      dataSrc: '.feed__item-pictogram img@data-src',
      dataLazySrc: '.feed__item-pictogram img@data-lazy-src',
      dataOriginal: '.feed__item-pictogram img@data-original',
      alt: '.feed__item-pictogram img@alt',
    });
    return mapCatalogItems(nodes, `${ORIGIN}/`).slice(0, 24);
  } finally {
    await tab.close();
  }
}

function detailRow(rows, label) {
  const expected = cleanText(label).toLowerCase();
  const row = (rows || []).find((item) => cleanText(item.label).toLowerCase() === expected);
  return row ? cleanText(row.value) : '';
}

function candidateLabel(item, fallbackName) {
  const version = cleanText(item.version);
  const type = cleanText(item.label).replace(/^download\s*/i, '');
  return [fallbackName, version, type].filter(Boolean).join(' - ');
}

function isDownloadCandidate(value) {
  return /^https:\/\/pdalife\.com\/dwn\/[a-z0-9]+\.html(?:\?[^#]*)?$/i.test(absoluteUrl(value));
}

function mobdiscPageUrl(candidateUrl) {
  const match = /^https:\/\/pdalife\.com\/dwn\/([a-z0-9]+)\.html(?:\?([^#]*))?$/i.exec(candidateUrl);
  return match
    ? `https://mobdisc.com/dw${match[1]}/download.html${match[2] ? `?${match[2]}` : ''}`
    : 'https://mobdisc.com/';
}

async function resolveDownloadCandidate(candidate) {
  const candidateUrl = absoluteUrl(candidate.url);
  if (!isDownloadCandidate(candidateUrl)) throw new TypeError('无效的 PDALIFE 下载候选地址');
  const tab = await apkmesh.browser.open(candidateUrl);
  try {
    try {
      await tab.waitFor('.js-dwn-btn:not(.b-download__button_state_inactive)');
    } catch (_) {
      // Read the button below so failure includes the actual page state.
    }
    const page = await tab.query({
      title: 'title@text',
      body: 'body@text',
      url: '.js-dwn-btn@href',
      className: '.js-dwn-btn@class',
      size: '.js-dwn-btn .download-size@text',
    });
    const url = absoluteUrl(page.url, 'https://mobdisc.com/');
    if (/b-download__button_state_inactive/i.test(cleanText(page.className)) ||
        !isHttpUrl(url) || /#\/download\//i.test(url)) {
      const challenged = /captcha|verify you are human|security check/i.test(
        `${cleanText(page.title)} ${cleanText(page.body)}`,
      );
      throw new Error(challenged
        ? 'MobDisc download verification did not complete'
        : 'MobDisc did not expose a signed download URL');
    }
    return {
      label: cleanText(candidate.label) || 'APK',
      url,
      size: extractSize(page.size) || cleanText(candidate.size),
      headers: {Referer: mobdiscPageUrl(candidateUrl)},
    };
  } finally {
    await tab.close();
  }
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
    // Progress delivery must not hide the resolver result.
  }
}

globalThis.source = {
  manifest: {
    id: 'pdalife',
    name: 'PDALIFE',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    description: '读取 PDALIFE 的安卓应用与游戏搜索、目录、详情、截图和下载项。',
    permissions: {
      network: ['*'],
      browser: true,
      download: true,
      install: false,
    },
    debugProjects: [
      {
        id: 'search-keyword',
        name: '搜索关键词',
        description: '在 PDALIFE 公开搜索页检查安卓应用与游戏结果。',
        inputLabel: '关键词',
        placeholder: '例如 minecraft',
        defaultInput: 'minecraft',
      },
      {
        id: 'app-details',
        name: '获取应用详情',
        description: '读取 PDALIFE 详情页元数据、截图和公开下载链接。',
        inputLabel: '应用详情 URL',
        placeholder: '粘贴 PDALIFE 安卓应用 URL',
        defaultInput: 'https://pdalife.com/google-service-android-a11744.html',
      },
    ],
  },

  async catalog() {
    return {defaultTabId: FEATURED_TAB_ID, tabs: CATALOG_TABS};
  },

  async catalogPage(tabId, page = 1) {
    const number = Math.max(1, Number(page) || 1);
    if (tabId === FEATURED_TAB_ID) {
      return number > 1
        ? {apps: [], hasMore: false}
        : {apps: await loadFeatured(), hasMore: false};
    }
    if (!CATALOG_TABS.some((tab) => tab.id === tabId)) throw new TypeError('无效的目录标签');
    return loadCatalogListing(listingUrl(tabId, number));
  },

  async search(query, page = 1) {
    const normalized = cleanText(query);
    if (normalized.length < 2) throw new TypeError('搜索关键词至少需要 2 个字符');
    return (await loadCatalogListing(searchUrl(normalized, page))).apps;
  },

  async detailsMetadata(value) {
    const url = canonicalSourceUrl(value);
    if (!isAppUrl(url)) throw new TypeError('无效的 PDALIFE 安卓应用地址');
    const tab = await apkmesh.browser.open(url);
    try {
      const page = await pageState(tab, 'h1.publication-title');
      assertPublicPage(page);
      if (isNotFound(page)) throw new Error('PDALIFE 详情页不存在');
      const fields = await tab.query({
        name: 'h1.publication-title@text',
        version: '.accordion-title strong@text',
        iconSrc: '.game__poster-picture@src',
        iconDataSrc: '.game__poster-picture@data-src',
        iconDataLazySrc: '.game__poster-picture@data-lazy-src',
        iconDataOriginal: '.game__poster-picture@data-original',
        summary: 'meta[name="description"]@content',
        description: '.game__description@text',
        releaseNotes: '.accordion-item_state_active .js-changes-wrapper@text',
        storeUrl: '.game-download__stores a[href*="play.google.com/store/apps/details"]@href',
      });
      const rows = await tab.queryAll('.game-short__item', {
        label: '.game-short__label-text@text',
        value: '.game-short__control@text',
      });
      const screenshots = await tab.queryAll('.game-gallery img', {
        src: '@src',
        dataSrc: '@data-src',
        dataLazySrc: '@data-lazy-src',
        dataOriginal: '@data-original',
      });
      const comments = await tab.queryAll('#commentsBlock .comment-content', {
        text: '.comment__text@text',
      });
      const downloadNodes = await tab.queryAll('.accordion-item', {
        version: '.accordion-title strong@text',
        label: '.game-versions__downloads-label@text',
        size: '.game-versions__downloads-size@text',
        url: '.game-versions__downloads-button@href',
      });
      const name = cleanText(fields.name);
      if (!name) throw new Error('PDALIFE 详情页未提供应用名称');
      const candidates = uniqueBy(downloadNodes.map((item) => ({
        label: candidateLabel(item, name),
        url: absoluteUrl(item.url, url),
        size: extractSize(item.size),
      })).filter((item) => isDownloadCandidate(item.url)), 'url').slice(0, 12);
      return {
        id: url,
        name,
        packageName: packageNameFromStoreUrl(fields.storeUrl),
        version: extractVersion(fields.version),
        size: candidates.length ? candidates[0].size : '',
        updatedAt: detailRow(rows, 'Update date'),
        category: detailRow(rows, 'Category'),
        iconUrl: imageValue({
          src: fields.iconSrc,
          dataSrc: fields.iconDataSrc,
          dataLazySrc: fields.iconDataLazySrc,
          dataOriginal: fields.iconDataOriginal,
        }, url),
        summary: cleanText(fields.summary),
        description: cleanText(fields.description),
        screenshots: uniqueBy(screenshots.map((item) => ({
          url: screenshotUrl(item, url),
        })).filter((item) => isHttpUrl(item.url)), 'url').map((item) => item.url),
        comments: uniqueBy(comments.map((item) => ({text: cleanText(item.text)}))
          .filter((item) => item.text), 'text').map((item) => item.text),
        downloadCandidates: candidates,
      };
    } finally {
      await tab.close();
    }
  },

  async resolveDownloads(candidates, requestId) {
    const downloads = [];
    const errors = [];
    for (let index = 0; index < (candidates || []).length; index += 1) {
      try {
        const download = await resolveDownloadCandidate(candidates[index]);
        downloads.push(download);
        await reportProgress(requestId, index, [download], null);
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
      const results = await this.search(value);
      return {
        title: '搜索完成',
        summary: `关键词“${value}”返回 ${results.length} 条安卓结果`,
        data: results,
      };
    }
    if (projectId === 'app-details') {
      const app = await this.details(value);
      return {
        title: '详情读取完成',
        summary: `已读取 ${app.name}；下载项 ${app.downloads.length} 个`,
        data: app,
      };
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
