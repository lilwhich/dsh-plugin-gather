// my_better-dsh host half.
//
// 1) DeepSeek account status proxy (real balance API, 60s refresh).
// 2) Checkpoint / rollback system: when an agent run starts, a checkpoint of
//    the project state is created BEFORE the agent edits files.
//    - Git project: the checkpoint is a git commit (`git add -A` + commit).
//      List = index of checkpoint commits; diff = `git show`; restore =
//      `git reset --hard <commit>`. We reuse git — never re-implement it, and
//      never `git init` a non-repo.
//    - Non-git project: a file-copy snapshot under `$DSH_HOME/checkpoints/`
//      (excludes node_modules/.git/... — a compatible fallback, no git init).
//      Diff between snapshots reuses `git diff --no-index`.
//    The user asked to be told how non-git projects are handled first: see the
//    client UI (mode banner) and the README.
// 3) Global settings (~/.dsh/AGENTS.md — the CLAUDE.md-style user-global
//    instruction file). DSH's agent-instructions plugin loads this file into
//    EVERY session as the broadest instruction baseline; project AGENTS.md /
//    CLAUDE.md files take precedence over it. This host half exposes
//    read / write / reset routes; the client tab is the editor UI.
// 4) Live diff review: when the agent reads/writes/edits files, snapshot the
//    file state BEFORE the tool runs (tools/pre-execute) and, after a
//    successful write/edit (tools/result), diff the new content against the
//    snapshot and publish hunks to a per-workspace ring buffer. The client
//    "Diff Review" tab polls a route and renders the changes in real time.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.cwd(), '.dsh');
const CHECKPOINT_ROOT = join(DSH_HOME, 'checkpoints');
const INDEX_FILENAME = 'index.json';
/** Directories never copied by the non-git snapshot fallback. */
const FS_EXCLUDES = new Set([
	'node_modules', '.git', 'dist', 'build', '.cache', '.turbo', '.next',
	'target', '__pycache__', '.venv', 'venv', '.dsh'
]);
const MAX_DIFF_CHARS = 200_000;
/** fs 快照文件数上限：超过则跳过（避免每轮全量复制超大目录）。 */
const FS_MAX_FILES = 8000;
/** 同一工作区自动快照的最小间隔（毫秒）：抑制子代理/连续运行的刷屏。 */
const AUTO_DEBOUNCE_MS = 30_000;

export const inject = ['webServer', 'credentials'];

// ── helpers ────────────────────────────────────────────────────────────────

function run(cmd, args, cwd) {
	return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}

function isGitRepo(cwd) {
	const r = run('git', ['rev-parse', '--is-inside-work-tree'], cwd);
	return r.status === 0 && r.stdout.trim() === 'true';
}

function git(cwd, args) {
	return run('git', args, cwd);
}

function workspaceDir(cwd) {
	const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
	return join(CHECKPOINT_ROOT, hash);
}

function readIndex(cwd) {
	const file = join(workspaceDir(cwd), INDEX_FILENAME);
	if (!existsSync(file)) return { cwd, mode: 'none', items: [] };
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return { cwd, mode: 'none', items: [] };
	}
}

function writeIndex(cwd, index) {
	const dir = workspaceDir(cwd);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, INDEX_FILENAME), JSON.stringify(index, null, 2));
}

function nowStamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function nowLabel() {
	return new Date().toLocaleString('zh-CN', { hour12: false });
}

// ── git-mode checkpoint ────────────────────────────────────────────────────

function gitCheckpoint(cwd, title) {
	const add = git(cwd, ['add', '-A']);
	if (add.status !== 0) throw new Error(`git add failed: ${add.stderr?.trim() || 'unknown'}`);
	const commit = git(cwd, ['commit', '-m', title]);
	if (commit.status !== 0) {
		// "nothing to commit" → nothing changed since the last checkpoint → skip.
		return null;
	}
	const rev = git(cwd, ['rev-parse', 'HEAD']);
	if (rev.status !== 0) throw new Error('git rev-parse HEAD failed');
	const id = rev.stdout.trim();
	const show = git(cwd, ['show', '--pretty=format:', '--name-only', 'HEAD']);
	const files = show.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
	return { id, title, time: nowLabel(), files, kind: 'git' };
}

function gitDiff(cwd, id) {
	const r = git(cwd, ['show', '--stat', '--patch', '--find-renames', id]);
	if (r.status !== 0) return { ok: false, error: r.stderr?.trim() || 'git show failed', text: '' };
	return { ok: true, text: r.stdout.slice(0, MAX_DIFF_CHARS) };
}

