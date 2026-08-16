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

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

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
		})
	];

	return () => {
		clearInterval(balanceTimer);
		for (const dispose of disposeRoutes) dispose();
	};
}
