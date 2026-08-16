// my_better-dsh host half.
//
// 1) DeepSeek account status proxy (real balance API, 60s refresh).
// 2) Checkpoint system: when an agent run starts, a checkpoint of
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
import { createHash, randomUUID } from 'node:crypto';
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

export const inject = ['webServer', 'credentials', 'sessions'];

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

function gitCheckpoint(cwd, title, seq) {
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
	return { id, title, time: nowLabel(), files, kind: 'git', seq: seq ?? null };
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

function fsCheckpoint(cwd, title, seq) {
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
	return { id, title, time: nowLabel(), files, kind: 'fs', signature: sig, seq: seq ?? null };
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

function createCheckpoint(cwd, title, seq) {
	if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
	const index = readIndex(cwd);
	if (isGitRepo(cwd)) {
		if (index.mode !== 'git') {
			index.mode = 'git';
			index.items = [];
		}
		const item = gitCheckpoint(cwd, title, seq);
		if (item !== null) index.items.push(item);
		writeIndex(cwd, index);
		return item;
	}
	// Non-git: file-copy snapshot fallback (never `git init`).
	index.mode = 'fs';
	const item = fsCheckpoint(cwd, title, seq);
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
		items: index.items.map(({ id, title, time, files, kind, seq }) => ({ id, title, time, files, kind, seq }))
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

// ── security: delete confirmation (Full Access except delete) ───────────────
// 复用 DSH 官方统一工具执行入口 tools/pre-execute（waterfall，见 dsh-tools 的
// prepareExecution：监听器返回 {kind:'allow'|'ask'|'deny'} 即可放行/审批/拒绝）：
// 这里检测「真正的删除操作」（结构化删除工具 + shell 删除命令），挂起工具、
// 等待用户在 Web UI 确认后再放行；非删除操作一律放行，保持 Full Access 的
// 其它行为完全不变。不修改 DSH 核心，不另起一套互相冲突的权限系统。
const SECURITY_MODES = new Set(['full-access', 'full-access-except-delete']);
const DELETE_CONFIRM_TIMEOUT_MS = 90_000;
const SECURITY_MODE_FILE = join(DSH_HOME, 'my-better-dsh-security-mode.json');
/** 读取持久化的 Security Mode（文件不存在/损坏时回退默认 full-access-except-delete）。 */
function loadSecurityMode() {
	try {
		if (existsSync(SECURITY_MODE_FILE)) {
			const parsed = JSON.parse(readFileSync(SECURITY_MODE_FILE, 'utf8'));
			if (parsed !== null && typeof parsed === 'object' && SECURITY_MODES.has(parsed.mode)) return parsed.mode;
		}
	} catch {
		/* ignore */
	}
	return 'full-access-except-delete';
}
/** 持久化 Security Mode（开关状态重启后保留）。 */
function saveSecurityMode(mode) {
	try {
		mkdirSync(DSH_HOME, { recursive: true });
		writeFileSync(SECURITY_MODE_FILE, JSON.stringify({ mode, updatedAt: Date.now() }, null, 2), 'utf8');
	} catch {
		/* ignore */
	}
}
/** 结构化删除型工具名：精确匹配（绝不子串匹配，避免误伤 read/write/edit 等）。 */
const DELETE_TOOL_NAMES = new Set([
	'delete_file', 'delete-file', 'deleteFile', 'delete',
	'remove_file', 'remove-file', 'removeFile', 'remove',
	'unlink', 'unlink_file', 'DeleteFile', 'RemoveFile'
]);
/** POSIX shell（bash/sh/zsh/dash）删除命令词：命令首 token 精确匹配。 */
const BASH_DELETE_CMDS = new Set(['rm', 'rmdir', 'unlink']);
/** Windows CMD 删除命令词。 */
const CMD_DELETE_CMDS = new Set(['del', 'erase', 'rmdir', 'rd']);
/** PowerShell 删除命令词（Remove-Item 及其别名）。 */
const PS_DELETE_CMDS = new Set(['remove-item', 'rm', 'del', 'erase', 'ri', 'rd', 'rmdir']);

/**
 * 把 shell 脚本拆成「命令段」列表（段内第一个 word 即命令词）。
 * 分隔符：\n ; && || | ；# 注释；引号（' "）感知；反斜杠转义。
 * 用于可靠识别删除命令，避免对命令字符串里的 rm/delete 字样误判。
 */
function shellSegments(script) {
	const segs = [];
	let cur = '';
	let quote = null;
	for (let i = 0; i < script.length; i++) {
		const ch = script[i];
		if (quote !== null) {
			cur += ch;
			if (quote === '"' && ch === '\\' && i + 1 < script.length) { cur += script[++i]; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '\\') { cur += ch; if (i + 1 < script.length) cur += script[++i]; continue; }
		if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
		if (ch === '#') {
			while (i + 1 < script.length && script[i + 1] !== '\n') i++;
			continue;
		}
		if (ch === '\n' || ch === ';' || ch === '&' || ch === '|') {
			if (cur.trim() !== '') segs.push(cur.trim());
			cur = '';
			if ((ch === '&' || ch === '|') && script[i + 1] === ch) i++;
			continue;
		}
		cur += ch;
	}
	if (cur.trim() !== '') segs.push(cur.trim());
	return segs;
}

/** 引号/转义感知分词：返回每个 token 的原文（含引号），用于选项剥离与路径提取。 */
function tokenizeSegment(segment) {
	const tokens = [];
	let cur = '';
	let quote = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote !== null) {
			cur += ch;
			if (quote === '"' && ch === '\\' && i + 1 < segment.length) { cur += segment[++i]; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '\\') { cur += ch; if (i + 1 < segment.length) cur += segment[++i]; continue; }
		if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
		if (ch === ' ' || ch === '\t' || ch === ',' || ch === '=') {
			if (cur !== '') { tokens.push(cur); cur = ''; }
			continue;
		}
		cur += ch;
	}
	if (cur !== '') tokens.push(cur);
	return tokens;
}

/** 去掉 token 的包裹引号与转义，得到实际路径文本。 */
function unquoteToken(token) {
	if (token.length >= 2 && (token.startsWith("'") && token.endsWith("'") || token.startsWith('"') && token.endsWith('"'))) {
		return token.slice(1, -1).replace(/\\(.)/g, '$1');
	}
	return token.replace(/\\(.)/g, '$1');
}

/** 段内第一个 word（命令词），小写。 */
function firstWordOf(segment) {
	const t = tokenizeSegment(segment);
	return t.length > 0 ? unquoteToken(t[0]).toLowerCase() : '';
}

/**
 * 从 rm/rmdir/unlink/del/Remove-Item 等段里提取目标路径（跳过选项与 --）。
 * @param segment - 命令段文本。
 * @param cmd - 命令词（小写），用于区分 POSIX（-x 选项）与 CMD 风格（/x 开关）。
 */
function deleteTargetsFromSegment(segment, cmd) {
	const tokens = tokenizeSegment(segment);
	const paths = [];
	let afterDoubleDash = false;
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (!afterDoubleDash && t === '--') { afterDoubleDash = true; continue; }
		if (!afterDoubleDash && t.startsWith('-') && t.length > 1) continue;
		// CMD 开关：del /q、rd /s /q、erase /f 等（全字母短开关）
		if (!afterDoubleDash && (cmd === 'del' || cmd === 'erase' || cmd === 'rd' || cmd === 'rmdir') && /^\/[a-zA-Z]+$/.test(t)) continue;
		const p = unquoteToken(t);
		if (p === '' || p === '~') continue;
		paths.push(p);
	}
	return paths;
}

/** 段文本是否包含递归标志：--recursive / -Recurse / 短选项组合 -r/-rf/-fr/-R 等。 */
function segmentHasRecursive(segment) {
	if (/--recursive\b|-Recurse\b/i.test(segment)) return true;
	const tokens = tokenizeSegment(segment);
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === '--') break;
		if (!t.startsWith('-') || t.length < 2) continue;
		const body = t.slice(1);
		if (body === 'r' || body === 'R') return true;
		if (/^[rRfF]+$/.test(body) && /[rR]/.test(body)) return true;
	}
	return false;
}

