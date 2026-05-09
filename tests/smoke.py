#!/usr/bin/env python3
"""
Writing World smoke tests using Nova Act.

Usage:
  python3 tests/smoke.py [--url https://lore.malha.land]

Requires:
  pip install nova-act
  NOVA_ACT_API_KEY set in infra/deploy.env or the environment
"""

import sys, os, argparse, traceback

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
        print(f"FAIL ✗")
        print(f"      {e}")
        _results.append((name, False, str(e)))
    except Exception as e:
        print(f"ERROR ✗")
        print(f"      {e}")
        _results.append((name, False, str(e)))

def _nova():
    return NovaAct(starting_page=APP_URL, nova_act_api_key=API_KEY)

def _assert(result, expectation):
    if not result.matches_expectation(expectation):
        raise AssertionError(f"Expected: {expectation!r}\n      Got: {result.response!r}")

# ── Test cases ────────────────────────────────────────────────────────────────

def test_app_loads():
    """Sidebar with entity-type navigation is visible."""
    with _nova() as nova:
        r = nova.act(
            "Look at the page. Is there a dark sidebar on the left that contains "
            "navigation buttons (at least one of: Characters, Locations, Events, Project, Settings)?"
        )
        _assert(r, "yes")

def test_characters_view():
    """Characters list panel and + New button load."""
    with _nova() as nova:
        nova.act("Click on 'Characters' in the sidebar. "
                 "If Characters is not visible, click the first entity-type button.")
        r = nova.act("Is there a centre panel titled 'CHARACTERS' with a '+ New' button?")
        _assert(r, "yes")

def test_create_edit_delete_entity():
    """Full create → edit → delete lifecycle for a character."""
    with _nova() as nova:
        nova.act("Click on 'Characters' in the sidebar (or the first entity-type button).")
        nova.act("Click the '+ New' button.")
        nova.act("In the Name field type 'NOVATEST_CHAR'. "
                 "In the Role field type 'Test Role'. Click Save.")

        r = nova.act("Is 'NOVATEST_CHAR' now listed in the character list?")
        _assert(r, "yes")

        # Edit
        nova.act("Click the Edit button in the detail panel on the right.")
        nova.act("Clear the Description textarea and type 'Automated test character'. Click Save.")

        r = nova.act("Does the detail panel show 'Automated test character' in the description area?")
        _assert(r, "yes")

        # Delete
        nova.act("Click the Delete button in the detail panel.")
        nova.act("Click OK or Confirm in the browser confirmation dialog.")

        r = nova.act("Is 'NOVATEST_CHAR' gone from the character list?")
        _assert(r, "yes")

def test_search():
    """Search input filters results."""
    with _nova() as nova:
        nova.act("Click in the search box at the top of the sidebar and type 'xyz_unlikely_term'.")
        r = nova.act(
            "Does the centre panel show a search view — either 'No results' or a "
            "count of results for the search term?"
        )
        _assert(r, "yes")

def test_timeline_view():
    """Timeline view renders."""
    with _nova() as nova:
        nova.act("Click on 'Timeline' in the sidebar.")
        r = nova.act(
            "Does the centre panel now show the Timeline view? "
            "It should say TIMELINE at the top or show a message about adding events."
        )
        _assert(r, "yes")

def test_board_view():
    """Board view takes over the full content area."""
    with _nova() as nova:
        nova.act("Click on 'Board' in the sidebar.")
        r = nova.act(
            "Has the layout switched to a full-width board canvas? "
            "The list and detail panels should have disappeared."
        )
        _assert(r, "yes")

def test_project_view():
    """Project view shows a list of projects."""
    with _nova() as nova:
        nova.act("Click the first button at the very top of the sidebar (the Project button with ◈ icon).")
        r = nova.act(
            "Does the centre panel show 'PROJECTS' as the title with a '+ New' button?"
        )
        _assert(r, "yes")

def test_create_switch_project():
    """Create a second project and switch to it."""
    with _nova() as nova:
        nova.act("Click the Project button at the top of the sidebar.")
        nova.act("Click the '+ New' button to create a new project.")
        nova.act("In the browser prompt that appears, clear the text, type 'NOVATEST_PROJECT', and click OK.")

        r = nova.act(
            "Is 'NOVATEST_PROJECT' now listed in the projects panel, "
            "and does the sidebar show it as the active project?"
        )
        _assert(r, "yes")

        # Switch back to the first project
        nova.act(
            "Click on the first project in the list that is NOT 'NOVATEST_PROJECT' to switch to it."
        )

        # Delete the test project
        nova.act("Click on 'NOVATEST_PROJECT' to select it.")
        nova.act("Click the 'Delete Project' button in the detail panel on the right.")
        nova.act("Click OK in the confirmation dialog.")

def test_settings_toggle():
    """Toggling a type in Settings removes it from the sidebar."""
    with _nova() as nova:
        nova.act("Click on 'Settings' at the bottom of the sidebar.")
        r = nova.act(
            "Does the centre panel show settings with checkboxes for entity types "
            "(e.g. Characters, Locations, Events)?"
        )
        _assert(r, "yes")

        # Toggle Locations off then back on
        nova.act("Uncheck the 'Locations' checkbox.")
        r = nova.act("Is 'Locations' no longer visible in the sidebar entity-type navigation?")
        _assert(r, "yes")

        nova.act("Check the 'Locations' checkbox again to restore it.")

def test_ai_panel_visible():
    """AI Extract panel renders (locked state is acceptable if not signed in)."""
    with _nova() as nova:
        nova.act("Click on 'AI Extract' in the sidebar if it is visible.")
        r = nova.act(
            "Is there a panel visible that either shows AI extract controls (text area, extract button) "
            "or a 'Sign In' prompt indicating AI features require login?"
        )
        _assert(r, "yes")


# ── Entry point ───────────────────────────────────────────────────────────────

TESTS = [
    ("App loads",                     test_app_loads),
    ("Characters view",               test_characters_view),
    ("Create / edit / delete entity", test_create_edit_delete_entity),
    ("Search",                        test_search),
    ("Timeline view",                 test_timeline_view),
    ("Board view",                    test_board_view),
    ("Project view",                  test_project_view),
    ("Create & switch project",       test_create_switch_project),
    ("Settings type toggle",          test_settings_toggle),
    ("AI panel visible",              test_ai_panel_visible),
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
                print(f"  ✗ {name}")
                if err:
                    print(f"    {err}")
    else:
        print("  ✓ all green\n")

    sys.exit(0 if not failed else 1)
