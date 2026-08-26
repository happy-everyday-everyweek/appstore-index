from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import Browser, BrowserContext, Page, Route, sync_playwright

from .models import BrowserTab, ReplayMiss, ResponseData
from .policy import SourcePolicy
from .replay import RecordingStore, ReplayStore
from .trace import TraceRecorder


_QUERY_SCRIPT = """
({selectors}) => {
  const read = (root, raw) => {
    const selector = Array.isArray(raw) ? raw[0] : raw;
    const parts = String(selector ?? '').split('@');
    const css = parts.shift().trim();
    const attr = parts.length ? parts.join('@').trim() : null;
    const element = css ? root.querySelector(css) : root;
    if (!element) return null;
    if (attr === null || attr === 'text') {
      return (element.textContent || '').trim();
    }
    return (element.getAttribute(attr) || '').trim();
  };
  const result = {};
  for (const [key, selector] of Object.entries(selectors || {})) {
    result[key] = read(document, selector);
  }
  return result;
}
"""

_QUERY_ALL_SCRIPT = """
({rootSelector, selectors}) => {
  const read = (root, raw) => {
    const selector = Array.isArray(raw) ? raw[0] : raw;
    const parts = String(selector ?? '').split('@');
    const css = parts.shift().trim();
    const attr = parts.length ? parts.join('@').trim() : null;
    const element = css ? root.querySelector(css) : root;
    if (!element) return null;
    if (attr === null || attr === 'text') {
      return (element.textContent || '').trim();
    }
    return (element.getAttribute(attr) || '').trim();
  };
  return Array.from(document.querySelectorAll(rootSelector)).map(root => {
    const result = {};
    for (const [key, selector] of Object.entries(selectors || {})) {
      result[key] = read(root, selector);
    }
    return result;
  });
}
"""


@dataclass
class _TabState:
    info: BrowserTab
    context: BrowserContext
    page: Page