/** 判断路径当前是否为目录（stat 失败时用尾斜杠猜测）。 */
function isDirectoryPath(absPath) {
	try {
		return statSync(absPath).isDirectory();
	} catch {
		return absPath.endsWith('/') || absPath.endsWith('\\');
	}
}

/** 目录内容统计（有限遍历，防卡死）：{ files, dirs, truncated } 或 null。 */
function statDirTree(absPath) {
	let files = 0;
	let dirs = 0;
	const MAX_ENTRIES = 4000;
	const MAX_DEPTH = 5;
	function walk(p, depth) {
		if (files + dirs >= MAX_ENTRIES || depth > MAX_DEPTH) return;
		let entries;
		try {
			entries = readdirSync(p, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files + dirs >= MAX_ENTRIES) return;
			if (entry.isDirectory()) {
				dirs++;
				walk(join(p, entry.name), depth + 1);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				files++;
			}
		}
	}
	try {
		walk(absPath, 0);
	} catch {
		return null;
	}
	return { files, dirs, truncated: files + dirs >= MAX_ENTRIES };
}

/**
 * 从一条 shell 命令里检测删除操作。
 * @param command - 工具收到的命令字符串。
 * @param shell - 'bash' | 'pwsh'（cmd 风格合并进 bash 识别 del/erase/rd）。
 * @returns { tool, paths, recursive } | null —— null 表示未检测到删除。
 */
