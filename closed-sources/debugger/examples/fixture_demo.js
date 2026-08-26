const ORIGIN = 'https://example.test';

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function absolute(url) {
  if (String(url).startsWith('/')) return `${ORIGIN}${url}`;
  return String(url);
}

globalThis.source = {
  manifest: {
    id: 'fixture-demo',
    name: 'Fixture Demo',
    version: '1.0.0',
    minApiVersion: 1,
    homepage: `${ORIGIN}/`,
    packageLookup: true,
    permissions: {
      network: ['example.test'],
      browser: true,
      download: false,
      install: false,
    },
    debugProjects: [
      {
        id: 'search-keyword',
        name: '搜索关键词',
        description: '通过 HTTP fixture 验证源搜索。',
        inputLabel: '关键词',
        placeholder: '例如 demo',
        defaultInput: 'demo',
      },
      {
        id: 'app-details',
        name: '读取详情',
        description: '通过浏览器 fixture 验证 DOM 查询。',
        inputLabel: '详情 URL',
        placeholder: 'https://example.test/details/demo',
        defaultInput: `${ORIGIN}/details/demo`,
      },
    ],
  },

  async search(query, page = 1) {
    const html = await apkmesh.request(
      `${ORIGIN}/search?q=${encodeURIComponent(query)}`,
    );
    const match = /data-id="([^"]+)"[\s\S]*?data-name="([^"]+)"/.exec(html);
    if (!match) return [];
    return [{
      id: absolute(match[1]),
      name: text(match[2]),
      page,
      packageName: 'com.example.demo',
    }];
  },

  packageLookupUrl(packageName) {
    const normalized = String(packageName || '').trim().toLowerCase();
    return normalized === 'com.example.demo' ? `${ORIGIN}/details/demo` : null;
  },

  async details(url) {
    const tab = await apkmesh.browser.open(url);
    try {
      await tab.waitFor('#MobileApplication');
      const app = await tab.query({
        name: '.title@text',
        version: '.version@text',
        iconUrl: '.icon@src',
        description: '.description@text',
      });
      const rows = await tab.queryAll('.appinfo tr', {
        label: 'th@text',
        value: 'td@text',
      });
      app.id = absolute(url);
      app.name = text(app.name);
      app.version = text(app.version);
      app.iconUrl = absolute(app.iconUrl);
      app.description = text(app.description);
      app.packageName = rows.find((row) => row.label === 'Package name')?.value || '';
      return app;
    } finally {
      await tab.close();
    }
  },

  async debug(projectId, input) {
    if (projectId === 'search-keyword') {
      const results = await this.search(input);
      return {title: '搜索完成', summary: `返回 ${results.length} 条结果`, data: results};
    }
    if (projectId === 'app-details') {
      const result = await this.details(input);
      return {title: '详情读取完成', summary: result.name, data: result};
    }
    throw new Error(`未知调试项目：${projectId}`);
  },
};