class BrowserHost:
    def __init__(
        self,
        policy: SourcePolicy,
        trace: TraceRecorder,
        *,
        mode: str = "live",
        replay: ReplayStore | None = None,
        recording: RecordingStore | None = None,
        timeout: float = 30.0,
        headed: bool = False,
        user_agent: str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
    ) -> None:
        self.policy = policy
        self.trace = trace
        self.mode = mode
        self.replay = replay
        self.recording = recording
        self.timeout = timeout
        self.headed = headed
        self.user_agent = user_agent
        self._playwright = None
        self._browser: Browser | None = None
        self._tabs: dict[str, _TabState] = {}
        self._history: list[BrowserTab] = []
        self._sequence = 0

    def open(self, url: str) -> str:
        self.policy.check(url, "browser")
        self._ensure_browser()
        assert self._browser is not None
        self._sequence += 1
        tab_id = f"python-{self._sequence}"
        context = self._browser.new_context(
            java_script_enabled=True,
            user_agent=self.user_agent,
            service_workers="block",
        )
        context.route("**/*", self._handle_route)
        page = context.new_page()
        page.on(
            "request",
            lambda request: self._on_request(tab_id, request),
        )
        page.on(
            "response",
            lambda response: self._on_response(tab_id, response),
        )
        info = BrowserTab(
            id=tab_id,
            url=url,
            state="starting",
            started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
        self._tabs[tab_id] = _TabState(info=info, context=context, page=page)
        self.trace.add("browser.open", tab_id=tab_id, url=url, mode=self.mode)
        try:
            navigation = page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=self._timeout_ms(),
            )
            self._set_state(tab_id, "ready", page.url)
            self._record_page_snapshot(page, navigation)
        except Exception as error:
            self._set_state(tab_id, "load-error", page.url or url)
            self.trace.add("browser.error", tab_id=tab_id, url=url, error=str(error))
            raise
        return tab_id

    def wait_for(self, tab_id: str, selector: str) -> None:
        tab = self._tab(tab_id)
        self._set_state(tab_id, f"waiting: {selector}", tab.page.url)
        self.trace.add("browser.wait_for", tab_id=tab_id, selector=selector)
        try:
            tab.page.wait_for_selector(
                selector,
                state="attached",
                timeout=self._timeout_ms(),
            )
        except PlaywrightTimeoutError as error:
            self._set_state(tab_id, "wait-timeout", tab.page.url)
            raise TimeoutError(f"selector wait timed out: {selector}") from error
        self._set_state(tab_id, "ready", tab.page.url)

    def wait_for_url_change(self, tab_id: str, previous_url: str) -> str:
        tab = self._tab(tab_id)
        self._set_state(tab_id, "waiting: URL change", tab.page.url)
        self.trace.add(
            "browser.wait_for_url_change",
            tab_id=tab_id,
            previous_url=previous_url,
        )
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            current_url = tab.info.url
            if current_url and current_url != previous_url:
                self._set_state(tab_id, "ready", current_url)
                return current_url
            tab.page.wait_for_timeout(200)
        self._set_state(tab_id, "wait-timeout", tab.info.url)
        raise TimeoutError(f"URL change timed out: {previous_url}")

    def query(self, tab_id: str, selectors: dict[str, Any]) -> dict[str, Any]:
        tab = self._tab(tab_id)
        self.trace.add("browser.query", tab_id=tab_id, selectors=selectors)
        result = tab.page.evaluate(_QUERY_SCRIPT, {"selectors": selectors})
        return result if isinstance(result, dict) else {}

    def query_all(
        self,
        tab_id: str,
        root_selector: str,
        selectors: dict[str, Any],
    ) -> list[dict[str, Any]]:
        tab = self._tab(tab_id)
        self.trace.add(
            "browser.query_all",
            tab_id=tab_id,
            root_selector=root_selector,
            selectors=selectors,
        )
        result = tab.page.evaluate(
            _QUERY_ALL_SCRIPT,
            {"rootSelector": root_selector, "selectors": selectors},
        )
        return [item for item in result if isinstance(item, dict)] if isinstance(result, list) else []

    def close(self, tab_id: str) -> None:
        tab = self._tabs.pop(tab_id, None)
        if tab is None:
            return
        self.trace.add("browser.close", tab_id=tab_id, url=tab.page.url)
        self._set_state(tab_id, "closed", tab.page.url, tab=tab.info)
        self._history.insert(0, self._tab_info(tab.info, "closed", tab.page.url))
        try:
            tab.context.close()
        except PlaywrightError as error:
            self.trace.add("browser.error", tab_id=tab_id, error=str(error))

    def tabs(self) -> list[BrowserTab]:
        active = [state.info for state in self._tabs.values()]
        return active + self._history

    def close_all(self) -> None:
        for tab_id in list(self._tabs):
            self.close(tab_id)
        if self._browser is not None:
            self._browser.close()
            self._browser = None
        if self._playwright is not None:
            self._playwright.stop()
            self._playwright = None

    def _on_request(self, tab_id: str, request) -> None:
        if request.is_navigation_request() and request.frame == request.frame.page.main_frame:
            tab = self._tabs.get(tab_id)
            if tab is not None and request.url != tab.info.url:
                self._set_state(tab_id, "navigating", request.url)
        self.trace.add(
            "browser.request",
            tab_id=tab_id,
            url=request.url,
            method=request.method,
            resource_type=request.resource_type,
        )

    def _on_response(self, tab_id: str, response) -> None:
        tab = self._tabs.get(tab_id)
        if (
            tab is not None
            and response.request.resource_type == "document"
            and response.frame == response.frame.page.main_frame
            and response.url != tab.info.url
        ):
            self._set_state(tab_id, "navigating", response.url)
        self.trace.add(
            "browser.response",
            tab_id=tab_id,
            url=response.url,
            status=response.status,
            resource_type=response.request.resource_type,
        )

    def _record_page_snapshot(self, page: Page, navigation) -> None:
        if self.recording is None:
            return
        try:
            body = page.content().encode("utf-8")
        except PlaywrightError as error:
            self.trace.add("recording.error", url=page.url, error=str(error))
            return
        status = navigation.status if navigation is not None else 200
        headers = {"content-type": "text/html; charset=utf-8"}
        if navigation is not None:
            try:
                headers = dict(navigation.all_headers())
            except PlaywrightError:
                pass
        self.recording.record(
            "GET",
            page.url,
            ResponseData(
                status_code=status,
                headers=headers,
                body=body,
                url=page.url,
            ),
        )
        self.trace.add(
            "recording.page_snapshot",
            url=page.url,
            bytes=len(body),
        )

    def _handle_route(self, route: Route) -> None:
        url = route.request.url
        self.trace.add(
            "browser.request",
            url=url,
            method=route.request.method,
            resource_type=route.request.resource_type,
        )
        if url.startswith(("http://", "https://")) and not self.policy.permits(url):
            self.trace.add("browser.blocked", url=url, reason="source policy")
            route.fulfill(
                status=403,
                content_type="text/plain",
                body="blocked by source policy",
            )
            return
        if self.mode == "replay" and url.startswith(("http://", "https://")):
            if self.replay is None:
                raise RuntimeError("replay mode requires a ReplayStore")
            try:
                response = self.replay.get(route.request.method, url)
            except ReplayMiss:
                self.trace.add("replay.miss", method=route.request.method, url=url)
                route.abort("blockedbyclient")
                return
            route.fulfill(
                status=response.status_code,
                headers=response.headers,
                body=response.body,
            )
            return
        route.continue_()

    def _ensure_browser(self) -> None:
        if self._browser is not None:
            return
        self._playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.launch(headless=not self.headed)

    def _tab(self, tab_id: str) -> _TabState:
        try:
            return self._tabs[tab_id]
        except KeyError as error:
            raise KeyError(f"browser tab does not exist: {tab_id}") from error

    def _set_state(
        self,
        tab_id: str,
        state: str,
        url: str,
        *,
        tab: BrowserTab | None = None,
    ) -> None:
        current = tab or self._tabs.get(tab_id, None)
        if isinstance(current, _TabState):
            info = current.info
        elif isinstance(current, BrowserTab):
            info = current
        else:
            return
        if isinstance(current, _TabState):
            current.info = self._tab_info(info, state, url)
        self.trace.add("browser.state", tab_id=tab_id, state=state, url=url)

    @staticmethod
    def _tab_info(info: BrowserTab, state: str, url: str) -> BrowserTab:
        return BrowserTab(
            id=info.id,
            url=url,
            state=state,
            started_at=info.started_at,
        )

    def _timeout_ms(self) -> int:
        return max(1, int(self.timeout * 1000))