function detectDeleteCommand(command, shell) {
	if (typeof command !== 'string' || command.trim() === '') return null;
	const segs = shellSegments(command);
	const out = { tool: shell, paths: [], recursive: false };
	for (const seg of segs) {
		// bash 赋值语句（VAR=...）不是命令，跳过，避免 DEL=1 之类误判
		if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(seg)) continue;
		const cmd = firstWordOf(seg);
		const isPs = shell === 'pwsh';
		if (isPs) {
			// PowerShell/.NET 直接调用：[IO.File]::Delete('x') / [IO.Directory]::Delete('d', $true)
			if (/::Delete\s*\(/i.test(seg)) {
				const m = seg.match(/::Delete\s*\(\s*(['"])(.*?)\1/i);
				if (m && m[2] !== '') {
					const p = m[2];
					if (!out.paths.includes(p)) out.paths.push(p);
					// [IO.Directory]::Delete / [System.IO.Directory]::Delete → 目录
					out.recursive = out.recursive || /Directory\]::Delete/i.test(seg);
				}
				continue;
			}
			if (!PS_DELETE_CMDS.has(cmd)) continue;
			const paths = deleteTargetsFromSegment(seg, cmd);
			if (paths.length === 0) continue;
			out.recursive = out.recursive || segmentHasRecursive(seg) || cmd === 'rd' || cmd === 'rmdir';
			for (const p of paths) if (!out.paths.includes(p)) out.paths.push(p);
			continue;
		}
		// bash / sh / cmd 风格
		if (BASH_DELETE_CMDS.has(cmd) || CMD_DELETE_CMDS.has(cmd)) {
			const paths = deleteTargetsFromSegment(seg, cmd);
			if (paths.length === 0) continue;
			out.recursive = out.recursive || segmentHasRecursive(seg) || cmd === 'rmdir' || cmd === 'rd';
			for (const p of paths) if (!out.paths.includes(p)) out.paths.push(p);
			continue;
		}
	}
	if (out.paths.length === 0) return null;
	return out;
}

/**
 * 判定一次工具调用是否为「真正的删除操作」。
 * 优先按工具名 + 参数（结构化工具），其次按 shell 命令解析（bash/pwsh）。
 * @returns { tool, kind: 'file'|'files'|'directory', paths, recursive } | null
 */
function detectDelete(exec) {
	if (exec === null || typeof exec !== 'object') return null;
	const name = exec.name;
	const args = exec.arguments;
	if (typeof args !== 'object' || args === null) return null;
	// 1) 结构化删除工具：工具名精确匹配 + 收集文件路径参数
	if (DELETE_TOOL_NAMES.has(name)) {
		const paths = [];
		for (const key of ['file_path', 'path', 'target', 'file', 'files', 'paths']) {
			const v = args[key];
			if (typeof v === 'string' && v !== '') {
				if (!paths.includes(v)) paths.push(v);
			} else if (Array.isArray(v)) {
				for (const p of v) if (typeof p === 'string' && p !== '' && !paths.includes(p)) paths.push(p);
			}
		}
		if (paths.length === 0) return null;
		const recursive = args.recursive === true || args.recursive === 'true' || args.recursive === 1;
		return { tool: name, kind: null, paths, recursive };
	}
	// 2) shell 命令（bash / pwsh 统一入口，CMD 命令词在 bash 分支内一并识别）
	if ((name === 'bash' || name === 'pwsh') && typeof args.command === 'string') {
		return detectDeleteCommand(args.command, name);
	}
	return null;
}

// ── conversation handoff（对话迁徙）─────────────────────────────────────────
// 复用 DSH 自身的 Agent/Session 机制，零新增外部 API / Provider / 模型 / Key：
// 1) 用 ctx.get('agents').create() 建一个内部临时分析 agent（handoff-<uuid>），
//    seed 注入当前 Conversation 历史，setup 里 tools.restrict({allow:[]}) 禁止
//    一切工具；followup 注入分析 Prompt → 跑一轮 → 读取输出的 Context Handoff。
// 2) dispose 临时 agent 并清理其持久化文件（不污染会话列表）。
// 3) 用同一个 create() 建全新 Conversation（新 sessionId，meta.parentSession
//    标记来源），把 Handoff 作为第一条消息 inject 进上下文。
// 原 Conversation / Session 完全不变；不碰 prepare/resume/rollback。
const HANDOFF_ANALYZER_PROMPT = `你现在是一个 Context Handoff Analyzer。

你的任务不是继续完成用户任务。你不能执行任何 Tool，不能修改任何文件，不能运行终端命令，不能联网，不能改变原来的 Conversation。

你只负责分析下面提供的完整历史对话，并生成一份给「新的 Coding Agent」使用的工作状态摘要。

你的目标不是总结聊天内容。你的目标是让新的 Agent 在不知道原始对话的情况下，也能够无缝继续当前工作。

必须提取：
1. 当前最终目标
2. 已经完成的工作
3. 当前正在进行的工作
4. 用户明确提出的要求
5. 用户明确禁止的事情
6. 已经确定的技术方案
7. 重要设计决策
8. 已修改或创建的重要文件
9. 当前存在的问题
10. 已经尝试过但失败的方法
11. 当前 Task Board 状态
12. 下一步最应该做什么
13. 最近对话中仍然重要的信息

特别注意：
不要丢失用户的限制条件。例如用户说「不要修改 API。」「只修改 UI。」「不要重构。」必须明确保留，不要当成普通聊天总结掉。
如果某件事情已经完成，不要让新 Agent 再做一次。
如果某个方案已经明确失败，不要让新 Agent 再尝试相同方案。
如果当前存在 Bug，要明确说明：Bug 是什么、已经尝试过什么、哪些方法失败、当前最合理的下一步。

输出必须简洁，但信息密度要高。不要输出与继续工作无关的闲聊。

最终输出格式（只输出这份 Handoff，不要输出分析过程，不要解释你是怎么分析的）：

# Context Handoff

## 当前目标
...

## 已完成
- ...

## 当前进度
- ...

## 用户要求
- ...

## 用户限制
- ...

## 重要决定
- ...

## 已修改文件
- ...

## 当前问题
- ...

## 已失败方案
- ...

## Task Board
- ...

## 下一步
- ...

## 最近重要上下文
...

以下是需要分析的完整历史对话：`;

// ── 迁徙上下文预处理（host 本地过滤，避免把完整对话原样喂给分析 agent）──
// 目标：800K 原始 → 本地轻量过滤 → 尽可能小的有效上下文 → handoff agent。
// 保留：用户消息/要求/限制、Agent 最终结论、重要 Tool Call/Result、文件路径、
// 错误信息、技术决策、最近若干轮完整；过滤：重复工具输出、大段安装/编译日志、
// 重复代码、被覆盖的中间信息。已有 compaction 摘要节点（plugin:'compact'）优先
// 保留复用，不重复分析。
const HANDOFF_PREPROCESS = {
	recentTurns: 3,            // 最近 N 轮完整保留
	maxAssistantChars: 2500,   // 单条 Agent 结论上限
	maxToolArgsChars: 400,     // 工具调用参数摘要上限
	maxToolResultChars: 900,   // 单条工具结果上限
	maxTotalChars: 140_000     // 过滤后总上限（超长会话仍可控）
};
/** 噪音输出模式（安装/编译日志等）：命中则折叠为一行。 */
const HANDOFF_NOISE_PATTERNS = [
	/added \d+ packages|removed \d+ packages|changed \d+ packages|up to date in|npm (warn|notice|info) /i,
	/Installing collected packages|Successfully installed|Collecting \S+|Requirement already satisfied/i,
	/vite v\d|built in \d+(ms|s)|compiled successfully|tsc -p|Build finished/i,
	/\d+ packages? in \d+(ms|s)|├─|└─|npm error code/i,
	/^\s*$/
];

/** compaction 生成的摘要消息（复用，不再让模型重新分析）。 */
function isCompactionSummaryEvent(ev) {
	const source = ev?.data?.source;
	if (source === null || typeof source !== 'object') return false;
	return source.plugin === 'compact' || source.kind === 'compact' || (typeof source.plugin === 'string' && source.plugin.startsWith('compact'));
}

/** 从事件 data.content（字符串或块数组）提取文本与块信息。 */
function extractContentBlocks(ev) {
	const content = ev?.data?.content;
	const texts = [];
	const toolCalls = [];
	const toolResults = [];
	if (typeof content === 'string') {
		if (content.trim() !== '') texts.push(content.trim());
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (block === null || typeof block !== 'object') continue;
			if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') texts.push(block.text.trim());
			else if (block.type === 'tool-call') toolCalls.push(block);
			else if (block.type === 'tool-result') toolResults.push(block);
			else if (block.type === 'reasoning') { /* 跳过推理过程 */ }
		}
	}
	return { texts, toolCalls, toolResults };
}

/** 噪音折叠：命中安装/编译日志模式 → 返回简短占位，否则 null。 */
function collapseNoise(text) {
	if (typeof text !== 'string' || text.length < 80) return null;
	const lines = text.split('\n');
	const hits = lines.filter((l) => HANDOFF_NOISE_PATTERNS.some((re) => re.test(l))).length;
	if (hits > 0 && hits / lines.length > 0.4) {
		const kept = lines.filter((l) => /error|fail|ERR|warning/i.test(l)).slice(0, 5);
		return kept.length > 0 ? `（安装/编译日志已折叠，保留错误行）\n${kept.join('\n')}` : '（安装/编译日志已折叠）';
	}
	return null;
}

/** 工具结果去重指纹：基于内容（相同输出只保留一次，无论调用 id）。 */
function toolResultFingerprint(text) {
	return text.slice(0, 200);
}

/**
 * 本地预处理对话事件，产出给 handoff agent 的紧凑文本。
 * @returns { text, estimatedTokens, droppedEvents } | null（events 为空时 null）
 */
function preprocessHistoryForHandoff(events) {
	if (!Array.isArray(events) || events.length === 0) return null;
	// 1) 按轮切分（turn/start..turn/end），同时收集轮外事件
	const turns = [];
	let current = [];
	let pendingStart = null;
	for (const ev of events) {
		if (ev?.type === 'turn/start') {
			if (pendingStart !== null && current.length > 0) turns.push(current);
			current = [];
			pendingStart = ev;
			current.push(ev);
		} else if (ev?.type === 'turn/end') {
			current.push(ev);
			turns.push(current);
			current = [];
			pendingStart = null;
		} else if (pendingStart !== null) {
			current.push(ev);
		} else if (ev?.type === 'user/message' || ev?.type === 'assistant/message') {
			// turn 边界缺失的事件：归入独立"轮"
			turns.push([ev]);
		}
	}
	if (current.length > 0) turns.push(current);
	if (turns.length === 0) return null;

	const out = [];
	let dropped = 0;
	const seenResults = new Set();
	const totalRef = { chars: 0 };
	const push = (line) => {
		out.push(line);
		totalRef.chars += line.length + 1;
	};
	const overBudget = () => totalRef.chars > HANDOFF_PREPROCESS.maxTotalChars;

	// 2) 轮次索引：最近 N 轮完整，更早的压缩
	const n = turns.length;
	for (let ti = 0; ti < n; ti++) {
		if (overBudget()) { dropped += 1; break; }
		const turn = turns[ti];
		const isRecent = ti >= n - HANDOFF_PREPROCESS.recentTurns;
		const turnNo = ti + 1;
		push(`\n【第 ${turnNo} 轮${isRecent ? '' : '（较早，仅保留要点）'}】`);
		for (const ev of turn) {
			if (overBudget()) break;
			const type = ev?.type;
			if (type === 'turn/start' || type === 'turn/end' || type === 'request/header') continue;
			if (type === 'user/message') {
				const { texts, toolResults } = extractContentBlocks(ev);
				if (isCompactionSummaryEvent(ev)) {
					// 已有摘要（compaction 产物）：优先保留复用
					const t = texts.join('\n').slice(0, 6000);
					if (t !== '') push(`【已有摘要】${t}`);
					continue;
				}
				if (toolResults.length > 0) {
					for (const tr of toolResults) {
						const text = typeof tr.content === 'string' ? tr.content : Array.isArray(tr.content) ? tr.content.map((b) => (b && typeof b.text === 'string' ? b.text : typeof b === 'string' ? b : '')).join('\n') : '';
						const raw = (typeof tr.content === 'string' ? tr.content : '') || text;
						const collapsed = collapseNoise(raw);
						const body = collapsed ?? text.slice(0, HANDOFF_PREPROCESS.maxToolResultChars);
						const fp = toolResultFingerprint(raw);
						if (seenResults.has(fp)) { dropped += 1; continue; }
						seenResults.add(fp);
						if (tr.isError === true) push(`【工具失败】${tr.toolCallId ?? ''}: ${body.slice(0, HANDOFF_PREPROCESS.maxToolResultChars)}`);
						else if (collapsed !== null) push(`【工具】${tr.toolCallId ?? ''}: ${collapsed}`);
						else push(`【工具结果】${tr.toolCallId ?? ''}: ${body}${raw.length > HANDOFF_PREPROCESS.maxToolResultChars ? ' …（已截断）' : ''}`);
					}
					continue;
				}
				const t = texts.join('\n').slice(0, 4000);
				if (t !== '') push(`用户：${t}`);
				continue;
			}
			if (type === 'assistant/message') {
				const { texts, toolCalls } = extractContentBlocks(ev);
				// 工具调用摘要
				for (const tc of toolCalls) {
					const name = tc.name ?? '?';
					const argsText = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
					const summarized = argsText.length > HANDOFF_PREPROCESS.maxToolArgsChars ? `${argsText.slice(0, HANDOFF_PREPROCESS.maxToolArgsChars)}…` : argsText;
					push(`【调用 ${name}】${summarized}`);
				}
				if (texts.length > 0) {
					// 该轮结论 = 最后的文本；较早轮次只保留第一条要点
					const last = texts[texts.length - 1];
					if (isRecent) {
						for (const t of texts) push(`Agent：${t.slice(0, HANDOFF_PREPROCESS.maxAssistantChars)}`);
					} else {
						push(`Agent（要点）：${last.slice(0, HANDOFF_PREPROCESS.maxAssistantChars)}`);
					}
				}
			}
		}
	}
	const text = out.join('\n').trim();
	if (text === '') return null;
	return {
		text,
		estimatedTokens: Math.max(100, Math.ceil(text.length / 3)),
		droppedEvents: dropped
	};
}

/** 构造一条 user 消息对象（与 dsh-llm createUserMessage 同形状，零新增依赖）。 */
function createHandoffUserMessage(text) {
	return {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: { kind: 'plugin', plugin: 'my-better-dsh' }
	};
}

/** 从会话事件里取最后一条 assistant 消息的文本（无则 null）。 */
function lastAssistantText(events) {
	if (!Array.isArray(events)) return null;
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev === null || typeof ev !== 'object' || ev.type !== 'assistant/message') continue;
		const content = ev.data?.content;
		if (typeof content === 'string' && content.trim() !== '') return content;
		if (Array.isArray(content)) {
			const text = content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('').trim();
			if (text !== '') return text;
		}
	}
	return null;
}