function gitRestore(cwd, id) {
	// Verify the id is one of OUR checkpoint commits AND still exists
	// (it may have been garbage-collected or the repo rewritten) before reset.
	const index = readIndex(cwd);
	if (!index.items.some((item) => item.id === id && item.kind === 'git')) {
		return { ok: false, error: 'unknown checkpoint id' };
	}
	const exists = git(cwd, ['cat-file', '-e', `${id}^{commit}`]);
	if (exists.status !== 0) {
		return { ok: false, error: 'checkpoint commit 已不存在（仓库可能被 gc 或改写）' };
	}
	const r = git(cwd, ['reset', '--hard', id]);
	if (r.status !== 0) return { ok: false, error: r.stderr?.trim() || 'git reset failed' };
	return { ok: true };
}

// ── fs-mode (non-git) checkpoint ───────────────────────────────────────────

function collectFiles(dir, base, out) {
	for (const name of readdirSync(dir)) {
		if (FS_EXCLUDES.has(name)) continue;
		const p = join(dir, name);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) collectFiles(p, base, out);
		else if (st.isFile()) out.push(relative(base, p).replace(/[\\/]/g, '/'));
	}
	return out;
}

function fsSignature(cwd) {
	const files = collectFiles(cwd, cwd, []);
	files.sort();
	const h = createHash('sha1');
	for (const f of files) {
		const st = statSync(join(cwd, f));
		h.update(f).update('\0').update(String(st.size)).update('\0').update(String(Math.trunc(st.mtimeMs))).update('\0');
	}
	return h.digest('hex');
}

