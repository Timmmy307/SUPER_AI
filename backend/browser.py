import asyncio
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup
from readability import Document
from typing import Tuple

from settings import settings

async def _open(url: str, screenshot_path: str | None) -> Tuple[str, bytes | None]:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            user_agent=settings.user_agent,
            viewport={"width": 1366, "height": 900}
        )
        page = await ctx.new_page()
        await page.goto(url, wait_until="networkidle", timeout=30000)
        html = await page.content()
        img = None
        if screenshot_path:
            await page.screenshot(path=screenshot_path, full_page=True)
            with open(screenshot_path, "rb") as f:
                img = f.read()
        await browser.close()
        return html, img

def extract_readable_text(html: str) -> str:
    # Try Readability first, fallback to plain text from BeautifulSoup
    try:
        doc = Document(html)
        parsed = BeautifulSoup(doc.summary(html_partial=True), "lxml")
        text = parsed.get_text(separator="\n", strip=True)
        return text if text and len(text) > 80 else BeautifulSoup(html, "lxml").get_text(separator="\n", strip=True)
    except Exception:
        return BeautifulSoup(html, "lxml").get_text(separator="\n", strip=True)

async def fetch_page(url: str, want_screenshot: bool) -> Tuple[str, bytes | None]:
    screenshot_path = "page.png" if want_screenshot else None
    html, img = await _open(url, screenshot_path)
    text = extract_readable_text(html)
    return text, img