/** 复制当前 agent 的 provider/model 等配置（零新增，纯复用）。 */
function pickAgentOptions(agent) {
	const options = agent?.options;
	if (options === null || typeof options !== 'object') return {};
	const out = {};
	for (const key of ['provider', 'model', 'maxTokens', 'reasoningEffort']) {
		if (options[key] !== void 0) out[key] = options[key];
	}
	return out;
}

/** 把历史事件裁剪到「最后一个闭合 turn」之后，避免以 open turn 结尾被 Session 校验拒绝。 */
function balancedHistory(events, max) {
	if (!Array.isArray(events) || events.length === 0) return [];
	let list = events.length > max ? events.slice(-max) : events;
	// 尾部若处于 open turn（最后一个 turn 事件是 turn/start），裁掉其后所有事件
	for (let i = list.length - 1; i >= 0; i--) {
		const type = list[i]?.type;
		if (type === 'turn/end') break;
		if (type === 'turn/start') { list = list.slice(0, i); break; }
	}
	return list;
}

/** 清理临时 handoff session 的持久化文件（位于 ~/.dsh/sessions 下各项目目录）。 */
function removeTempSessionFiles(id) {
	const root = join(DSH_HOME, 'sessions');
	if (!existsSync(root)) return;
	for (const project of readdirSync(root)) {
		const dir = join(root, project, id);
		try {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
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
				createCheckpoint(cwd, title, null);
			} catch (error) {
				ctx.logger?.warn?.(`[my-better-dsh] checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	});

	// ── 2a) handoff 临时分析会话兜底：禁止一切工具调用（restrict 之外的硬拦截）──
	// handoff-* 会话只能读注入的上下文并输出 Handoff，任何工具调用直接拒绝。
	ctx.on('tools/pre-execute', (exec, next) => {
		try {
			const agentId = exec?.agent?.id;
			if (typeof agentId === 'string' && agentId.startsWith('handoff-')) {
				return { kind: 'deny', reason: 'Handoff 分析会话禁止调用任何工具（只允许分析提供的上下文并输出 Context Handoff）。' };
			}
		} catch {
			/* ignore */
		}
		return next();
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

	// ── 3) security: delete confirmation（Full Access except delete）──
	// 复用 DSH 官方统一工具执行入口 tools/pre-execute（waterfall）拦截删除操作：
	// 检测到真正删除 → 挂起工具、登记 pending、等待 Web UI 确认；用户允许 →
	// {kind:'allow'} 放行；拒绝/超时 → {kind:'deny', reason}（工具以 isError 返回
	// 给 Agent，run 不崩溃）。非删除操作一律 next() 放行，Full Access 其它行为不变。
	// Security Mode 可经 GET/POST /my-better-dsh/api/security/mode 查看/切换；
	// 开关状态持久化到 ~/.dsh/my-better-dsh-security-mode.json（重启后保留）。
	let securityMode = loadSecurityMode();
	/** pending 删除确认表：id -> { sessionId, cwd, payload, settle }。 */
	const pendingDeletes = new Map();

	/** 相对 cwd 展示路径（与 UI 例子一致：src/test.ts）。 */
	const displayPath = (cwd, p) => {
		try {
			const abs = isAbsolute(p) ? p : join(cwd, p);
			const rel = relative(cwd, abs);
			return rel === '' ? p : rel.replace(/\\/g, '/');
		} catch {
			return p;
		}
	};

	/**
	 * 挂起一次删除工具调用，等待用户确认。
	 * @returns Promise<{kind:'allow'} | {kind:'deny', reason}> —— 直接作为
	 *   tools/pre-execute 的 decision 返回给 dsh-tools。
	 */
	const askDeleteConfirmation = (exec, info) => {
		const id = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const cwd = sessionCwdOf(exec);
		let hasCheckpoint = false;
		try {
			hasCheckpoint = readIndex(cwd).items.length > 0;
		} catch {
			/* ignore */
		}
		const kind = info.kind ?? (
			info.paths.length > 1 ? 'files'
				: info.recursive && info.paths.length > 0 && isDirectoryPath(isAbsolute(info.paths[0]) ? info.paths[0] : join(cwd, info.paths[0]))
					? 'directory' : 'file'
		);
		const payload = {
			id,
			tool: exec.name,
			kind,
			recursive: info.recursive,
			paths: info.paths.map((p) => displayPath(cwd, p)),
			hasCheckpoint,
			dirStats: null,
			createdAt: Date.now()
		};
		if ((kind === 'directory' || info.recursive) && info.paths.length > 0) {
			const abs = isAbsolute(info.paths[0]) ? info.paths[0] : join(cwd, info.paths[0]);
			payload.dirStats = statDirTree(abs);
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				pendingDeletes.delete(id);
				resolve({ kind: 'deny', reason: `删除确认超时（${Math.round(DELETE_CONFIRM_TIMEOUT_MS / 1000)} 秒无响应），已取消该删除操作。` });
			}, DELETE_CONFIRM_TIMEOUT_MS);
			pendingDeletes.set(id, {
				sessionId: exec.agent?.session?.id ?? null,
				cwd,
				payload,
				settle(allow) {
					clearTimeout(timer);
					pendingDeletes.delete(id);
					resolve(allow ? { kind: 'allow' } : { kind: 'deny', reason: '用户拒绝了该删除操作。' });
				}
			});
		});
	};

	ctx.on('tools/pre-execute', async (exec, next) => {
		try {
			if (securityMode !== 'full-access-except-delete') return next();
			const info = detectDelete(exec);
			if (info === null) return next();
			return await askDeleteConfirmation(exec, info);
		} catch (error) {
			// 确认流程自身出错 → 保守拒绝（fail closed），不崩 run
			return { kind: 'deny', reason: `删除确认流程异常，已取消该删除操作：${error instanceof Error ? error.message : String(error)}` };
		}
	});

	// ── 4) routes ──
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
		}),
		// Security mode: GET 查看 / POST 切换（full-access | full-access-except-delete）。
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/security/mode',
			handler: async (req, res) => {
				if (req.method === 'POST') {
					try {
						const body = await readBody(req);
						if (!SECURITY_MODES.has(body.mode)) {
							return json(res, 400, { ok: false, error: `invalid mode（可选：${[...SECURITY_MODES].join(' / ')}）` });
						}
						securityMode = body.mode;
						saveSecurityMode(securityMode);
						return json(res, 200, { ok: true, mode: securityMode });
					} catch (error) {
						return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
					}
				}
				json(res, 200, { ok: true, mode: securityMode });
			}
		}),
		// 删除确认：client 轮询当前 session 的待确认项。
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/security/delete-pending',
			handler: (req, res) => {
				try {
					const url = new URL(req.url, 'http://localhost');
					const sessionId = url.searchParams.get('session') ?? null;
					const items = [...pendingDeletes.values()]
						.filter((p) => sessionId === null || sessionId === '' || p.sessionId === null || p.sessionId === sessionId)
						.map((p) => p.payload);
					json(res, 200, { ok: true, items });
				} catch (error) {
					json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}),
		// 删除确认：client 回传用户决定（allow: true 放行 / false 拒绝）。
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/security/delete-resolve',
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const pending = pendingDeletes.get(body.id);
					if (!pending) return json(res, 404, { ok: false, error: '待确认项不存在或已过期' });
					pending.settle(body.allow === true);
					json(res, 200, { ok: true });
				} catch (error) {
					json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}),
		// 对话迁徙：分析当前对话 → 生成 Context Handoff → 创建新 Conversation。
		// 只复用当前 DSH Agent/LLM Runtime（从当前 agent 复制 provider/model），
		// 不新增任何外部 API / Provider / 模型 / Key；原 Session 完全不变。
		ctx.webServer.register({
			kind: 'exact',
			path: '/my-better-dsh/api/handoff',
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const sessionId = body.sessionId;
					if (!sessionId) return json(res, 400, { ok: false, error: 'missing sessionId' });
					const agents = ctx.get('agents');
					if (agents === void 0 || typeof agents.create !== 'function') {
						return json(res, 500, { ok: false, error: 'agents 服务不可用' });
					}
					const session = ctx.sessions?.get?.(sessionId);
					if (!session) return json(res, 404, { ok: false, error: 'session not found' });
					const cwd = session.header?.cwd;
					if (!cwd) return json(res, 400, { ok: false, error: 'session has no cwd' });
					const sourceAgent = agents.get?.(sessionId);
					const agentOptions = pickAgentOptions(sourceAgent);
					if (!agentOptions.provider || !agentOptions.model) {
						return json(res, 500, { ok: false, error: '无法获取当前 Agent 配置（provider/model）' });
					}

					// 1) 本地预处理：过滤无价值内容（重复工具输出/安装编译日志/被覆盖
					//    中间信息），保留用户要求/限制/错误/技术决策/文件路径/最近轮次；
					//    已有 compaction 摘要节点直接复用，不重复分析。
					const preprocessed = preprocessHistoryForHandoff(session.events);
					if (preprocessed === null) {
						return json(res, 400, { ok: false, error: '当前对话没有可分析的内容' });
					}

					// 2) 临时分析 agent：不携带完整历史（seed 为空），只注入预处理后的
					//    紧凑上下文；禁止一切工具；输出 Context Handoff。
					const tempId = `handoff-${randomUUID()}`;
					let handoffText = null;
					let tempHandle = null;
					try {
						tempHandle = await agents.create({
							sessionId: tempId,
							meta: { cwd },
							agentOptions,
							setup: (agentCtx) => {
								try { agentCtx.tools.restrict({ allow: [] }); } catch { /* ignore */ }
							}
						});
						const tempAgent = tempHandle?.agent;
						if (!tempAgent) throw new Error('临时分析 agent 创建失败');
						// 附加 Task Board 状态（client 从 localStorage 提供，纯内部数据）
						const taskBoardText = body.taskBoard
							? `\n\n## 当前 Task Board 状态\n\`\`\`json\n${String(body.taskBoard).slice(0, 4000)}\n\`\`\``
							: '';
						tempAgent.followup(createHandoffUserMessage(
							`${HANDOFF_ANALYZER_PROMPT}\n\n以下是本地预处理后的对话上下文（已过滤重复/噪音内容，约 ${preprocessed.estimatedTokens} tokens）：\n\n${preprocessed.text}${taskBoardText}`
						));
						await tempAgent.whenIdle();
						handoffText = lastAssistantText(tempAgent.session.events);
					} finally {
						if (tempHandle !== null && tempHandle !== void 0 && typeof tempHandle.dispose === 'function') {
							try { await tempHandle.dispose(); } catch { /* ignore */ }
						}
						// 清理临时 session 持久化，不留在会话列表
						try { removeTempSessionFiles(tempId); } catch { /* ignore */ }
					}
					if (!handoffText || handoffText.trim() === '') {
						return json(res, 500, { ok: false, error: '迁徙分析未产生结果（可能当前对话为空或分析失败）' });
					}

					// 3) 创建全新 Conversation（新 sessionId，meta.parentSession 标记来源）
					const newId = `session-${randomUUID()}`;
					let newHandle = null;
					try {
						newHandle = await agents.create({
							sessionId: newId,
							meta: { cwd, parentSession: sessionId },
							agentOptions
						});
						newHandle.agent.inject(createHandoffUserMessage(handoffText));
					} catch (error) {
						if (newHandle !== null && newHandle !== void 0 && typeof newHandle.dispose === 'function') {
							try { await newHandle.dispose(); } catch { /* ignore */ }
						}
						throw error;
					}
					json(res, 200, { ok: true, newSessionId: newId, estimatedTokens: preprocessed.estimatedTokens, droppedEvents: preprocessed.droppedEvents });
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