function fsCheckpoint(cwd, title) {
	const index = readIndex(cwd);
	const last = index.items[index.items.length - 1];
	const sig = fsSignature(cwd);
	if (last && last.kind === 'fs' && last.signature === sig) return null;

	const files = collectFiles(cwd, cwd, []);
	if (files.length > FS_MAX_FILES) {
		process.stderr.write(`[my-better-dsh] fs 快照跳过：${files.length} 个文件超过上限 ${FS_MAX_FILES}（该工作区过大，改用 Git 或清理后重试）\n`);
		return null;
	}

	const id = `cp-${nowStamp()}-${String(Date.now() % 1000).padStart(3, '0')}`;
	const dest = join(workspaceDir(cwd), id);
	mkdirSync(dest, { recursive: true });
	for (const relPath of files) {
		const src = join(cwd, ...relPath.split('/'));
		const target = join(dest, ...relPath.split('/'));
		mkdirSync(join(dest, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
		try {
			copyFileSync(src, target);
		} catch {
			/* skip locked/unreadable files */
		}
	}
	return { id, title, time: nowLabel(), files, kind: 'fs', signature: sig };
}

function fsDiff(cwd, id) {
	const index = readIndex(cwd);
	const item = index.items.find((it) => it.id === id && it.kind === 'fs');
	if (!item) return { ok: false, error: 'unknown checkpoint id', text: '' };
	const pos = index.items.indexOf(item);
	const prev = pos > 0 ? index.items[pos - 1] : null;
	const dir = workspaceDir(cwd);
	if (prev && prev.kind === 'fs') {
		const r = run('git', ['diff', '--no-index', '--stat', '--patch', join(dir, prev.id), join(dir, id)], cwd);
		// --no-index exits 1 when differences exist — that is the success case.
		const text = (r.stdout || '') + (r.stderr || '');
		return { ok: true, text: text.slice(0, MAX_DIFF_CHARS) };
	}
	// First snapshot: show its file list as the initial-state diff.
	return { ok: true, text: `（初始快照，无前驱）\n新增文件：\n${item.files.map((f) => `+ ${f}`).join('\n')}` };
}

function fsRestore(cwd, id) {
	const index = readIndex(cwd);
	const item = index.items.find((it) => it.id === id && it.kind === 'fs');
	if (!item) return { ok: false, error: 'unknown checkpoint id' };
	const src = join(workspaceDir(cwd), id);
	for (const f of item.files) {
		const from = join(src, ...f.split('/'));
		const to = join(cwd, ...f.split('/'));
		if (!existsSync(from)) continue;
		mkdirSync(join(cwd, f.split('/').slice(0, -1).join('/')), { recursive: true });
		try {
			copyFileSync(from, to);
		} catch {
			/* skip locked/unwritable files */
		}
	}
	return { ok: true };
}

// ── checkpoint facade ──────────────────────────────────────────────────────

function createCheckpoint(cwd, title) {
	if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
	const index = readIndex(cwd);
	if (isGitRepo(cwd)) {
		if (index.mode !== 'git') {
			index.mode = 'git';
			index.items = [];
		}
		const item = gitCheckpoint(cwd, title);
		if (item !== null) index.items.push(item);
		writeIndex(cwd, index);
		return item;
	}
	// Non-git: file-copy snapshot fallback (never `git init`).
	index.mode = 'fs';
	const item = fsCheckpoint(cwd, title);
	if (item !== null) index.items.push(item);
	writeIndex(cwd, index);
	return item;
}

function checkpointList(cwd) {
	const index = readIndex(cwd);
	const gitNow = existsSync(cwd) && isGitRepo(cwd);
	// 仓库消失后按 none 处理（git 类快照此时无法 diff/restore，前端如实展示）。
	const mode = gitNow ? 'git' : index.mode === 'git' ? 'none' : index.mode;
	return {
		cwd,
		mode,
		gitRepo: gitNow,
		items: index.items.map(({ id, title, time, files, kind }) => ({ id, title, time, files, kind }))
	};
}

function checkpointDiff(cwd, id) {
	const item = readIndex(cwd).items.find((it) => it.id === id);
	if (!item) return { ok: false, error: 'unknown checkpoint id', text: '' };
	return item.kind === 'git' ? gitDiff(cwd, id) : fsDiff(cwd, id);
}

function checkpointRestore(cwd, id) {
	const item = readIndex(cwd).items.find((it) => it.id === id);
	if (!item) return { ok: false, error: 'unknown checkpoint id' };
	return item.kind === 'git' ? gitRestore(cwd, id) : fsRestore(cwd, id);
}

// ── global settings (~/.dsh/AGENTS.md — CLAUDE.md-style, every session) ────
// DSH's agent-instructions plugin discovers `$DSH_HOME/AGENTS.md` as the
// user-global scope and loads it into every session's baseline, so editing
// this one file is how the user sets rules that ALL sessions follow.
const GLOBAL_SETTINGS_FILE = 'AGENTS.md';
/** 单文件大小上限（1MB）；DSH 自身还有更小的渲染预算，超出的部分会被截断。 */
const GLOBAL_SETTINGS_MAX_BYTES = 1024 * 1024;

/** Starter template written when the global settings file does not exist yet. */
const GLOBAL_SETTINGS_TEMPLATE = `# 全局设定（Global Settings）

> 这个文件是「用户级全局设定」，模仿 Claude Code 的 CLAUDE.md：
> - 对所有会话生效：每次会话启动时，DSH 都会把本文件作为工作区指令基线载入；
> - 优先级：项目根/子目录下的 AGENTS.md、CLAUDE.md 更具体，会覆盖本文件的同名条目；
> - 修改保存后：新建会话立即生效，当前会话在下一轮回复前自动刷新。
> 格式为 Markdown，UTF-8 编码。以下为示例，请按需修改或删除。

## 语言与风格
- 一律使用简体中文回复，除非用户明确要求其他语言。
- 代码注释与提交信息使用中文；变量名/标识符使用英文。

## 工作方式
- 修改文件前先读取相关文件，理解上下文后再动手。
- 大改动先说明计划；破坏性操作（删除/覆盖文件）前先向用户确认。
- 每个任务结束，用一句话总结做了什么、改了哪些文件。

## 技术偏好
- 优先使用项目现有技术栈，不随意引入新依赖。
- 保持代码简洁、可读；优先复用项目内已有工具与组件。
`;

function globalSettingsPath() {
	return join(DSH_HOME, GLOBAL_SETTINGS_FILE);
}

function globalSettingsInfo() {
	const path = globalSettingsPath();
	const display = `~/.dsh/${GLOBAL_SETTINGS_FILE}`;
	let exists = false;
	let content = '';
	let bytes = 0;
	let mtime = null;
	if (existsSync(path)) {
		try {
			content = readFileSync(path, 'utf8');
			bytes = Buffer.byteLength(content, 'utf8');
			mtime = statSync(path).mtimeMs;
			exists = true;
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				path,
				display,
				exists: false,
				content: '',
				bytes: 0,
				mtime: null,
				active: false,
				scope: 'user-global',
				maxBytes: GLOBAL_SETTINGS_MAX_BYTES
			};
		}
	}
	return {
		ok: true,
		path,
		display,
		exists,
		content,
		bytes,
		mtime,
		// `active` = the file will be loaded by dsh-agent-instructions as the
		// user-global baseline for every session (it simply must exist).
		active: exists,
		scope: 'user-global',
		maxBytes: GLOBAL_SETTINGS_MAX_BYTES,
		template: GLOBAL_SETTINGS_TEMPLATE
	};
}

function saveGlobalSettings(content) {
	if (typeof content !== 'string') {
		return { ok: false, error: 'content 必须是字符串' };
	}
	const bytes = Buffer.byteLength(content, 'utf8');
	if (bytes > GLOBAL_SETTINGS_MAX_BYTES) {
		return { ok: false, error: `内容过大（${bytes} 字节，上限 ${GLOBAL_SETTINGS_MAX_BYTES} 字节）` };
	}
	try {
		mkdirSync(DSH_HOME, { recursive: true });
		const path = globalSettingsPath();
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, content, 'utf8');
		renameSync(tmp, path);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true, info: globalSettingsInfo() };
}

