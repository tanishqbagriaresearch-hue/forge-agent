# Demo video script — target 3:55 (hard limit 4:00)

Record the screen at 1080p with VS Code (Extension Development Host on a Flask 3.1.3 checkout, `git checkout 22d92470`), a terminal and the TrueForge UI (http://localhost:8790) visible. Zoom the editor font to 16+. Pre-warm: start TrueForge, run `npm run provision`, open the Flask folder, verify `git status` is clean. Update the timestamps in `docs/WRITEUP.md` §6 to what you actually record.

| Time | Show | Say / do |
|---|---|---|
| 0:00–0:20 | Title card or terminal: TrueForge running; VS Code with the Forge panel | "Forge Agent is a VS Code extension whose agent loop runs entirely on TrueForge; editor tools are MCP tools; the model is configured in TrueForge." Show `forgeAgent.models`. |
| **A** 0:20–1:10 | `src/flask/helpers.py` → select `get_debug_flag` → `Cmd/Ctrl+Alt+K` | Instruction: "Treat 'off' and 'n' as false too, case-insensitively, and update the docstring." Show streaming, then the diff: one hunk (code) + docstring hunk. Reject nothing, accept both. Terminal: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → **False**. Optionally `FLASK_DEBUG=N` → False, `1` → True. Show **Undo** once to prove it is reversible, then re-run Task A (or skip undo if time is short). |
| **B** 1:10–2:50 | `git checkout .`; open the Forge panel | Paste the Task B prompt **without naming a file**. Point at the "retrieve_context" tool line and the "files chosen and why" list (B1). Show the TrueForge UI session (tools, approval) briefly (B4). When `apply_changes` pauses: show the multi-file diff, **reject one hunk** to show per-hunk control, accept the rest. Terminal: `git diff --stat` (≥3 files) → `pytest tests/test_cli.py -q` (pass) → `flask --app <any app> config` (masked `***`) → `flask --help` (config listed). |
| **A3** 2:50–3:15 | New long request (e.g. "explain and refactor the CLI module") | While tokens stream, press **Esc**. Show: status "cancelled", `git status` clean. |
| **C** 3:15–3:55 | Settings: put an unreachable endpoint (or an invalid key) first in `forgeAgent.models` | `git checkout .`; repeat Task A. Show the notice "…failed (Cannot connect / 401)… falling back to <model 2>", that the editor stays responsive (type in another file while it runs), the fallback completes the edit, then `git status`. Second take if time: both models bad → one clear error, no hang, `git status` clean. |
| 3:55–4:00 | Panel | "All five capabilities, one agent loop on TrueForge. Repo and write-up are linked." |

Tips: cut waiting time (the video may be edited, but keep verification output on screen uncut); do not show API keys (use env vars, close `settings.json` with secrets). Upload as unlisted/public and test the link while logged out.

## Task prompts (verbatim from the brief)

* A: select `get_debug_flag`; "Treat 'off' and 'n' as false, case-insensitively, and update the docstring."
* B: "Add a built-in `flask config` command that prints the app config as JSON, masking any key whose name contains SECRET, PASSWORD, TOKEN or KEY as \"***\". It must appear in `flask --help`, have a test, and be documented."
