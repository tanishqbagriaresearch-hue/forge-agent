// End-to-end: real local TrueForge + real editor MCP server + pinned pallets/flask 3.1.3 + a SCRIPTED OpenAI-compatible model.
// The scripted model proves the plumbing (tools, approvals, review, cancel, fallback). It says nothing about model quality.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startMockOpenAI, type MockReply, type ChatMessage } from "./mock-openai";
import { upsertModelProvider } from "../src/forge/provision";
import { createCore, type Core } from "../src/core";
import { HeadlessHost } from "../src/headlessHost";
import type { RunEvents } from "../src/agent/runner";
import type { Activity } from "../src/mcp/tools";
import type { ReviewItem } from "../src/host";
import { makeClient, type ForgeEvent, type TrueForgeLike } from "../src/forge/client";

const WORK = process.env.E2E_DIR ?? "/tmp/forge-e2e";
const FLASK = path.join(WORK, "flask");
const VENV = path.join(WORK, "venv", "bin");
const TF_PORT = Number(process.env.TF_PORT ?? 8795);
const TF = `http://localhost:${TF_PORT}`;
const PIN = "22d92470";
process.env.PATH = `${VENV}:${process.env.PATH}`;

const sh = (cmd: string, args: string[], cwd = FLASK, env: NodeJS.ProcessEnv = {}) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
const git = (...a: string[]) => sh("git", a);
const reset = () => { git("checkout", "-q", "--", "."); git("clean", "-fdq"); };
const doReset = () => { if (!process.env.E2E_KEEP) reset(); };
const dirty = () => git("status", "--porcelain").trim();

// ---------- the fixed task wording (exact, from the brief) ----------
const TASK_A = `Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.`;
const TASK_B = `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`;

// ---------- scripted model ----------
let mode: "A" | "B" | "stall" = "A";
let toolNames: string[] = [];
const T = (n: string) => toolNames.find((t) => t === n || /[_.:/-]/.test(t.slice(-n.length - 1, -n.length)) && t.endsWith(n)) ?? n;
const call = (name: string, args: object): MockReply => ({ toolCalls: [{ name: T(name), args }] });

const A_OLD = `    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no"})`;
const A_NEW = `    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.

    The values \`\`0\`\`, \`\`false\`\`, \`\`no\`\`, \`\`off\`\` and \`\`n\`\` (case-insensitive)
    are treated as false, as is an unset or empty variable. Any other value
    enables debug mode.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})`;

const B_CMD = `@click.command("config", short_help="Show the loaded config as JSON.")
@with_appcontext
def config_command() -> None:
    """Print the loaded application's configuration as JSON. The values of any
    key containing SECRET, PASSWORD, TOKEN or KEY are masked as \`\`***\`\`.
    """
    import json

    sensitive = ("SECRET", "PASSWORD", "TOKEN", "KEY")
    data = {
        k: "***" if any(s in str(k).upper() for s in sensitive) else v
        for k, v in current_app.config.items()
    }
    click.echo(json.dumps(data, indent=2, sort_keys=True, default=str))


cli = FlaskGroup(`;
const B_TEST = `def test_config_command_masks_secrets():
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY="s3cret", DB_PASSWORD="pw", API_TOKEN="tok", PUBLIC_KEY_ID="k", SITE_NAME="demo"
    )
    cli = FlaskGroup(create_app=lambda: app)
    runner = CliRunner()
    result = runner.invoke(cli, ["config"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    for key in ("SECRET_KEY", "DB_PASSWORD", "API_TOKEN", "PUBLIC_KEY_ID"):
        assert data[key] == "***"
    assert data["SITE_NAME"] == "demo"
    assert "s3cret" not in result.output
    assert "config" in runner.invoke(cli, ["--help"]).output


def test_run_cert_path():`;
const B_DOC = `Use :meth:\`~Flask.shell_context_processor\` to add other automatic imports.


Show the Config
---------------

To see the configuration an application has loaded, use the \`\`config\`\` command.
It prints the config as JSON and masks the values of any key containing
\`\`SECRET\`\`, \`\`PASSWORD\`\`, \`\`TOKEN\`\` or \`\`KEY\`\` as \`\`"***"\`\`. ::

    $ flask config
`;