// ── live diff review (agent file changes → hunks, real-time) ───────────────
const DIFF_REVIEW_CAP = 100;
const DIFF_MAX_LINES = 2000;
const DIFF_MAX_BYTES = 2 * 1024 * 1024;
const DIFF_MAX_HUNK_LINES = 400;
/** Tools that touch a single file path; snapshot-before + diff-after. */
const FILE_TOOL_NAMES = new Set(['read', 'write', 'edit', 'str_replace_editor']);
/** Per-workspace ring buffer of published changes. */
const diffStore = new Map();
let diffSeq = 0;

function toLines(text) {
	const arr = (text ?? '').split('\n');
	if (arr.length > 1 && arr[arr.length - 1] === '') arr.pop();
	return arr;
}

/** Line diff (LCS) → unified-style hunks with 2-line context. */
function diffLinesToHunks(prevText, nextText) {
	const a = toLines(prevText);
	const b = toLines(nextText);
	// Oversized inputs: emit one full-replace hunk.
	if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES || a.length * b.length > 4_000_000) {
		return [{
			aStart: 1,
			aCount: a.length,
			bStart: 1,
			bCount: b.length,
			lines: [...a.map((x) => ({ t: 'del', x })), ...b.map((x) => ({ t: 'add', x }))]
		}];
	}
	const n = a.length;
	const m = b.length;
	const stride = m + 1;
	const dp = new Uint32Array((n + 1) * stride);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * stride + j] = a[i] === b[j]
				? dp[(i + 1) * stride + j + 1] + 1
				: Math.max(dp[(i + 1) * stride + j], dp[i * stride + j + 1]);
		}
	}
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) { ops.push({ t: 'ctx', x: a[i] }); i++; j++; }
		else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) { ops.push({ t: 'del', x: a[i] }); i++; }
		else { ops.push({ t: 'add', x: b[j] }); j++; }
	}
	while (i < n) { ops.push({ t: 'del', x: a[i] }); i++; }
	while (j < m) { ops.push({ t: 'add', x: b[j] }); j++; }

	const CONTEXT = 2;
	const aLineNo = new Array(ops.length);
	const bLineNo = new Array(ops.length);
	{
		let aPos = 1;
		let bPos = 1;
		for (let k = 0; k < ops.length; k++) {
			aLineNo[k] = aPos;
			bLineNo[k] = bPos;
			if (ops[k].t !== 'add') aPos++;
			if (ops[k].t !== 'del') bPos++;
		}
	}
	const hunks = [];
	let k = 0;
	while (k < ops.length) {
		while (k < ops.length && ops[k].t === 'ctx') k++;
		if (k >= ops.length) break;
		// Cluster of change ops separated by <= 2*CONTEXT context lines.
		let end = k;
		while (end + 1 < ops.length) {
			let gap = 0;
			let scan = end + 1;
			while (scan < ops.length && ops[scan].t === 'ctx') { gap++; scan++; }
			if (scan < ops.length && gap <= 2 * CONTEXT) end = scan;
			else break;
		}
		let s = k;
		let lead = 0;
		while (s - 1 >= 0 && ops[s - 1].t === 'ctx' && lead < CONTEXT) { s--; lead++; }
		let e = end;
		let trail = 0;
		while (e + 1 < ops.length && ops[e + 1].t === 'ctx' && trail < CONTEXT) { e++; trail++; }
		const lines = ops.slice(s, e + 1);
		let aCount = 0;
		let bCount = 0;
		for (const op of lines) {
			if (op.t !== 'add') aCount++;
			if (op.t !== 'del') bCount++;
		}
		hunks.push({ aStart: aLineNo[s], aCount, bStart: bLineNo[s], bCount, lines });
		k = e + 1;
	}
	return hunks;
}

