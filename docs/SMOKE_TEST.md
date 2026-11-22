# Manual smoke test (≈5 minutes, do this before recording the video)

1. `npm ci && npm run build`; start TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@latest`.
2. `npm run provision`, then open the repo in VS Code and press F5.
3. In the Extension Development Host open a Flask checkout (`git checkout 22d92470`), set `forgeAgent.models`.
4. **Task A:** open `src/flask/helpers.py`, select `get_debug_flag`, `Cmd/Ctrl+Alt+K`, enter the instruction, accept hunks, run
   `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False`.
5. **Task B:** `git checkout .`; in the panel: "Add a built-in `flask config` command printing the app config as JSON, masking keys containing SECRET/PASSWORD/TOKEN/KEY as `***`. Add a test and document it." Accept hunks in ≥3 files; `pytest tests/test_cli.py -q`; `flask --app <app> config`; `flask --help`.
6. **Task C:** put the unreachable/invalid model first in `forgeAgent.models`, repeat Task A, confirm the notice, editor responsiveness and `git status` (clean until you accept hunks).
7. Cancel test: start a run, press `Esc`; confirm the status returns to idle and `git status` is clean.

Review UI specifics to check: the hunk checklist (QuickPick) appears after the diff tabs open; unchecking a hunk and pressing Enter writes only the checked hunks (`git diff`); Esc on the list leaves the diffs open and the status bar item "Forge review" re-opens it; a second review of the same file shows the new diff (not the first).

Things to eyeball that automated tests cannot: CodeLens placement, diff tab titles, panel rendering in your theme, and the Esc keybinding.