const aSteps = (): MockReply[] => [
  call("read_file", { path: "src/flask/helpers.py", start_line: 20, end_line: 40 }),
  call("propose_edit", { path: "src/flask/helpers.py", old_text: A_OLD, new_text: A_NEW }),
  call("apply_changes", { summary: "Treat off and n as false in get_debug_flag" }),
  { text: "Done: get_debug_flag now treats off and n as false and the docstring lists them." },
];
const bSteps = (): MockReply[] => [
  call("retrieve_context", { query: "flask CLI built-in commands routes shell command click" }),
  call("read_file", { path: "src/flask/cli.py", start_line: 1050, end_line: 1135 }),
  call("read_file", { path: "tests/test_cli.py", start_line: 1, end_line: 40 }),
  call("read_file", { path: "docs/cli.rst", start_line: 128, end_line: 150 }),
  call("propose_edit", { path: "src/flask/cli.py", old_text: "cli = FlaskGroup(", new_text: B_CMD }),
  call("propose_edit", { path: "src/flask/cli.py", old_text: "            self.add_command(routes_command)\n", new_text: "            self.add_command(routes_command)\n            self.add_command(config_command)\n" }),
  call("propose_edit", { path: "tests/test_cli.py", old_text: "import importlib.metadata\n", new_text: "import importlib.metadata\nimport json\n" }),
  call("propose_edit", { path: "tests/test_cli.py", old_text: "def test_run_cert_path():", new_text: B_TEST }),
  call("propose_edit", { path: "docs/cli.rst", old_text: "Use :meth:`~Flask.shell_context_processor` to add other automatic imports.\n", new_text: B_DOC }),
  call("apply_changes", { summary: "Add flask config command, test and docs" }),
  call("call_tool", { mcp_server: "forge-editor", tool_name: "run_command", input: { command: "pytest tests/test_cli.py -q" } }),
  { text: "Added the config command in cli.py, a test in tests/test_cli.py and docs in docs/cli.rst." },
];
const goodScript = (messages: ChatMessage[], tools: string[]): MockReply => {
  if (tools.length && !toolNames.length) toolNames = tools;
  if (mode === "stall") return { text: "Let me think about this carefully before changing anything. ", stall: true };
  const n = messages.filter((m) => m.role === "assistant").length;
  return (mode === "A" ? aSteps() : bSteps())[n] ?? { text: "Done." };
};