/** The session workspace the execution belongs to (fallback: server cwd). */
function sessionCwdOf(exec) {
	try {
		const session = exec.agent?.session;
		if (session?.header?.cwd && typeof session.header.cwd === 'string' && session.header.cwd !== '') return session.header.cwd;
	} catch {
		/* keep the fallback */
	}
	return process.env.DSH_CWD ?? process.cwd();
}

/** Resolve the tool's target file (file_path or path arg), absolute. */
function toolPathOf(exec) {
	try {
		const args = exec.arguments;
		if (typeof args !== 'object' || args === null) return null;
		const fp = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : null;
		if (fp === null || fp === '') return null;
		const cwd = sessionCwdOf(exec);
		return isAbsolute(fp) ? fp : join(cwd, fp);
	} catch {
		return null;
	}
}

/** Publish one change into the workspace ring buffer. */
function recordDiff(exec, absPath, prev, next) {
	if (next === null) return;
	const cwd = sessionCwdOf(exec);
	const rel = relative(cwd, absPath).replace(/\\/g, '/') || absPath;
	const newFile = prev === null || prev === void 0 || prev === '';
	let hunks;
	let added = 0;
	let removed = 0;
	if (newFile) {
		const lines = toLines(next);
		hunks = [{ aStart: 1, aCount: 0, bStart: 1, bCount: lines.length, lines: lines.map((x) => ({ t: 'add', x })) }];
		added = lines.length;
	} else if (prev === next) {
		return;
	} else {
		hunks = diffLinesToHunks(prev, next);
		for (const hunk of hunks) {
			for (const op of hunk.lines) {
				if (op.t === 'add') added++;
				else if (op.t === 'del') removed++;
			}
		}
	}
	// Cap the published diff so a giant replace cannot flood the JSON feed.
	let total = 0;
	let truncated = false;
	for (const hunk of hunks) {
		total += hunk.lines.length;
		if (total > DIFF_MAX_HUNK_LINES) { truncated = true; break; }
	}
	if (truncated) {
		let kept = 0;
		for (const hunk of hunks) {
			if (kept + hunk.lines.length > DIFF_MAX_HUNK_LINES) hunk.lines = hunk.lines.slice(0, Math.max(0, DIFF_MAX_HUNK_LINES - kept));
			kept += hunk.lines.length;
			hunk.lines = hunk.lines.filter(Boolean);
		}
		hunks = hunks.filter((h) => h.lines.length > 0);
	}
	const entry = {
		seq: ++diffSeq,
		time: nowLabel(),
		tool: exec.name,
		file: rel,
		added,
		removed,
		newFile,
		truncated,
		hunks
	};
	let bucket = diffStore.get(cwd);
	if (bucket === void 0) {
		bucket = { entries: [] };
		diffStore.set(cwd, bucket);
	}
	bucket.entries.push(entry);
	if (bucket.entries.length > DIFF_REVIEW_CAP) bucket.entries.splice(0, bucket.entries.length - DIFF_REVIEW_CAP);
}

// ── plugin body ────────────────────────────────────────────────────────────

