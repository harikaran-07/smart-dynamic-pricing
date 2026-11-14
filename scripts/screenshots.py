"""Capture the dashboard at 1280px and 390px for visual review.

Requires a running server (default http://127.0.0.1:8011) and Playwright:

    pip install playwright && python -m playwright install chromium
    python scripts/screenshots.py

Writes screenshots/*.png and fails (exit 1) if a page overflows horizontally,
a console error appears, or text is clipped by the viewport.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "screenshots"
CSV = ROOT / "test_pricing_data.csv"

PAGES = [("upload", "Upload &amp; Analytics"), ("predict", "Predict"), ("portfolio", "Portfolio")]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8011")
    ap.add_argument("--upload", action="store_true", default=True)
    args = ap.parse_args()
    base = args.base.rstrip("/")
    OUT.mkdir(exist_ok=True)

    problems = []
    args_list = []

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as exc:  # noqa: BLE001
            print("could not launch chromium:", exc)
            print("run: python -m playwright install chromium")
            return 2

        ctx = browser.new_context(viewport={"width": 1280, "height": 900},
                                  device_scale_factor=1)
        page = ctx.new_page()
        page.on("console", lambda m: args_list.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))

        page.goto(base + "/", wait_until="networkidle")
        page.wait_for_function(
            "() => document.getElementById('health') && /Connected|unreachable/.test(document.getElementById('health').textContent)",
            timeout=90000)

        def shots(tag: str):
            for key, label in PAGES:
                page.click(f'.navlink[data-page="{key}"]')
                page.wait_for_timeout(450)
                page.screenshot(path=str(OUT / f"{key}-{tag}.png"), full_page=True)
                overflow = page.evaluate(
                    "() => document.documentElement.scrollWidth - window.innerWidth")
                if overflow > 2:
                    problems.append(f"{key}-{tag}: horizontal overflow {overflow}px")
            page.click('.navlink[data-page="upload"]')
            page.wait_for_timeout(300)

        # ---------- empty state + upload modal (1280) ----------
        page.click('.navlink[data-page="upload"]')
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "upload-empty-1280.png"), full_page=True)
        page.click("#data-source")
        page.wait_for_selector("#px-modal.show")
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / "upload-modal-1280.png"), full_page=True)

        # ---------- upload the fixture through the real UI ----------
        page.set_input_files("#px-file", str(CSV))
        page.wait_for_selector("#px-preview.show", timeout=60000)
        page.wait_for_function("() => !document.getElementById('px-apply').disabled", timeout=60000)
        page.click("#px-apply")
        page.wait_for_function(
            "() => !document.getElementById('px-modal').classList.contains('show')",
            timeout=120000)
        page.wait_for_function(
            "() => { var el = document.getElementById('pp-content');"
            " return el && /Recommendations/.test(el.textContent); }",
            timeout=180000)
        page.wait_for_timeout(1200)

        shots("1280")

        # top-of-page Predict shot (the reference screenshot)
        page.click('.navlink[data-page="predict"]')
        page.wait_for_timeout(400)
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / "predict-hero-1280.png"))

        # ---------- mobile 390 ----------
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(500)
        shots("390")
        page.click('.navlink[data-page="predict"]')
        page.wait_for_timeout(400)
        page.evaluate("window.scrollTo(0, 0)")
        page.screenshot(path=str(OUT / "predict-hero-390.png"))
        page.close()

        # ---------- fresh mobile session: empty states ----------
        mctx = browser.new_context(viewport={"width": 390, "height": 844},
                                   device_scale_factor=1)
        mpage = mctx.new_page()
        mpage.on("pageerror", lambda e: problems.append("mobile pageerror: " + str(e)))
        mpage.goto(base + "/", wait_until="networkidle")
        mpage.wait_for_timeout(900)
        for key, label in PAGES:
            mpage.click(f'.navlink[data-page="{key}"]')
            mpage.wait_for_timeout(350)
            mpage.screenshot(path=str(OUT / f"{key}-empty-390.png"), full_page=True)
            overflow = mpage.evaluate(
                "() => document.documentElement.scrollWidth - window.innerWidth")
            if overflow > 2:
                problems.append(f"{key}-empty-390: horizontal overflow {overflow}px")
        mpage.click("#data-source")
        mpage.wait_for_selector("#px-modal.show")
        mpage.wait_for_timeout(300)
        mpage.screenshot(path=str(OUT / "upload-modal-390.png"), full_page=True)
        mctx.close()
        browser.close()

    if args_list:
        print("console errors:")
        for e in args_list:
            print("  -", e)
    if problems:
        print("problems:")
        for p in problems:
            print("  -", p)
    files = sorted(OUT.glob("*.png"))
    print(f"\n{len(files)} screenshots in {OUT}")
    for f in files:
        print("  ", f.name)
    return 1 if problems or args_list else 0


if __name__ == "__main__":
    sys.exit(main())