// ---------- harness ----------
const only = process.env.E2E_ONLY?.split(",");
const run = (id: string) => !only || only.includes(id);
function dbgClient(): TrueForgeLike | undefined {
  if (!process.env.E2E_DEBUG) return undefined;
  const c = makeClient(TF);
  const wrap = (it: AsyncIterable<ForgeEvent>) => (async function* () { for await (const e of it) { console.log("  EV", e.type, JSON.stringify(e).slice(0, 360)); yield e; } })();
  return { ...c, startTurn: async (...a) => wrap(await c.startTurn(...a)), subscribe: async (...a) => wrap(await c.subscribe(...a)),
    sendEvents: async (id, t, ev) => { console.log("  SEND", JSON.stringify(ev).slice(0, 300)); return c.sendEvents(id, t, ev); } };
}
type Row = { scenario: string; check: string; pass: boolean; detail?: string };
const rows: Row[] = [];
const check = (scenario: string, name: string, pass: boolean, detail = "") => {
  rows.push({ scenario, check: name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  [${scenario}] ${name}${detail ? " — " + detail : ""}`);
};

function mkLog() {
  const log = { delta: "", toolCalls: [] as string[], notices: [] as string[], statuses: [] as string[], activity: [] as Activity[] };
  const events: RunEvents = {
    delta: (t) => (log.delta += t), toolCall: (n) => log.toolCalls.push(n), toolResult: () => {},
    status: (s) => log.statuses.push(s), notice: (m) => log.notices.push(m),
  };
  return { log, events };
}

async function world(models: string[], hostOpts: { decide?: (i: ReviewItem[], s: AbortSignal) => Promise<Map<string, Set<number>>> } = {}) {
  const host = new HeadlessHost(FLASK);
  if (hostOpts.decide) host.reviewChanges = async (items, signal) => { host.reviews.push(items); return hostOpts.decide!(items, signal); };
  const { log, events } = mkLog();
  const core: Core = await createCore({
    host, baseUrl: TF, models, events, client: dbgClient(), onActivity: (a) => log.activity.push(a),
    autoApproveCommands: [/^pytest/], retries: 1, baseMs: 300,
  });
  return { host, core, log };
}

async function waitFor(cond: () => boolean, ms = 20000, step = 25) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, step));
  return cond();
}

async function startTrueForge(): Promise<ChildProcess> {
  const dbDir = fs.mkdtempSync(path.join(WORK, "tf-"));
  const p = spawn("npx", ["-y", "@truefoundry/trueforge@latest"], {
    env: { ...process.env, PORT: String(TF_PORT), SQLITE_PATH: path.join(dbDir, "tf.db"), OUTBOUND_URL_ALLOWED_HOSTS: '["127.0.0.1"]' },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout!.on("data", () => {}); p.stderr!.on("data", () => {});
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${TF}/api/v1/capabilities`)).ok) return p; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  p.kill();
  throw new Error("TrueForge did not start");
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  if (!fs.existsSync(FLASK)) {
    sh("git", ["clone", "-q", "--depth", "1", "--branch", "3.1.3", "https://github.com/pallets/flask.git", FLASK], WORK);
    sh("python3", ["-m", "venv", path.join(WORK, "venv")], WORK);
    sh(path.join(VENV, "pip"), ["install", "-q", "-e", ".", "pytest==9.0.2"], FLASK); // version from Flask 3.1.3 uv.lock; newer pytest breaks its tests
  }
  reset();
  const head = git("rev-parse", "--short=8", "HEAD").trim();
  check("setup", `Flask is at pinned commit ${PIN}`, head === PIN, head);
  fs.writeFileSync(path.join(WORK, "demo_app.py"), `from flask import Flask\napp = Flask(__name__)\napp.config.update(SECRET_KEY="hunter2", DB_PASSWORD="pw", API_TOKEN="tok", SITE_NAME="demo")\n`);

  const tf = await startTrueForge();
  const good = await startMockOpenAI(goodScript);
  const auth = await startMockOpenAI(() => ({ status: 401 }));
  try {
    await upsertModelProvider(TF, { provider: "mockgood", name: "mockgood", modelId: "mock-1", baseUrl: good.url, apiKey: "k" });
    await upsertModelProvider(TF, { provider: "mockauth", name: "mockauth", modelId: "mock-1", baseUrl: auth.url, apiKey: "bad-key" });
    await upsertModelProvider(TF, { provider: "mockbad", name: "mockbad", modelId: "mock-1", baseUrl: "http://127.0.0.1:59999/v1", apiKey: "k" });
    const GOOD = "mockgood/mockgood", AUTH = "mockauth/mockauth", BAD = "mockbad/mockbad";

    // ===== Task A: inline edit =====
    if (run("A")) {
      mode = "A"; toolNames = [];
      const w = await world([GOOD]);
      const sel = `Lines 28-33 of src/flask/helpers.py`;
      const t0 = Date.now();
      const r = await w.core.runner.run(`File: src/flask/helpers.py\n${sel}.\nInstruction: ${TASK_A}\nOnly edit inside this region unless the instruction requires otherwise.`);
      check("A", "run finished with status done", r.status === "done", `${r.status} in ${Date.now() - t0}ms; tools seen: ${toolNames.join(",") || "(none)"}`);
      check("A", "a per-hunk review was shown before any write", w.host.reviews.length === 1 && w.host.reviews[0][0].hunks.length >= 1);
      const out = (env: string) => sh(path.join(VENV, "python"), ["-c", "from flask.helpers import get_debug_flag; print(get_debug_flag())"], FLASK, { FLASK_DEBUG: env }).trim();
      check("A", "FLASK_DEBUG=off prints False", out("off") === "False");
      check("A", "FLASK_DEBUG=N prints False (case-insensitive)", out("N") === "False");
      check("A", "FLASK_DEBUG=1 still prints True", out("1") === "True");
      const src = fs.readFileSync(path.join(FLASK, "src/flask/helpers.py"), "utf8");
      check("A", "docstring lists off and n", /``off``/.test(src) && /``n``/.test(src));
      check("A", "only helpers.py changed", dirty().split("\n").length === 1 && dirty().includes("helpers.py"), dirty());
      // undo
      const u = await w.core.undoLast();
      check("A", "undo restores the file exactly", u.ok && dirty() === "", u.message);
      await w.core.close(); doReset();
    }

    // ===== Task B: agent mode, 3+ files, none named =====
    if (run("B")) {
      mode = "B"; toolNames = [];
      const w = await world([GOOD]);
      const t0 = Date.now();
      const r = await w.core.runner.run(TASK_B);
      check("B", "run finished with status done", r.status === "done", `${r.status} in ${Date.now() - t0}ms`);
      const files = dirty().split("\n").filter(Boolean).map((l) => l.slice(3));
      check("B", "diff touches at least three files, none named in the prompt", files.length >= 3, files.join(", "));
      const rc = w.log.activity.find((a) => a.tool === "retrieve_context");
      check("B", "retrieve_context ran and reported chosen files with reasons + budget", !!rc && (rc.files?.length ?? 0) > 0 && !!rc.files![0].why && /tokens/.test(rc.summary), rc?.summary);
      const ran = w.host.reviews[0]?.length ?? 0;
      check("B", "review covered each changed file with hunks", ran >= 3, `${ran} files`);
      let pyOut = ""; let pyOk = true;
      try { pyOut = sh(path.join(VENV, "pytest"), ["tests/test_cli.py", "-q"]); } catch (e: any) { pyOk = false; pyOut = String(e.stdout ?? e); }
      check("B", "pytest tests/test_cli.py -q passes", pyOk && /passed/.test(pyOut), pyOut.trim().split("\n").pop());
      const help = sh(path.join(VENV, "flask"), ["--app", "demo_app", "--help"], WORK);
      check("B", "flask --help lists config", /^\s+config\b/m.test(help));
      const json = sh(path.join(VENV, "flask"), ["--app", "demo_app", "config"], WORK);
      const parsed = JSON.parse(json);
      check("B", "flask config masks SECRET/PASSWORD/TOKEN as ***", parsed.SECRET_KEY === "***" && parsed.DB_PASSWORD === "***" && parsed.API_TOKEN === "***" && parsed.SITE_NAME === "demo");
      check("B", "docs mention the new command", fs.readFileSync(path.join(FLASK, "docs/cli.rst"), "utf8").includes("Show the Config"));
      const ranCmd = w.host.commands.length;
      check("B", "run_command executed under auto-approve policy (no prompt)", ranCmd === 0 && w.log.toolCalls.some((t) => t.endsWith("run_command")));
      await w.core.close(); doReset();
    }

    // ===== Task C: resilience =====
    if (run("C")) {
      mode = "A"; toolNames = [];
      const w = await world([BAD, GOOD]);
      const t0 = Date.now();
      const r = await w.core.runner.run(`File: src/flask/helpers.py\nLines 28-33.\nInstruction: ${TASK_A}`);
      const ms = Date.now() - t0;
      check("C", "unreachable primary -> automatic fallback to second model completes Task A", r.status === "done" && r.model === GOOD, `${r.status}/${r.model} in ${ms}ms`);
      check("C", "user sees a clear fallback notice", w.log.notices.some((n) => /falling back/i.test(n)), w.log.notices.join(" | "));
      check("C", "Task A result is correct after fallback", sh(path.join(VENV, "python"), ["-c", "from flask.helpers import get_debug_flag; print(get_debug_flag())"], FLASK, { FLASK_DEBUG: "off" }).trim() === "False");
      await w.core.close(); doReset();
    }
    {
      mode = "A"; toolNames = [];
      const w = await world([AUTH, GOOD]);
      const r = await w.core.runner.run(`File: src/flask/helpers.py\nLines 28-33.\nInstruction: ${TASK_A}`);
      check("C", "invalid API key (401) on primary -> fallback completes", r.status === "done" && r.model === GOOD, `${r.status}/${r.model}; ${w.log.notices.join(" | ").slice(0, 200)}`);
      await w.core.close(); doReset();
    }
    {
      const w = await world([BAD]);
      const t0 = Date.now();
      const r = await w.core.runner.run(`File: src/flask/helpers.py\nLines 28-33.\nInstruction: ${TASK_A}`);
      check("C", "only an unreachable model -> clear error, no hang", r.status === "error" && Date.now() - t0 < 60000, `${r.status} in ${Date.now() - t0}ms; ${w.log.notices.at(-1)?.slice(0, 160)}`);
      check("C", "git status shows no files changed", dirty() === "", dirty());
      await w.core.close(); doReset();
    }

    // ===== Cancellation =====
    {
      mode = "stall"; toolNames = [];
      const w = await world([GOOD]);
      const p = w.core.runner.run("do something slow");
      const got = await waitFor(() => w.log.delta.length > 0, 30000);
      const c0 = Date.now();
      await w.core.runner.cancel();
      const r = await p;
      const ms = Date.now() - c0;
      check("cancel", "tokens streamed before cancel", got, w.log.delta.slice(0, 40));
      check("cancel", "cancel is immediate and run ends cancelled", r.status === "cancelled" && ms < 3000, `${r.status} in ${ms}ms`);
      check("cancel", "workspace untouched", dirty() === "");
      await w.core.close(); doReset();
    }
    {
      mode = "A"; toolNames = [];
      const w = await world([GOOD], { decide: (_i, signal) => new Promise((res) => signal.addEventListener("abort", () => res(new Map()))) });
      const p = w.core.runner.run(`File: src/flask/helpers.py\nLines 28-33.\nInstruction: ${TASK_A}`);
      const inReview = await waitFor(() => w.host.reviews.length === 1, 30000);
      const c0 = Date.now();
      await w.core.runner.cancel();
      const r = await p;
      check("cancel", "run reached the pending diff review", inReview);
      check("cancel", "cancel during review ends cancelled quickly with nothing written", r.status === "cancelled" && Date.now() - c0 < 3000 && dirty() === "", `${r.status} in ${Date.now() - c0}ms`);
      await w.core.close(); doReset();
    }

    // ===== Per-hunk rejection end-to-end =====
    {
      mode = "A"; toolNames = [];
      const w = await world([GOOD], { decide: async (items) => new Map(items.map((i) => [i.abs, new Set<number>()])) });
      const r = await w.core.runner.run(`File: src/flask/helpers.py\nLines 28-33.\nInstruction: ${TASK_A}`);
      check("review", "rejecting every hunk writes nothing and the run still ends cleanly", dirty() === "" && (r.status === "done" || r.status === "error"), `${r.status}; ${dirty()}`);
      await w.core.close(); doReset();
    }
  } finally {
    if (process.env.E2E_DEBUG) for (const t of (good.requests[0]?.tools ?? []).filter((x: any) => ["call_tool","list_tools","get_tool_info"].includes(x.function?.name))) console.log("TOOLDEF", JSON.stringify(t).slice(0, 900));
    await good.close(); await auth.close(); tf.kill("SIGTERM");
  }

  const failed = rows.filter((r) => !r.pass);
  console.log(`\n${rows.length - failed.length}/${rows.length} checks passed`);
  fs.writeFileSync(path.join(WORK, "e2e-results.json"), JSON.stringify(rows, null, 2));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