export function apply(ctx) {
	// ── 1) balance status ──
	let balance = null;
	let initialTotal = null;
	let lastError = null;

	async function refreshBalance() {
		try {
			const cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY');
			if (cred === void 0) {
				lastError = 'missing DEEPSEEK_API_KEY credential';
				balance = null;
				return;
			}
			const res = await fetch(BALANCE_URL, {
				headers: { Authorization: `Bearer ${cred.value}`, Accept: 'application/json' },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
			});
			if (!res.ok) throw new Error(`balance API HTTP ${res.status}`);
			const data = await res.json();
			const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
			const cny = infos.find((entry) => entry.currency === 'CNY') ?? infos[0];
			const total = cny !== void 0 ? Number.parseFloat(cny.total_balance) : Number.NaN;
			if (initialTotal === null && Number.isFinite(total)) initialTotal = total;
			balance = {
				total: Number.isFinite(total) ? total : null,
				currency: cny?.currency ?? null,
				isAvailable: data.is_available ?? null,
				fetchedAt: Date.now()
			};
			lastError = null;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			balance = null;
		}
	}

	const balanceTimer = setInterval(() => void refreshBalance(), REFRESH_MS);
	void refreshBalance();

	// ── client diagnostics pipeline (client POSTs apply/register/render events;
	//    I read them via GET /api/diag to debug without a browser console) ──
	const DIAG_LOG = join(DSH_HOME, 'logs', 'client-diag.jsonl');
	function writeDiag(evt, detail) {
		try {
			mkdirSync(join(DSH_HOME, 'logs'), { recursive: true });
			writeFileSync(DIAG_LOG, JSON.stringify({ t: Date.now(), evt, detail: detail ?? null }) + '\n', { flag: 'a' });
		} catch {
			/* ignore */
		}
	}

	// ── 2) auto checkpoint at the start of every agent run ──
	// Debounced per cwd: subagents and rapid consecutive runs share one run
	// window, so only the first 'running' transition creates a checkpoint.
	const lastAutoCheckpoint = new Map();
	ctx.on('agent/status', (payload) => {
		if (payload.status !== 'running') return;
		let cwd = process.env.DSH_CWD ?? process.cwd();
		try {
			const session = payload.agent?.session;
			if (session?.header?.cwd && typeof session.header.cwd === 'string') cwd = session.header.cwd;
		} catch {
			/* keep the fallback */
		}
		const now = Date.now();
		if (now - (lastAutoCheckpoint.get(cwd) ?? 0) < AUTO_DEBOUNCE_MS) return;
		lastAutoCheckpoint.set(cwd, now);
		const title = `Checkpoint ${nowStamp()} · 运行前快照 ${nowLabel()}`;
		Promise.resolve().then(() => {
			try {
				createCheckpoint(cwd, title);
			} catch (error) {
				ctx.logger?.warn?.(`[my-better-dsh] checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	});

	// ── 2b) live diff review ──
	// Snapshot the target file BEFORE a read/write/edit tool runs
	// (tools/pre-execute) so the after-diff has an exact before-side; on a
	// successful write/edit (tools/result) diff the new content against the
	// snapshot and publish hunks. Never breaks the tool pipeline.
	const fileSnapshots = new Map();
	const snapshotFile = (absPath) => {
		try {
			const st = statSync(absPath);
			if (!st.isFile() || st.size > DIFF_MAX_BYTES) return null;
			return readFileSync(absPath, 'utf8');
		} catch {
			return null;
		}
	};
	const rememberSnapshot = (absPath) => {
		if (absPath === null) return;
		fileSnapshots.set(absPath, snapshotFile(absPath));
		if (fileSnapshots.size > 500) {
			const first = fileSnapshots.keys().next().value;
			fileSnapshots.delete(first);
		}
	};
	ctx.on('tools/pre-execute', (exec, next) => {
		try {
			if (exec !== null && typeof exec === 'object' && FILE_TOOL_NAMES.has(exec.name)) {
				rememberSnapshot(toolPathOf(exec));
			}
		} catch {
			/* ignore */
		}
		return next();
	});
	ctx.on('tools/result', (exec, result) => {
		try {
			if (exec === null || typeof exec !== 'object' || !FILE_TOOL_NAMES.has(exec.name)) return;
			const absPath = toolPathOf(exec);
			if (absPath === null) return;
			const failed = result !== null && typeof result === 'object' && result.isError === true;
			if (exec.name === 'read') {
				if (!failed) rememberSnapshot(absPath);
				return;
			}
			if (failed) return;
			const prev = fileSnapshots.get(absPath);
			const next = snapshotFile(absPath);
			recordDiff(exec, absPath, prev, next);
			fileSnapshots.set(absPath, next);
		} catch {
			/* ignore */
		}
	});

	// ── 3) routes ──
	// cwd 白名单：写操作（create/restore）只允许已知工作区/会话目录/服务器
	// 目录，防止经本地 API 对任意目录执行 git 提交或覆盖文件。
	function allowedCwds() {
		const set = new Set([process.env.DSH_CWD ?? process.cwd()]);
		try {
			const reg = ctx.get('workspaceRegistry');
			if (reg !== void 0 && typeof reg.list === 'function') {
				for (const w of reg.list()) {
					if (w !== null && typeof w === 'object' && typeof w.path === 'string') set.add(w.path);
				}
			}
		} catch {
			/* no workspace registry */
		}
		try {
			const sessions = ctx.get('sessions');
			if (sessions !== void 0 && typeof sessions.list === 'function') {
				for (const s of sessions.list()) {
					const cwd = s?.header?.cwd;
					if (typeof cwd === 'string' && cwd !== '') set.add(cwd);
				}
			}
		} catch {
			/* no session store */
		}
		return set;
	}
	function readCwd(req) {
		const url = new URL(req.url, 'http://localhost');
		return url.searchParams.get('cwd') || process.env.DSH_CWD || process.cwd();
	}
	function readBody(req) {
		return new Promise((resolve) => {
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => {
				try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
			});
		});
	}
	function json(res, status, obj) {
		res.statusCode = status;
		res.setHeader('content-type', 'application/json');
		res.setHeader('cache-control', 'no-store');
		res.end(JSON.stringify(obj));
	}

	const disposeRoutes = [
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/status',
			handler: (_req, res) => {
				const spend = balance !== null && balance.total !== null && initialTotal !== null
					? Math.max(0, initialTotal - balance.total)
					: null;
				json(res, 200, {
					ok: balance !== null && lastError === null,
					balance: balance?.total ?? null,
					currency: balance?.currency ?? null,
					isAvailable: balance?.isAvailable ?? null,
					spend,
					fetchedAt: balance?.fetchedAt ?? null,
					error: lastError
				});
			}
		}),
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/checkpoints',
			handler: (req, res) => {
				try {
					json(res, 200, checkpointList(readCwd(req)));
				} catch (error) {
					json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}),
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/checkpoint/create',
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const cwd = body.cwd || readCwd(req);
					if (!allowedCwds().has(cwd)) {
						return json(res, 403, { ok: false, error: 'cwd 不在允许的工作区列表内' });
					}
					const item = createCheckpoint(cwd, body.title || `Checkpoint ${nowStamp()} · ${nowLabel()}`);
					json(res, 200, { ok: true, created: item !== null, checkpoint: item });
				} catch (error) {
					json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}),
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/checkpoint/diff',
			handler: (req, res) => {
				try {
					const url = new URL(req.url, 'http://localhost');
					const cwd = url.searchParams.get('cwd') || process.env.DSH_CWD || process.cwd();
					const id = url.searchParams.get('id');
					if (!id) return json(res, 400, { ok: false, error: 'missing id' });
					json(res, 200, { ok: true, ...checkpointDiff(cwd, id) });
				} catch (error) {
					json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}),
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/checkpoint/restore',
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const cwd = body.cwd || readCwd(req);
					if (!body.id) return json(res, 400, { ok: false, error: 'missing id' });
					if (!allowedCwds().has(cwd)) {
						return json(res, 403, { ok: false, error: 'cwd 不在允许的工作区列表内' });
					}
					const result = checkpointRestore(cwd, body.id);
					json(res, result.ok ? 200 : 400, { ok: result.ok, error: result.ok ? undefined : result.error });
				} catch (error) {
					json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}),
		// Left-sidebar file tree: list one directory of the ACTIVE workspace
		// (server cwd; the client passes the current session's cwd), excluding
		// heavy dirs. Read-only; `rel` cannot escape the workspace base.
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/fs/tree',
			handler: (req, res) => {
				try {
					const url = new URL(req.url, 'http://localhost');
					const base = url.searchParams.get('cwd') || process.env.DSH_CWD || process.cwd();
					if (!allowedCwds().has(base)) {
						return json(res, 403, { ok: false, error: 'cwd 不在允许的工作区列表内' });
					}
					const rel = (url.searchParams.get('rel') || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
					const dir = rel === '' ? base : join(base, ...rel.split('/'));
					// Containment: the resolved dir must stay inside the workspace base.
					const baseNorm = base.replace(/[\\/]+/g, '\\').toLowerCase();
					const dirNorm = dir.replace(/[\\/]+/g, '\\').toLowerCase();
					if (dirNorm !== baseNorm && !dirNorm.startsWith(`${baseNorm}\\`)) {
						return json(res, 403, { ok: false, error: 'outside workspace' });
					}
					if (!existsSync(dir) || !statSync(dir).isDirectory()) {
						return json(res, 404, { ok: false, error: 'not a directory' });
					}
					const dirs = [];
					const files = [];
					for (const name of readdirSync(dir)) {
						if (FS_EXCLUDES.has(name)) continue;
						let st;
						try {
							st = statSync(join(dir, name));
						} catch {
							continue;
						}
						if (st.isDirectory()) dirs.push(name);
						else if (st.isFile()) files.push({ name, size: st.size });
					}
					dirs.sort((a, b) => a.localeCompare(b));
					files.sort((a, b) => a.name.localeCompare(b.name));
					json(res, 200, { ok: true, base, rel, dirs, files });
				} catch (error) {
					json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}),
		// Client diagnostics: POST appends an event, GET returns recent lines.
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/diag',
			handler: (req, res) => {
				if (req.method === 'POST') {
					let body = '';
					req.on('data', (chunk) => { body += chunk; });
					req.on('end', () => {
						try {
							const j = JSON.parse(body || '{}');
							writeDiag(j.evt, j.detail);
						} catch {
							/* ignore */
						}
						json(res, 200, { ok: true });
					});
					return;
				}
				try {
					const lines = existsSync(DIAG_LOG)
						? readFileSync(DIAG_LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-100)
						: [];
					json(res, 200, { ok: true, lines });
				} catch {
					json(res, 200, { ok: true, lines: [] });
				}
			}
		}),
		// Delete a file (or an EMPTY directory) inside a whitelisted workspace.
		// Destructive: the client must double-confirm before calling this.
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/fs/delete',
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const base = body.cwd || process.env.DSH_CWD || process.cwd();
					if (!allowedCwds().has(base)) {
						return json(res, 403, { ok: false, error: 'cwd 不在允许的工作区列表内' });
					}
					const rel = (body.rel || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
					if (rel === '') return json(res, 400, { ok: false, error: '不能删除工作区根目录' });
					const target = join(base, ...rel.split('/'));
					const baseNorm = base.replace(/[\\/]+/g, '\\').toLowerCase();
					const targetNorm = target.replace(/[\\/]+/g, '\\').toLowerCase();
					if (targetNorm !== baseNorm && !targetNorm.startsWith(`${baseNorm}\\`)) {
						return json(res, 403, { ok: false, error: 'outside workspace' });
					}
					if (!existsSync(target)) return json(res, 404, { ok: false, error: '不存在' });
					const st = statSync(target);
					if (st.isDirectory()) {
						const entries = readdirSync(target);
						if (entries.length > 0) {
							return json(res, 400, { ok: false, error: '目录非空，请先删除内容' });
						}
						rmSync(target, { recursive: true });
					} else {
						rmSync(target);
					}
					json(res, 200, { ok: true });
				} catch (error) {
					json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}),
		// Global settings (~/.dsh/AGENTS.md): GET reads the file + metadata;
		// POST overwrites it (atomic). The webserver matches by pathname only,
		// so one route dispatches on req.method.
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/global-settings',
			handler: async (req, res) => {
				if (req.method === 'POST') {
					try {
						const body = await readBody(req);
						const result = saveGlobalSettings(body.content);
						if (!result.ok) return json(res, 400, { ok: false, error: result.error });
						return json(res, 200, { ok: true, saved: true, ...result.info });
					} catch (error) {
						return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
					}
				}
				const info = globalSettingsInfo();
				json(res, info.ok ? 200 : 500, info);
			}
		}),
		// Global settings: reset to the starter template.
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/global-settings/reset',
			handler: (_req, res) => {
				const result = saveGlobalSettings(GLOBAL_SETTINGS_TEMPLATE);
				if (!result.ok) return json(res, 400, { ok: false, error: result.error });
				json(res, 200, { ok: true, saved: true, reset: true, ...result.info });
			}
		}),
		// Live diff review: agent file changes for a workspace (newest first).
		// `after` filters to changes newer than a seq; the client polls this
		// every ~1.5s while its Diff Review tab is open.
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/diff-review',
			handler: (req, res) => {
				try {
					const url = new URL(req.url, 'http://localhost');
					const cwd = url.searchParams.get('cwd') || process.env.DSH_CWD || process.cwd();
					const after = Number.parseInt(url.searchParams.get('after') || '0', 10) || 0;
					const bucket = diffStore.get(cwd);
					const all = bucket !== void 0 ? bucket.entries : [];
					const changes = all.filter((e) => e.seq > after).slice(-50);
					json(res, 200, {
						ok: true,
						cwd,
						latestSeq: all.length > 0 ? all[all.length - 1].seq : 0,
						changes
					});
				} catch (error) {
					json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		})
	];

	return () => {
		clearInterval(balanceTimer);
		for (const dispose of disposeRoutes) dispose();
	};
}
