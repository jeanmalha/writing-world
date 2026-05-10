#!/usr/bin/env python3
"""
Writing World smoke tests using Nova Act.

Actions are performed via nova.act() (natural-language browser control).
Assertions use nova.page.evaluate() (direct Playwright DOM checks) — fast and reliable.

Usage:
  python3 tests/smoke.py [--url https://lore.malha.land]

Requires:
  pip install nova-act
  NOVA_ACT_API_KEY set in infra/deploy.env or the environment
"""

import sys, os, time, argparse

# ── Bootstrap: load infra/deploy.env ─────────────────────────────────────────

_env_path = os.path.join(os.path.dirname(__file__), '..', 'infra', 'deploy.env')
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith('#') and '=' in _line:
                k, v = _line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

try:
    from nova_act import NovaAct
except ImportError:
    print("nova-act not installed.  Run: pip install nova-act")
    sys.exit(1)

parser = argparse.ArgumentParser(description='Writing World smoke tests')
parser.add_argument('--url', default='https://lore.malha.land', help='App URL to test')
args = parser.parse_args()

APP_URL = args.url
API_KEY = os.environ.get('NOVA_ACT_API_KEY', '')
if not API_KEY:
    print("Error: NOVA_ACT_API_KEY not set.\n"
          "Add  NOVA_ACT_API_KEY=<key>  to infra/deploy.env or export it.")
    sys.exit(1)

# ── Test runner ───────────────────────────────────────────────────────────────

_results = []

def _run(name, fn):
    print(f"  ▶ {name} ...", end=' ', flush=True)
    try:
        fn()
        print("PASS ✓")
        _results.append((name, True, ''))
    except AssertionError as e:
        print(f"FAIL ✗  {e}")
        _results.append((name, False, str(e)))
    except Exception as e:
        print(f"ERROR ✗  {e}")
        _results.append((name, False, str(e)))

def _nova():
    return NovaAct(starting_page=APP_URL, nova_act_api_key=API_KEY)

def _check(page, js, msg=''):
    """Assert that a JS expression returns truthy via Playwright evaluate."""
    ok = page.evaluate(f'() => !!({js})')
    if not ok:
        raise AssertionError(msg or f'Failed: {js}')

def _eval(page, js):
    return page.evaluate(f'() => ({js})')

def _wait(page, selector, timeout=5000):
    page.wait_for_selector(selector, timeout=timeout)

# ── Tests ─────────────────────────────────────────────────────────────────────

def test_app_loads():
    """Sidebar and type-nav buttons are present."""
    with _nova() as nova:
        p = nova.page
        _check(p, 'document.getElementById("sidebar")',    'sidebar missing')
        _check(p, 'document.getElementById("type-nav")',   'type-nav missing')
        _check(p, 'document.querySelectorAll(".type-btn").length > 0', 'no type-btn buttons')


def test_characters_view():
    """Clicking Characters shows list panel with + New button."""
    with _nova() as nova:
        p = nova.page
        nova.act("Click the 'Characters' button in the sidebar.")
        _wait(p, '#list-header')
        _check(p, 'document.getElementById("list-header").innerText.includes("CHARACTERS")',
               'list header does not say CHARACTERS')
        _check(p, 'document.getElementById("btn-new")', '+ New button missing')


def test_create_edit_delete_entity():
    """Full create → edit → delete lifecycle for a character."""
    with _nova() as nova:
        p = nova.page
        nova.act("Click the 'Characters' button in the sidebar.")
        nova.act("Click the '+ New' button.")
        nova.act("In the Name field type 'NOVATEST_CHAR'. In the Role field type 'Test Role'. Click Save.")

        _wait(p, '.entity-item')
        names = _eval(p, '[...document.querySelectorAll(".entity-name")].map(e=>e.innerText)')
        assert any('NOVATEST_CHAR' in n for n in names), \
            f'NOVATEST_CHAR not in list: {names}'

        # Edit — add a description
        nova.act("Click on NOVATEST_CHAR in the list, then click Edit.")
        nova.act("Type 'Automated test.' in the Description textarea. Click Save.")

        desc = _eval(p, 'document.querySelector(".description")?.innerText || ""')
        assert 'Automated test' in desc, f'Description not saved: {desc!r}'

        # Delete
        nova.act("Click the Delete button in the detail panel and confirm.")
        time.sleep(1)
        names_after = _eval(p, '[...document.querySelectorAll(".entity-name")].map(e=>e.innerText)')
        assert not any('NOVATEST_CHAR' in n for n in names_after), \
            'NOVATEST_CHAR still in list after delete'


def test_search():
    """Typing in the search box switches to the search view."""
    with _nova() as nova:
        p = nova.page
        nova.act("Click in the search box at the top of the sidebar and type 'zzz_no_match'.")
        time.sleep(0.5)
        header = _eval(p, 'document.getElementById("list-header")?.innerText || ""')
        assert 'SEARCH' in header.upper() or 'result' in header.lower(), \
            f'Search view not shown: {header!r}'


def test_timeline_view():
    """Timeline view renders."""
    with _nova() as nova:
        p = nova.page
        nova.act("Click on 'Timeline' in the sidebar.")
        _wait(p, '#list-header')
        header = _eval(p, 'document.getElementById("list-header")?.innerText || ""')
        assert 'TIMELINE' in header.upper(), f'Timeline header not shown: {header!r}'


def test_board_view():
    """Board view hides list/detail panels and shows board canvas."""
    with _nova() as nova:
        p = nova.page
        nova.act("Click on 'Board' in the sidebar.")
        time.sleep(0.5)
        _check(p, 'document.body.classList.contains("board-mode")', 'board-mode class not set')
        _check(p, 'document.getElementById("board-canvas")', 'board-canvas missing')


def test_project_view():
    """Project view shows project list with + New."""
    with _nova() as nova:
        p = nova.page
        nova.act("Click the Project button at the top of the sidebar.")
        _wait(p, '#list-header')
        header = _eval(p, 'document.getElementById("list-header")?.innerText || ""')
        assert 'PROJECT' in header.upper(), f'Project header not shown: {header!r}'
        _check(p, 'document.getElementById("btn-new-project")', '+ New project button missing')


def test_create_switch_delete_project():
    """Create a project via inline form, switch, delete."""
    with _nova() as nova:
        p = nova.page
        nova.act("Click the Project button at the top of the sidebar.")
        nova.act("Click the '+ New' button in the Projects panel.")

        _wait(p, '#proj-name-input', timeout=3000)
        p.fill('#proj-name-input', 'NOVATEST_PROJECT')
        p.click('#proj-name-save')
        time.sleep(0.5)

        active_id = _eval(p, 'window._novaProjectId || ""')  # not exposed; check sidebar label
        sidebar_label = _eval(p, 'document.getElementById("btn-project")?.innerText || ""')
        assert 'NOVATEST_PROJECT' in sidebar_label, \
            f'Sidebar not updated to new project: {sidebar_label!r}'

        # Switch back to any other project
        proj_items = p.query_selector_all('.proj-item')
        for item in proj_items:
            if 'NOVATEST_PROJECT' not in (item.inner_text() or ''):
                item.click()
                break
        time.sleep(0.3)

        # Select and delete NOVATEST_PROJECT
        for item in p.query_selector_all('.proj-item'):
            if 'NOVATEST_PROJECT' in (item.inner_text() or ''):
                item.click()
                break
        time.sleep(0.3)
        btn = p.query_selector('#btn-delete-project')
        assert btn, 'Delete Project button not found'
        p.on('dialog', lambda d: d.accept())
        btn.click()
        time.sleep(0.5)

        proj_names = _eval(p, '[...document.querySelectorAll(".proj-item .entity-name")].map(e=>e.innerText)')
        assert not any('NOVATEST_PROJECT' in n for n in proj_names), \
            'NOVATEST_PROJECT still listed after delete'


def test_settings_type_toggle():
    """Toggling a type off removes it from the sidebar; toggling back restores it."""
    with _nova() as nova:
        p = nova.page
        nova.act("Click on 'Settings' at the bottom of the sidebar.")
        _wait(p, '.settings-check')

        # Uncheck Locations
        loc_cb = p.query_selector('input[data-type="location"]')
        assert loc_cb, 'Locations checkbox not found'
        if loc_cb.is_checked():
            loc_cb.click()
            time.sleep(0.3)

        btns = _eval(p, '[...document.querySelectorAll("[data-type]")].map(b=>b.dataset.type)')
        assert 'location' not in btns, f'Locations still in sidebar after uncheck: {btns}'

        # Re-enable
        loc_cb = p.query_selector('input[data-type="location"]')
        if not loc_cb.is_checked():
            loc_cb.click()
            time.sleep(0.3)

        btns_after = _eval(p, '[...document.querySelectorAll("[data-type]")].map(b=>b.dataset.type)')
        assert 'location' in btns_after, f'Locations not restored: {btns_after}'


def test_ai_panel_visible():
    """AI Extract panel renders (locked or open depending on auth state)."""
    with _nova() as nova:
        p = nova.page
        nova.act("Click on 'AI Extract' in the sidebar if it is visible.")
        time.sleep(0.5)
        # Accept either the locked state or the extract input area
        locked = _eval(p, '!!document.querySelector(".ai-locked")')
        extract = _eval(p, '!!document.querySelector(".ai-input-area")')
        assert locked or extract, 'AI panel shows neither locked nor extract UI'


# ── Entry point ───────────────────────────────────────────────────────────────

TESTS = [
    ("App loads",                      test_app_loads),
    ("Characters view",                test_characters_view),
    ("Create / edit / delete entity",  test_create_edit_delete_entity),
    ("Search",                         test_search),
    ("Timeline view",                  test_timeline_view),
    ("Board view",                     test_board_view),
    ("Project view",                   test_project_view),
    ("Create, switch & delete project",test_create_switch_delete_project),
    ("Settings type toggle",           test_settings_type_toggle),
    ("AI panel visible",               test_ai_panel_visible),
]

if __name__ == '__main__':
    print(f"\nWriting World Smoke Tests  —  {APP_URL}\n")

    for name, fn in TESTS:
        _run(name, fn)

    passed = sum(1 for _, ok, _ in _results if ok)
    total  = len(_results)
    failed = total - passed

    print(f"\n{'─' * 50}")
    print(f"  {passed}/{total} passed", end='')
    if failed:
        print(f"  ({failed} failed)\n")
        for name, ok, err in _results:
            if not ok:
                print(f"  ✗ {name}: {err}")
    else:
        print("  ✓ all green\n")

    sys.exit(0 if not failed else 1)
