window.__ModuleLoader__.load({
	id: 'my_better-dsh',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		let react = require('react');
		let { useEffect, useState, useRef, useCallback } = react;
		let { createElement: h } = react;

		// ── DeepSeek official pricing periods (Beijing time, from 2026-08-17) ──
		// Peak: 09:00–12:00 and 14:00–18:00 Beijing; everything else is idle
		// (idle = half of peak price).
		const PEAK_WINDOWS = [
			[9 * 3600, 12 * 3600],
			[14 * 3600, 18 * 3600]
		];

		/** Beijing wall-clock seconds since Beijing midnight, for "now". */
		function beijingSeconds() {
			const shifted = new Date(Date.now() + 8 * 3600 * 1000);
			return shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds();
		}

		/** 'peak' | 'idle' for the given Beijing seconds-of-day. */
		function periodOf(sec) {
			return PEAK_WINDOWS.some(([a, b]) => sec >= a && sec < b) ? 'peak' : 'idle';
		}

		/** Seconds until the next official period switch. */
		function secondsUntilSwitch(sec) {
			const next = [9 * 3600, 12 * 3600, 14 * 3600, 18 * 3600].find((boundary) => sec < boundary);
			return (next ?? (9 * 3600 + 24 * 3600)) - sec;
		}

		function pad(n) {
			return String(n).padStart(2, '0');
		}

		function fmtCountdown(sec) {
			const s = Math.max(0, Math.floor(sec));
			return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
		}

		// ══ Status bar below the composer ═════════════════════════════════════
		// The composer dock renders the official StatsLine (runtime figures:
		// turns/steps/LLM/tool/first-token/TPS) as its first row, then this
		// account/resource line as the SECOND row (balance/spend/period/context).
		// Row separation is done by injected CSS (see ensureDockLayoutCss) that
		// makes the dock wrap and forces this entry to a full row of its own —
		// we never re-implement the runtime stats the official line already shows.
		const DOCK_STYLE = {
			boxSizing: 'border-box',
			color: 'var(--dsw-alias-label-tertiary)',
			fontSize: '12px',
			fontVariantNumeric: 'tabular-nums',
			lineHeight: '18px',
			margin: '0 auto',
			maxWidth: 'var(--dsh-chat-content-width)',
			padding: '2px var(--dsh-composer-side-clearance) 0',
			width: '100%',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			gap: '8px',
			overflow: 'hidden'
		};
		const STAT_ITEM = {
			flex: '0 1 auto',
			minWidth: 0,
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			whiteSpace: 'nowrap'
		};
		const STAT_SEP = { flex: 'none', opacity: 0.55 };

		// ── dock 两行布局 ─────────────────────────────────────────────────────
		// The dock slot wrapper is normally `display: contents`; live-stats may
		// turn it into a horizontal flex row (flex-wrap: nowrap) that squeezes
		// every dock entry onto ONE line. We override the wrap to allow rows and
		// force this status entry (data-my-better-dsh-status) to a full-width
		// row, so the official StatsLine keeps its own line above us.
		let dockLayoutCssInjected = false;
		function ensureDockLayoutCss() {
			if (dockLayoutCssInjected || typeof document === 'undefined') return;
			dockLayoutCssInjected = true;
			if (document.querySelector('style[data-my-better-dsh-dock]') !== null) return;
			const style = document.createElement('style');
			style.dataset.myBetterDshDock = '';
			style.textContent = [
				'div[data-slot="conversation.composer.dock"] { flex-wrap: wrap !important; }',
				'div[data-slot="conversation.composer.dock"] > [data-my-better-dsh-status] {',
				'  flex: 0 0 100%;',
				'  max-width: 100%;',
				'  box-sizing: border-box;',
				'}',
				// 官方 StatsLine 完整显示：live-stats 会把它限到 620px + 省略号
				// （"缓存命中 x% | 输入… / 输出…" 末尾被截断），这里解除限制，
				// 必要时换行而非截断。官方行是 dock 的第一个子元素。
				'div[data-slot="conversation.composer.dock"] > :first-child {',
				'  max-width: none !important;',
				'  min-width: 0;',
				'  white-space: normal !important;',
				'  overflow: visible !important;',
				'  text-overflow: clip !important;',
				'}',
				'/* 对话大纲列表：始终可见的细滚动条（DSH 默认隐藏滚动条） */',
				'.my-better-dsh-outline-scroll { scrollbar-width: thin !important; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent !important; }',
				'.my-better-dsh-outline-scroll::-webkit-scrollbar { width: 8px !important; height: 8px !important; }',
				'.my-better-dsh-outline-scroll::-webkit-scrollbar-track { background: transparent !important; }',
				'.my-better-dsh-outline-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2) !important; border-radius: 4px !important; }',
				'.my-better-dsh-outline-scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2) !important; }'
			].join('\n');
			document.head.appendChild(style);
		}

		// ══ Current-conversation remaining context window ════════════════════
		// Two surfaces:
		//  - StatusBar (composer.dock, proven to render): appends the remaining
		//    context window to the account line.
		//  - ContextRemain (conversation.input.overlay): floating indicator while
		//    the input is empty+focused or the agent is replying.
		function fmtTokens(n) {
			if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
			if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
			return String(n);
		}

		/** Defensive projection read: returns {used, window} or null. */
		function readContextPressure(props) {
			try {
				const useProjection = typeof props.useProjection === 'function' ? props.useProjection : null;
				if (useProjection === null) return null;
				const pressure = useProjection('contextPressure');
				const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
				const window = pressure?.contextWindow;
				if (used === void 0 || window === void 0 || window <= 0) return null;
				return { used, window };
			} catch {
				return null;
			}
		}

		// ══ Security Mode 开关（host 侧 /api/security/mode，状态持久化）═══════
		// 设置页开关 / 左侧 ⋯ 菜单 / 状态栏共用：任一入口切换后通过 emitSecMode
		// 广播，所有入口与状态栏实时同步（避免各组件各自维护 state 不同步）。
		async function fetchSecurityMode() {
			try {
				const res = await fetch('/my-better-dsh/api/security/mode', { cache: 'no-store' });
				if (!res.ok) return null;
				const j = await res.json();
				return j !== null && typeof j === 'object' && j.ok === true ? j.mode : null;
			} catch {
				return null;
			}
		}
		async function postSecurityMode(mode) {
			try {
				const res = await fetch('/my-better-dsh/api/security/mode', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ mode })
				});
				if (!res.ok) return null;
				const j = await res.json();
				if (j !== null && typeof j === 'object' && j.ok === true) {
					emitSecMode(j.mode);
					return j.mode;
				}
				return null;
			} catch {
				return null;
			}
		}
		let sharedSecMode = null;
		const secModeSubs = new Set();
		function emitSecMode(mode) {
			sharedSecMode = mode;
			for (const cb of [...secModeSubs]) {
				try { cb(mode); } catch { /* ignore */ }
			}
		}
		function subscribeSecMode(cb) {
			secModeSubs.add(cb);
			return () => { secModeSubs.delete(cb); };
		}
		const secModeLabel = (mode) => mode === 'full-access-except-delete' ? '🟢 删除时确认' : mode === 'full-access' ? '🟢 完全访问' : null;
		const secModeNext = (mode) => mode === 'full-access-except-delete' ? 'full-access' : 'full-access-except-delete';

		const StatusBar = function StatusBar(props) {
			const [status, setStatus] = useState(null);
			const [secMode, setSecMode] = useState(null);
			const [, setTick] = useState(0);
			const pressure = readContextPressure(props);

			useEffect(() => {
				let alive = true;
				async function poll() {
					try {
						const res = await fetch('/my-better-dsh/api/status', { cache: 'no-store' });
						if (res.ok) {
							const json = await res.json();
							if (alive) setStatus(json);
						}
					} catch {
						/* keep the last snapshot */
					}
				}
				void poll();
				const timer = setInterval(() => void poll(), 60_000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);

			useEffect(() => {
				const timer = setInterval(() => setTick((v) => v + 1), 1000);
				return () => clearInterval(timer);
			}, []);

			const sec = beijingSeconds();
			const period = periodOf(sec);
			const remain = secondsUntilSwitch(sec);
			const periodLabel = period === 'peak' ? '高峰' : '空闲';
			const periodColor = period === 'peak' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)';

			const balanceText = status !== null && status.ok && status.balance !== null
				? `¥${Number(status.balance).toFixed(2)}`
				: '--';
			const spendText = status !== null && status.ok && status.spend !== null
				? `¥${Number(status.spend).toFixed(2)}`
				: '--';

			const ctxText = pressure !== null
				? `剩 ${fmtTokens(Math.max(0, pressure.window - pressure.used))}/${fmtTokens(pressure.window)}`
				: '--';
			const ctxColor = pressure !== null
				? (pressure.window - pressure.used) / pressure.window > 0.5 ? 'var(--dsw-alias-state-success-primary)' : (pressure.window - pressure.used) / pressure.window > 0.2 ? '#facc15' : 'var(--dsw-alias-state-error-primary)'
				: void 0;

			const cell = (text, key, extra) => h('span', { key, style: { ...STAT_ITEM, ...(extra ?? {}) }, title: text }, text);
			const sep = (key) => h('span', { key, style: STAT_SEP }, '|');
			const cells = [
				cell(`余额 ${balanceText}`, 'bal'),
				cell(`本次已消耗 ${spendText}`, 'spend'),
				cell(`${periodLabel} · 距切换 ${fmtCountdown(remain)}`, 'period', { color: periodColor }),
				cell(`上下文 ${ctxText}`, 'ctx', { color: ctxColor })
			];
			// Security Mode 显示标签（切换入口：左侧栏底部「全局设定」旁的独立开关）
			const secLabel = secModeLabel(secMode);
			if (secLabel !== null) {
				cells.push(cell(secLabel, 'sec', { color: 'var(--dsw-alias-state-success-primary)', cursor: 'default' }));
			}
			// Security Mode 显示：订阅共享状态，任一切换入口即时同步；常驻轮询兜底
			useEffect(() => {
				const unsub = subscribeSecMode(setSecMode);
				let alive = true;
				const sync = () => fetchSecurityMode().then((m) => { if (alive && m !== null) emitSecMode(m); }).catch(() => { /* keep */ });
				void sync();
				const timer = setInterval(sync, 30_000);
				return () => {
					alive = false;
					clearInterval(timer);
					unsub();
				};
			}, []);
			const row = [];
			cells.forEach((c, i) => {
				if (i > 0) row.push(sep(`s${i}`));
				row.push(c);
			});

			// ══ 对话迁徙（🚚）：分析当前对话 → Context Handoff → 新 Conversation ══
			// 只复用 DSH 自身 Agent/LLM Runtime（host 侧 /api/handoff），无外部 API。
			const HANDOFF_STAGE_TEXT = {
				analyzing: '正在分析当前对话……',
				extracting: '正在提取任务状态……',
				generating: '正在生成迁徙上下文……'
			};
			const [handoffState, setHandoffState] = useState(null);
			// busy 时轮换阶段提示
			useEffect(() => {
				if (handoffState === null || handoffState.busy !== true) return;
				const stages = ['analyzing', 'extracting', 'generating'];
				const timer = setInterval(() => {
					setHandoffState((prev) => {
						if (prev === null || prev.busy !== true) return prev;
						const idx = stages.indexOf(prev.stage);
						return { ...prev, stage: stages[(idx + 1) % stages.length] };
					});
				}, 1500);
				return () => clearInterval(timer);
			}, [handoffState !== null && handoffState.busy]);
			const runHandoff = () => {
				const sessionId = typeof props.getCurrentSession === 'function' ? props.getCurrentSession() : null;
				if (!sessionId) { setHandoffState({ busy: false, error: '无法确定当前会话' }); return; }
				if (handoffState !== null && handoffState.busy) return;
				setHandoffState({ busy: true, stage: 'analyzing' });
				let taskBoard = null;
				try { taskBoard = localStorage.getItem('dsh.taskBoard.v1'); } catch { /* ignore */ }
				fetch('/my-better-dsh/api/handoff', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId, taskBoard })
				}).then((r) => r.json()).then((data) => {
					if (data !== null && typeof data === 'object' && data.ok === true && data.newSessionId) {
						setHandoffState({ busy: false, done: true });
						if (typeof props.openSession === 'function') {
							try { props.openSession(data.newSessionId); } catch { /* ignore */ }
						}
						setTimeout(() => setHandoffState((prev) => (prev !== null && prev.done ? null : prev)), 5000);
					} else {
						setHandoffState({ busy: false, error: (data && data.error) || '未知错误' });
					}
				}).catch((e) => {
					setHandoffState({ busy: false, error: e instanceof Error ? e.message : String(e) });
				});
			};
			const migratedFrom = typeof props.getMigratedFrom === 'function' ? props.getMigratedFrom() : null;
			const hsBusy = handoffState !== null && handoffState.busy === true;
			const hsText = handoffState === null ? null
				: hsBusy ? (HANDOFF_STAGE_TEXT[handoffState.stage] || '正在分析当前对话……')
				: handoffState.done ? '✅ 迁徙完成'
				: handoffState.error ? '❌ 对话迁徙失败，原对话未受到影响。' : null;
			const smallBtn = (extra) => ({
				display: 'inline-flex', alignItems: 'center', gap: '4px', flex: 'none',
				border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', background: 'var(--dsw-alias-interactive-bg-hover)',
				color: 'var(--dsw-alias-label-primary)', fontSize: '11px', lineHeight: '18px', padding: '1px 8px', borderRadius: '6px',
				cursor: 'pointer', whiteSpace: 'nowrap', ...(extra ?? {})
			});

			return h('div', {
				'data-my-better-dsh-status': '',
				style: DOCK_STYLE,
				title: '余额/花费来自 DeepSeek 真实 API（60 秒刷新）；时段为官方峰谷定价（高峰 9-12、14-18 北京时间，空闲半价）；上下文为当前对话剩余窗口'
			},
				migratedFrom !== null && migratedFrom !== void 0 && h('span', {
					key: 'migrated',
					style: { ...STAT_ITEM, color: 'var(--dsw-alias-state-warning-primary)', cursor: 'default', fontWeight: 600 },
					title: '此对话由 Context Handoff 创建'
				}, '🚚 已从上一对话迁徙'),
				...row,
				hsText !== null && h('span', {
					key: 'hs',
					style: {
						...STAT_ITEM,
						...(handoffState !== null && handoffState.error ? { color: 'var(--dsw-alias-state-error-primary)' }
							: handoffState !== null && handoffState.done ? { color: 'var(--dsw-alias-state-success-primary)' } : {})
					}
				}, hsText),
				handoffState !== null && handoffState.error && h('button', { key: 'hretry', style: smallBtn(), onClick: () => void runHandoff() }, '重试'),
				h('button', {
					key: 'handoff',
					style: smallBtn(hsBusy ? { cursor: 'wait', opacity: 0.7 } : {}),
					title: '分析当前对话并生成 Context Handoff，创建新对话继续工作（原对话保持不变）',
					disabled: hsBusy,
					onClick: () => void runHandoff()
				}, '🚚 对话迁徙'));
		};

		const ContextRemain = function ContextRemain(props) {
			// Defensive: the standard kit (useProjection/useSession) may be absent
			// on some slot/version combos — never crash the composer overlay.
			const useProjection = typeof props.useProjection === 'function' ? props.useProjection : () => void 0;
			const useSession = typeof props.useSession === 'function' ? props.useSession : () => void 0;
			const pressure = useProjection('contextPressure');
			const snapshot = useSession();
			const ref = useRef(null);
			const [idleVisible, setIdleVisible] = useState(false);

			// Empty + focused input (cursor floating in the empty composer).
			// Robust textarea discovery: walk UP from the overlay to the nearest
			// ancestor containing a textarea (the overlay may be nested in
			// wrappers whose DOM shape differs between DSH versions).
			function findComposerTextarea(el) {
				let node = el;
				while (node !== null) {
					const ta = typeof node.querySelector === 'function' ? node.querySelector('textarea') : null;
					if (ta !== null) return ta;
					node = node.parentElement;
				}
				return null;
			}
			useEffect(() => {
				const timer = setInterval(() => {
					const el = ref.current;
					if (el === null) return;
					const ta = findComposerTextarea(el);
					const show = ta !== null && ta.value === '' && document.activeElement === ta;
					setIdleVisible(show);
				}, 400);
				return () => clearInterval(timer);
			}, []);

			// The agent is sending a message (its loop is running).
			const running = snapshot !== null && snapshot !== void 0 && snapshot.running === true;

			if (!idleVisible && !running) return null;

			const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
			const window = pressure?.contextWindow;
			if (used === void 0 || window === void 0 || window <= 0) return null;

			const remain = Math.max(0, window - used);
			const ratio = remain / window;
			const color = ratio > 0.5 ? '#4ade80' : ratio > 0.2 ? '#facc15' : '#f87171';
			const text = `${running ? '回复中 · ' : ''}剩 ${fmtTokens(remain)}/${fmtTokens(window)}`;

			return h('div', {
				ref,
				style: {
					position: 'absolute',
					top: '12px',
					right: '16px',
					fontSize: '13px',
					fontWeight: 600,
					fontVariantNumeric: 'tabular-nums',
					color,
					pointerEvents: 'none',
					zIndex: 5,
					textShadow: '0 1px 2px rgba(0,0,0,0.35)'
				},
				title: `当前对话剩余上下文窗口 ${fmtTokens(remain)} / ${fmtTokens(window)}（${Math.round(ratio * 100)}%）`
			}, text);
		};

		// ══ CHECKPOINTS tab (better-sidebar) ═════════════════════════════════
		const TAB = {
			row: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px', cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--dsw-alias-label-primary)', width: '100%', textAlign: 'left', fontSize: '13px' },
			rowHover: { background: 'var(--dsw-alias-interactive-bg-hover)' },
			meta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
			pre: { maxHeight: '280px', overflow: 'auto', background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '8px', padding: '8px', fontSize: '12px', lineHeight: '18px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--dsw-alias-label-secondary)' },
			btn: { border: 'none', borderRadius: '8px', padding: '6px 14px', fontSize: '13px', cursor: 'pointer' },
			btnDanger: { background: 'var(--dsw-alias-state-error-primary)', color: '#fff' },
			btnGhost: { background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)' },
			badge: { display: 'inline-block', padding: '1px 8px', borderRadius: '10px', fontSize: '11px', background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' }
		};

		const CheckpointsTab = function CheckpointsTab(props) {
			const [items, setItems] = useState(null);
			const [mode, setMode] = useState('none');
			const [gitRepo, setGitRepo] = useState(false);
			const [selectedId, setSelectedId] = useState(null);
			const [detail, setDetail] = useState(null);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState(null);
			const [confirmStep, setConfirmStep] = useState(0);
			const [restoring, setRestoring] = useState(false);
			const [message, setMessage] = useState(null);

			// Session-scoped cwd: checkpoint ops must target THIS session's
			// workspace, not the server default (multi-workspace correctness).
			const scopeCwd = props.scope && props.scope.cwd ? props.scope.cwd : null;
			const cwdQuery = scopeCwd ? `?cwd=${encodeURIComponent(scopeCwd)}` : '';

			const refresh = useCallback(async () => {
				try {
					const res = await fetch(`/my-better-dsh/api/checkpoints${cwdQuery}`, { cache: 'no-store' });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const data = await res.json();
					setItems(data.items ?? []);
					setMode(data.mode ?? 'none');
					setGitRepo(!!data.gitRepo);
					setError(null);
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			}, [scopeCwd]);

			useEffect(() => {
				void refresh();
			}, [refresh, props.visible]);

			async function openDetail(item) {
				setSelectedId(item.id);
				setDetail(null);
				setConfirmStep(0);
				try {
					const res = await fetch(`/my-better-dsh/api/checkpoint/diff${cwdQuery ? `${cwdQuery}&` : '?'}id=${encodeURIComponent(item.id)}`, { cache: 'no-store' });
					const data = await res.json();
					setDetail(data);
				} catch (e) {
					setDetail({ ok: false, error: String(e) });
				}
			}

			async function doRestore() {
				setRestoring(true);
				try {
					const res = await fetch('/my-better-dsh/api/checkpoint/restore', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(scopeCwd ? { id: selectedId, cwd: scopeCwd } : { id: selectedId })
					});
					const data = await res.json();
					setMessage(data.ok ? '已恢复 ✓' : `恢复失败：${data.error || '未知错误'}`);
					setConfirmStep(0);
					setDetail(null);
					setSelectedId(null);
					await refresh();
				} catch (e) {
					setMessage(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
				} finally {
					setRestoring(false);
				}
			}

			const title = (items?.length ?? 0) > 0
				? 'CHECKPOINTS'
				: items === null ? 'CHECKPOINTS' : 'CHECKPOINTS（空）';

			return h('div', { style: { padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } },
				h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
					h('span', { style: { fontWeight: 600, fontSize: '13px', letterSpacing: '0.5px' } }, title),
					h('span', { style: TAB.badge },
						mode === 'git' ? 'Git 快照' : mode === 'fs' ? '文件快照' : '未就绪')
				),
				mode === 'fs' && h('div', { style: { ...TAB.meta, background: 'var(--dsw-alias-interactive-bg-hover)', borderRadius: '8px', padding: '6px 8px' } },
					'非 Git 项目：使用文件复制快照（不初始化 Git）。恢复会覆盖快照中的文件。'),
				error !== null && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } }, `检查点接口不可用：${error}`),
				message !== null && h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' } }, message),

				h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
					(items ?? []).map((item, index) => {
						const num = (items?.length ?? 0) - index;
						const selected = item.id === selectedId;
						return h('button', {
							key: item.id,
							style: { ...TAB.row, ...(selected ? TAB.rowHover : {}) },
							onClick: () => void openDetail(item)
						},
							h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' } }, `#${num}`),
							h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
							h('span', { style: TAB.meta }, item.files?.length ?? 0)
						);
					})
				),

				selectedId !== null && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
					h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
						h('span', { style: { fontWeight: 600 } }, 'Files Changed'),
						h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
							((items ?? []).find((it) => it.id === selectedId)?.files ?? []).map((f) =>
								h('span', { key: f, style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } }, `· ${f}`))
						)
					),
					h('span', { style: { fontWeight: 600 } }, 'Diff'),
					detail !== null && detail.ok && h('div', {
						style: TAB.pre
					}, detail.text || '（无差异）'),
					detail !== null && !detail.ok && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, detail.error || '加载失败'),

					h('button', {
						style: { ...TAB.btn, ...TAB.btnDanger },
						onClick: () => setConfirmStep(1)
					}, '恢复到此快照')
				),

				confirmStep > 0 && h('div', {
					style: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }
				}, h('div', {
					style: { background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '12px', padding: '16px 18px', maxWidth: '360px', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }
				},
					h('div', { style: { fontWeight: 600 } }, confirmStep === 1 ? '恢复到此快照？' : '再次确认恢复'),
					h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '18px' } },
						confirmStep === 1
							? '将把项目恢复到该检查点记录的状态。此操作不可撤销，请确认。'
							: '再次确认：将丢弃该检查点之后的所有更改，并重置工作区。'),
					h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
						h('button', { style: { ...TAB.btn, ...TAB.btnGhost }, onClick: () => setConfirmStep(0) }, '取消'),
						confirmStep === 1
							? h('button', { style: { ...TAB.btn, ...TAB.btnDanger }, onClick: () => setConfirmStep(2) }, '下一步')
							: h('button', {
								style: { ...TAB.btn, ...TAB.btnDanger },
								disabled: restoring,
								onClick: () => void doRestore()
							}, restoring ? '恢复中…' : '确认恢复')
					)
				))
			);
		};

		// ══ 全局设定 tab（~/.dsh/AGENTS.md — CLAUDE.md 风格，所有会话生效）══════
		// Edits DSH's user-global instruction file. dsh-agent-instructions loads
		// it into EVERY session as the broadest baseline; project-level
		// AGENTS.md / CLAUDE.md take precedence over it.
		const GS_DRAFT_KEY = 'my-better-dsh.globalSettings.draft';
		const GS_EDITOR_STYLE = {
			boxSizing: 'border-box', width: '100%', minHeight: '260px', flex: 1, resize: 'vertical',
			background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)',
			borderRadius: '8px', padding: '8px 10px', fontSize: '12px', lineHeight: '18px',
			fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--dsw-alias-label-primary)'
		};

		// ══ 安全模式独立开关（Security Mode Switch）══════════════════════════
		// 独立成设置控件（全局设定页/其它入口可复用）：订阅共享状态实时同步，
		// 点击滑块切换 full-access-except-delete ⇄ full-access（host 持久化）。
		const SecurityModeSwitch = function SecurityModeSwitch(props) {
			const [secMode, setSecMode] = useState(sharedSecMode);
			useEffect(() => {
				const unsub = subscribeSecMode(setSecMode);
				let alive = true;
				if (sharedSecMode === null) {
					fetchSecurityMode().then((m) => { if (alive && m !== null) emitSecMode(m); }).catch(() => { /* keep */ });
				}
				return () => {
					alive = false;
					unsub();
				};
			}, []);
			const on = secMode === 'full-access-except-delete';
			const toggle = () => {
				postSecurityMode(secModeNext(secMode)).then((m) => { if (m !== null) emitSecMode(m); }).catch(() => { /* keep */ });
			};
			return h('button', {
				style: {
					display: 'inline-flex', alignItems: 'center', gap: '8px', flex: 'none', cursor: 'pointer',
					background: 'transparent', border: 'none', padding: 0,
					...(props.style ?? {})
				},
				role: 'switch',
				'aria-checked': on,
				title: on ? '安全模式：删除文件时询问（点击切换为「完全访问」）' : '安全模式：完全访问（点击切换为「删除文件时询问」）',
				onClick: () => toggle()
			},
				h('span', {
					style: {
						width: '34px', height: '18px', borderRadius: '9px', flex: 'none', position: 'relative', display: 'inline-block',
						background: on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-interactive-bg-hover)',
						transition: 'background .15s'
					}
				}, h('span', {
					style: {
						position: 'absolute', top: '2px', left: on ? '18px' : '2px',
						width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
						transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,0.3)'
					}
				})),
				h('span', { style: { fontSize: props.labelSize ?? '12px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' } },
					secModeLabel(secMode) ?? '安全模式'));
		};

		const GlobalSettingsTab = function GlobalSettingsTab(props) {
			const [info, setInfo] = useState(null);
			const [draft, setDraft] = useState(null);
			const [dirty, setDirty] = useState(false);
			const [saving, setSaving] = useState(false);
			const [savedAt, setSavedAt] = useState(null);
			const [error, setError] = useState(null);
			const [notice, setNotice] = useState(null);
			const [confirmReset, setConfirmReset] = useState(false);
			const [busy, setBusy] = useState(false);
			const compact = props.compact === true;

			const refresh = useCallback(async () => {
				try {
					const res = await fetch('/my-better-dsh/api/global-settings', { cache: 'no-store' });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const data = await res.json();
					if (!data.ok) throw new Error(data.error || '读取失败');
					setInfo(data);
					setError(null);
					// Restore an unsaved draft (survives tab switches / refreshes).
					let draft = null;
					try {
						draft = localStorage.getItem(GS_DRAFT_KEY);
					} catch {
						/* ignore */
					}
					if (draft !== null) {
						setDraft(draft);
						setDirty(true);
					} else {
						setDraft(data.exists ? data.content : (data.template || ''));
						setDirty(false);
					}
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			}, []);

			useEffect(() => {
				void refresh();
			}, [refresh, props.visible]);

			// Persist unsaved edits so switching tabs never loses them.
			useEffect(() => {
				if (dirty && typeof draft === 'string') {
					try {
						localStorage.setItem(GS_DRAFT_KEY, draft);
					} catch {
						/* ignore */
					}
				}
			}, [dirty, draft]);

			async function doSave() {
				if (draft === null) return;
				setSaving(true);
				setNotice(null);
				setError(null);
				try {
					const res = await fetch('/my-better-dsh/api/global-settings', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ content: draft })
					});
					const data = await res.json();
					if (data.ok) {
						setInfo(data);
						setDirty(false);
						setSavedAt(Date.now());
						try {
							localStorage.removeItem(GS_DRAFT_KEY);
						} catch {
							/* ignore */
						}
						// Return to the previous page immediately (no notice, no wait):
						// left sidebar → onClose switches back to the previous mode;
						// better-sidebar tab → close the tab.
						try {
							if (typeof props.onClose === 'function') {
								props.onClose();
							} else {
								const bs = props.ctx && props.ctx.betterSidebar;
								if (bs && props.tab) bs.closeTab(props.tab.id, props.scope);
							}
						} catch {
							/* ignore */
						}
					} else {
						setError(data.error || '保存失败');
					}
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setSaving(false);
				}
			}

			async function doReset() {
				setBusy(true);
				setNotice(null);
				setError(null);
				try {
					const res = await fetch('/my-better-dsh/api/global-settings/reset', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: '{}'
					});
					const data = await res.json();
					if (data.ok) {
						setInfo(data);
						setDraft(data.template || data.content || '');
						setDirty(false);
						setSavedAt(Date.now());
						setNotice('已恢复模板 ✓');
						try {
							localStorage.removeItem(GS_DRAFT_KEY);
						} catch {
							/* ignore */
						}
					} else {
						setError(data.error || '恢复失败');
					}
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setBusy(false);
					setConfirmReset(false);
				}
			}

			function copyPath() {
				if (info === null || info.display === null) return;
				try {
					if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
						void navigator.clipboard.writeText(info.display);
						setNotice('路径已复制 ✓');
					}
				} catch {
					/* ignore */
				}
			}

			const bytes = typeof draft === 'string' ? new TextEncoder().encode(draft).length : 0;
			const maxBytes = info !== null && info.maxBytes ? info.maxBytes : 1024 * 1024;
			const overLimit = bytes > maxBytes;
			const savedText = savedAt !== null
				? new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false })
				: null;

			return h('div', { style: { padding: compact ? '8px 6px' : '12px 10px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)', minHeight: 0, ...(compact ? { flex: 1 } : {}) } },
				h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
					h('span', { style: { fontWeight: 600, fontSize: '13px', letterSpacing: '0.5px' } }, '全局设定'),
					h('span', { style: { ...TAB.badge, ...(info !== null && info.active ? { background: 'var(--dsw-alias-state-success-primary)', color: '#fff' } : {}) } },
						info !== null ? (info.active ? (compact ? '生效中' : '对所有会话生效') : '未创建') : '读取中…')),
				h('div', { style: { ...TAB.meta, background: 'var(--dsw-alias-interactive-bg-hover)', borderRadius: '8px', padding: '6px 8px', lineHeight: '18px' } },
					'编辑 ', h('strong', null, info !== null ? info.display : '~/.dsh/AGENTS.md'),
					compact ? '（所有会话生效；项目内 AGENTS.md / CLAUDE.md 优先级更高）' : '（DSH 的用户级指令文件，模仿 CLAUDE.md）：所有会话启动时自动载入；项目目录下的 AGENTS.md / CLAUDE.md 优先级更高。'),
				error !== null && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } }, `接口不可用：${error}`),
				notice !== null && h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' } }, notice),

				h('textarea', {
					style: { ...GS_EDITOR_STYLE, minHeight: compact ? '150px' : '260px' },
					value: draft === null ? '' : draft,
					spellCheck: false,
					placeholder: '在此编写对所有会话生效的设定（Markdown）…',
					onChange: (e) => { setDraft(e.target.value); setDirty(true); setNotice(null); }
				}),

				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } },
					h('span', { style: { color: overLimit ? 'var(--dsw-alias-state-error-primary)' : void 0 } }, `${bytes.toLocaleString()} / ${Math.round(maxBytes / 1024)}KB`),
					dirty && h('span', { style: { color: 'var(--dsw-alias-state-warning-primary)', fontWeight: 600 } }, '未保存'),
					savedText !== null && h('span', null, `上次保存 ${savedText}`),
					h('span', { style: { flex: 1 } }),
					!compact && h('button', { style: { ...TAB.btn, ...TAB.btnGhost }, onClick: copyPath }, '复制路径'),
					h('button', {
						style: { ...TAB.btn, ...TAB.btnGhost },
						onClick: () => setConfirmReset(true)
					}, '恢复模板'),
					h('button', {
						style: { ...TAB.btn, ...(dirty ? { background: 'var(--dsw-alias-state-success-primary)', color: '#fff' } : TAB.btnGhost) },
						disabled: saving || draft === null,
						onClick: () => void doSave()
					}, saving ? '保存中…' : '保存')),

				confirmReset && h('div', {
					style: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }
				}, h('div', {
					style: { background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '12px', padding: '16px 18px', maxWidth: '340px', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }
				},
					h('div', { style: { fontWeight: 600 } }, '恢复默认模板？'),
					h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '18px' } },
						'将用内置示例模板覆盖 ~/.dsh/AGENTS.md 的全部内容，当前内容不可恢复。'),
					h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
						h('button', { style: { ...TAB.btn, ...TAB.btnGhost }, onClick: () => setConfirmReset(false) }, '取消'),
						h('button', { style: { ...TAB.btn, ...TAB.btnDanger }, disabled: busy, onClick: () => void doReset() }, busy ? '恢复中…' : '确认恢复'))))
			);
		};

		// ══ Diff Review tab（Agent 实时改动高亮，实时跟随）══════════════════════
		// A module-level feed polls /my-better-dsh/api/diff-review while the
		// plugin is active (not only while the tab is open), so the right side
		// reacts in real time: the first change of a workspace auto-opens the
		// Diff Review tab, later changes flash + scroll-follow, and the tab
		// badge shows the unread count.
		const DIFF_POLL_MS = 1500;
		const diffFeed = {
			cwd: null,
			entries: [],
			unread: 0,
			lastSeq: 0,
			lastFlash: null,
			_autoOpened: new Set(),
			_listeners: new Set()
		};
		function diffSubscribe(fn) {
			diffFeed._listeners.add(fn);
			return () => { diffFeed._listeners.delete(fn); };
		}
		function diffEmit() {
			for (const fn of [...diffFeed._listeners]) {
				try { fn(); } catch { /* ignore */ }
			}
		}
		const DIFF_STYLE = {
			del: { background: 'rgba(248,113,113,0.18)', color: '#fca5a5' },
			add: { background: 'rgba(74,222,128,0.18)', color: '#86efac' },
			ctx: { color: 'var(--dsw-alias-label-secondary)' },
			hunk: { color: 'var(--dsw-alias-label-tertiary)', background: 'rgba(96,165,250,0.14)' }
		};

		const ChangeCard = function ChangeCard(props) {
			const { entry, flash, collapsed } = props;
			const [open, setOpen] = useState(collapsed !== true);
			useEffect(() => {
				if (collapsed === true) setOpen(false);
			}, [collapsed]);
			const toolLabel = entry.tool === 'write' ? '写入'
				: entry.tool === 'edit' || entry.tool === 'str_replace_editor' ? '编辑'
				: entry.tool;
			return h('div', { style: { border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '8px', overflow: 'hidden', ...(flash ? { background: 'rgba(250,204,21,0.16)', boxShadow: '0 0 0 1px rgba(250,204,21,0.55)' } : {}) } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', background: 'var(--dsw-alias-interactive-bg-hover)', fontSize: '12px', cursor: 'pointer' }, onClick: () => setOpen((v) => !v), title: open ? '收起' : '展开' },
					h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px', flex: 'none' } }, open ? '▾' : '▸'),
					h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: entry.file }, entry.file),
					h('span', { style: TAB.meta }, toolLabel),
					h('span', { style: { flex: 1 } }),
					entry.newFile && h('span', { style: { ...TAB.badge, color: 'var(--dsw-alias-state-success-primary)' } }, '新增'),
					h('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontVariantNumeric: 'tabular-nums' } }, `+${entry.added}`),
					h('span', { style: { color: 'var(--dsw-alias-state-error-primary)', fontVariantNumeric: 'tabular-nums' } }, `−${entry.removed}`),
					h('span', { style: TAB.meta }, entry.time)),
				open && h('div', { style: { padding: '4px 0 6px' } },
					(entry.hunks || []).map((hunk, hi) => h('div', { key: hi },
						h('div', { style: { ...DIFF_STYLE.hunk, padding: '1px 8px', fontSize: '11px', fontFamily: 'ui-monospace, Consolas, monospace' } },
							`@@ -${hunk.aStart},${hunk.aCount} +${hunk.bStart},${hunk.bCount} @@`),
						h('div', null, hunk.lines.map((op, li) => h('div', {
							key: li,
							style: { display: 'flex', padding: '0 8px 0 4px', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderRadius: '3px', ...(op.t === 'add' ? DIFF_STYLE.add : op.t === 'del' ? DIFF_STYLE.del : DIFF_STYLE.ctx) }
							}, `${op.t === "add" ? "+" : op.t === "del" ? "-" : " "} ${op.x}`))))),
					entry.truncated && h('div', { style: { ...TAB.meta, padding: '2px 8px' } }, '（diff 过长，已截断）')));
		};

					const DiffReviewTab = function DiffReviewTab(props) {
				const [view, setView] = useState(() => ({ entries: diffFeed.entries, unread: diffFeed.unread, lastFlash: diffFeed.lastFlash }));
				const [follow, setFollow] = useState(() => {
					try {
						return localStorage.getItem('my-better-dsh.diffFollow') !== '0';
					} catch {
						return true;
					}
				});
				const listRef = useRef(null);

				// Render from the module-level feed; the apply-level poller keeps it
				// fresh whether or not this tab is open.
				useEffect(() => diffSubscribe(() => {
					setView({ entries: diffFeed.entries, unread: diffFeed.unread, lastFlash: diffFeed.lastFlash });
				}), []);

				useEffect(() => {
					try {
						localStorage.setItem('my-better-dsh.diffFollow', follow ? '1' : '0');
					} catch {
						/* ignore */
					}
				}, [follow]);

				// While the panel is visible, incoming changes are "read": clears the
				// badge and pokes the tab bar (updateTab) so it re-renders live.
				useEffect(() => {
					if (props.visible && diffFeed.unread > 0) {
						diffFeed.unread = 0;
						setView((v) => ({ ...v, unread: 0 }));
						try {
							const bs = props.ctx && props.ctx.betterSidebar;
							if (bs) bs.updateTab(props.tab ? props.tab.id : 'diff-review', { meta: Date.now() });
						} catch {
							/* ignore */
						}
					}
				}, [props.visible, view.entries.length]);

				// Clear the flash highlight after a short beat.
				useEffect(() => {
					if (view.lastFlash === null) return;
					const t = window.setTimeout(() => {
						diffFeed.lastFlash = null;
						setView((v) => ({ ...v, lastFlash: null }));
					}, 2500);
					return () => clearTimeout(t);
				}, [view.lastFlash]);

				// Auto-follow: scroll the newest change into view.
				useEffect(() => {
					if (follow && view.lastFlash !== null && listRef.current !== null) {
						listRef.current.scrollTop = 0;
					}
				}, [view.lastFlash, follow]);

				const entries = view.entries;
				const unread = view.unread;
				const flashSeq = view.lastFlash;

				return h('div', { style: { padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)', minHeight: 0, flex: 1 } },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
						h('span', { style: { fontWeight: 600, fontSize: '13px', letterSpacing: '0.5px' } }, 'Diff Review'),
						entries.length > 0 && h('span', { style: TAB.meta }, `${entries.length} 条`),
						h('span', { style: { flex: 1 } }),
						unread > 0 && h('span', { style: { ...TAB.badge, background: 'var(--dsw-alias-state-warning-primary)', color: '#fff' } }, `+${unread}`),
						h('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' } },
							h('input', { type: 'checkbox', checked: follow, onChange: (e) => setFollow(e.target.checked) }),
							'实时跟随')),
					entries.length === 0 && h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', padding: '24px 8px', lineHeight: '20px', whiteSpace: 'pre-line' } },
						'暂无改动\nAgent 修改文件后会实时显示在这里'),
					h('div', { ref: listRef, style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' } },
						entries.map((e, idx) => h(ChangeCard, { key: e.seq, entry: e, flash: e.seq === flashSeq, collapsed: idx >= 2 }))));
			};

		// 'betterSidebar' via cordis inject: guarantees better-sidebar's client
		// apply (which provides the service) ran before ours — the tab registers
		// reliably, unlike a ctx.get at apply time.
		// ══ Left sidebar: Files / Sessions (VSCode three-column style) ════════
		// Shadows the default `sidebar.workspaces` region with a two-mode view:
		//  - 文件: lazy file tree of the active workspace (host /api/fs/tree)
		//  - 会话: session list (unchanged rows: title + running/current dot)
		const LEFT_TAB = {
			flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
			padding: '6px 0', borderRadius: '8px', cursor: 'pointer', border: 'none',
			background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px'
		};
		const LEFT_TAB_ACTIVE = {
			background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600
		};
		const LEFT_ROW = (depth) => ({
			display: 'flex', alignItems: 'center', gap: '5px', width: '100%',
			padding: '3px 6px 3px', paddingLeft: `${6 + depth * 14}px`, borderRadius: '6px',
			border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)',
			cursor: 'pointer', textAlign: 'left', fontSize: '13px', whiteSpace: 'nowrap'
		});

		// ── ⋯ row menu (more) helpers ──
		const MENU_ITEM = {
			display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
			border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: '6px',
			color: 'var(--dsw-alias-label-primary)', fontSize: '13px', whiteSpace: 'nowrap'
		};
		const CONFIRM_OVERLAY = {
			position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)',
			display: 'flex', alignItems: 'center', justifyContent: 'center'
		};
		const CONFIRM_BOX = {
			background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)',
			borderRadius: '12px', padding: '16px 18px', maxWidth: '320px', display: 'flex',
			flexDirection: 'column', gap: '12px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)'
		};

		/** Dropdown under a ⋯ button (the button itself is rendered by the caller). */
		const MoreMenu = function MoreMenu(props) {
			return h('div', {
				style: {
					position: 'absolute', right: '2px', top: '100%', zIndex: 200, minWidth: '120px',
					background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)',
					borderRadius: '8px', boxShadow: '0 6px 24px rgba(0,0,0,0.25)', padding: '4px',
					display: 'flex', flexDirection: 'column'
				}
			}, (props.items || []).map((item) => h('button', {
				key: item.label,
				style: { ...MENU_ITEM, ...(item.danger ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) },
				onClick: () => {
					if (typeof props.onClose === 'function') props.onClose();
					if (typeof item.onClick === 'function') item.onClick();
				}
			}, item.label)));
		};

		/** Two-button confirm dialog. */
		const ConfirmDialog = function ConfirmDialog(props) {
			return h('div', { style: CONFIRM_OVERLAY },
				h('div', { style: CONFIRM_BOX },
					h('div', { style: { fontWeight: 600 } }, props.title || '确认'),
					h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '18px' } }, props.text || ''),
					h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
						h('button', {
							style: { ...MENU_ITEM, width: 'auto', background: 'var(--dsw-alias-interactive-bg-hover)' },
							onClick: props.onCancel
						}, '取消'),
						h('button', {
							style: { ...MENU_ITEM, width: 'auto', color: '#fff', background: 'var(--dsw-alias-state-error-primary)' },
							onClick: props.onConfirm
						}, props.confirmLabel || '确认'))));
		};

		const FileTree = function FileTree(props) {
			const { cwd, pins, onTogglePin, onOpenFile } = props;
			const [expanded, setExpanded] = useState({});
			const [error, setError] = useState(null);
			const [loadedRoot, setLoadedRoot] = useState(false);
			const [menuFor, setMenuFor] = useState(null);
			const [confirmDelete, setConfirmDelete] = useState(null); // {rel, isDir}
			const [busy, setBusy] = useState(false);

			const pinnedSet = new Set((pins && pins.files && pins.files[cwd]) || []);
			const isPinned = (rel) => pinnedSet.has(rel);

			async function loadDir(rel) {
				try {
					const qs = `rel=${encodeURIComponent(rel)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`;
					const res = await fetch(`/my-better-dsh/api/fs/tree?${qs}`, { cache: 'no-store' });
					const data = await res.json();
					if (data.ok) {
						setExpanded((prev) => ({ ...prev, [rel]: data }));
						setError(null);
					} else {
						setError(data.error || 'load failed');
					}
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			}

			useEffect(() => {
				if (!loadedRoot) {
					setLoadedRoot(true);
					void loadDir('');
				}
			}, [loadedRoot]);

			async function doDelete() {
				if (confirmDelete === null) return;
				setBusy(true);
				try {
					const res = await fetch('/my-better-dsh/api/fs/delete', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ cwd, rel: confirmDelete.rel })
					});
					const data = await res.json();
					if (data.ok) {
						const parent = confirmDelete.rel.includes('/')
							? confirmDelete.rel.split('/').slice(0, -1).join('/')
							: '';
						setExpanded((prev) => {
							const next = { ...prev };
							delete next[confirmDelete.rel];
							delete next[parent];
							return next;
						});
						if (parent === '') void loadDir('');
						else void loadDir(parent);
					} else {
						setError(data.error || '删除失败');
					}
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setBusy(false);
					setConfirmDelete(null);
				}
			}

			function copyPath(rel) {
				try {
					if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
						void navigator.clipboard.writeText(rel);
					}
				} catch {
					/* ignore */
				}
			}

			function renderChildren(node, parentRel, depth) {
				const parts = [];
				const dirs = [...node.dirs].sort((a, b) => (isPinned(`${parentRel === '' ? a : `${parentRel}/${a}`}`) ? -1 : 0) - (isPinned(`${parentRel === '' ? b : `${parentRel}/${b}`}`) ? -1 : 0) || a.localeCompare(b));
				const files = [...node.files].sort((a, b) => (isPinned(`${parentRel === '' ? a.name : `${parentRel}/${a.name}`}`) ? -1 : 0) - (isPinned(`${parentRel === '' ? b.name : `${parentRel}/${b.name}`}`) ? -1 : 0) || a.name.localeCompare(b.name));
				for (const d of dirs) {
					const rel = parentRel === '' ? d : `${parentRel}/${d}`;
					parts.push(renderDir(rel, d, depth));
				}
				for (const f of files) {
					const rel = parentRel === '' ? f.name : `${parentRel}/${f.name}`;
					parts.push(h('div', { key: `f:${rel}`, style: { position: 'relative' } },
						h('button', {
							style: { ...LEFT_ROW(depth), paddingRight: '22px' },
							title: rel,
							onClick: () => onOpenFile(rel)
						}, h('span', { style: { flex: 'none' } }, isPinned(rel) ? '📌' : '📄'),
							h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, f.name)),
						h('button', {
							style: { position: 'absolute', right: '2px', top: '2px', width: '20px', height: '20px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', borderRadius: '4px' },
							onClick: (e) => { e.stopPropagation(); setMenuFor(menuFor === rel ? null : rel); }
						}, '⋯'),
						menuFor === rel && h(MoreMenu, {
							onClose: () => setMenuFor(null),
							items: [
								{ label: isPinned(rel) ? '取消置顶' : '置顶', onClick: () => onTogglePin(rel) },
								{ label: '复制路径', onClick: () => copyPath(rel) },
								{ label: '删除', danger: true, onClick: () => setConfirmDelete({ rel, isDir: false }) }
							]
						})));
				}
				return parts;
			}

			function renderDir(rel, name, depth) {
				const node = expanded[rel];
				const isOpen = node !== void 0;
				return h('div', { key: `d:${rel}` },
					h('div', { style: { position: 'relative' } },
						h('button', {
							style: { ...LEFT_ROW(depth), paddingRight: '22px' },
							title: rel,
							onClick: () => {
								if (isOpen) {
									setExpanded((prev) => {
										const next = { ...prev };
										delete next[rel];
										return next;
									});
								} else {
									void loadDir(rel);
								}
							}
						},
							h('span', { style: { flex: 'none', width: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, isOpen ? '▾' : '▸'),
							h('span', { style: { flex: 'none' } }, isPinned(rel) ? '📌' : '📁'),
							h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, name)),
						h('button', {
							style: { position: 'absolute', right: '2px', top: '2px', width: '20px', height: '20px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', borderRadius: '4px' },
							onClick: (e) => { e.stopPropagation(); setMenuFor(menuFor === rel ? null : rel); }
						}, '⋯'),
						menuFor === rel && h(MoreMenu, {
							onClose: () => setMenuFor(null),
							items: [
								{ label: isPinned(rel) ? '取消置顶' : '置顶', onClick: () => onTogglePin(rel) },
								{ label: '复制路径', onClick: () => copyPath(rel) },
								{ label: '删除', danger: true, onClick: () => setConfirmDelete({ rel, isDir: true }) }
							]
						})),
					isOpen && h('div', null, ...renderChildren(node, rel, depth + 1)));
			}

			const root = expanded[''];
			return h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 2px', fontSize: '13px' } },
				error !== null && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', padding: '8px' } }, error),
				root !== void 0 && renderChildren(root, '', 0),
				root === void 0 && error === null && h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', padding: '12px', textAlign: 'center' } }, '加载中…'),
				confirmDelete !== null && h(ConfirmDialog, {
					title: confirmDelete.isDir ? '删除目录？' : '删除文件？',
					text: `将永久删除「${confirmDelete.rel}」，此操作不可撤销。`,
					confirmLabel: busy ? '删除中…' : '确认删除',
					onCancel: () => setConfirmDelete(null),
					onConfirm: () => void doDelete()
				}));
		};

		const SessionList = function SessionList(props) {
			const { sessions, openSession, archiveSession, pins, onTogglePin, archivedSessionIds } = props;
			const byId = sessions !== null && sessions !== void 0 && sessions.byId ? sessions.byId : {};
			const ids = sessions !== null && sessions !== void 0 && Array.isArray(sessions.ids) ? sessions.ids : [];
			const archived = archivedSessionIds instanceof Set ? archivedSessionIds : new Set();
			// 隐藏内部临时会话（对话迁徙的分析 agent），不污染会话列表
			const rows = ids.map((id) => byId[id]).filter((s) => s !== void 0 && !s.blank && !archived.has(s.id) && !String(s.id).startsWith('handoff-'));
			const pinnedSet = new Set((pins && pins.sessions) || []);
			const sorted = [...rows].sort((a, b) => (pinnedSet.has(b.id) ? 1 : 0) - (pinnedSet.has(a.id) ? 1 : 0));
			const [menuFor, setMenuFor] = useState(null);
			const [confirmDelete, setConfirmDelete] = useState(null);
			const [busy, setBusy] = useState(false);

			return h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 2px', fontSize: '13px' } },
				sorted.length === 0 && h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', padding: '16px 0' } }, '暂无会话'),
				sorted.map((s) => {
					const active = s.id === sessions.current;
					const pinned = pinnedSet.has(s.id);
					return h('div', { key: s.id, style: { position: 'relative' } },
						h('button', {
							style: {
								display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
								padding: '7px 8px', paddingRight: '26px', borderRadius: '8px', border: 'none', cursor: 'pointer',
								textAlign: 'left', background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
								color: 'var(--dsw-alias-label-primary)', fontSize: '13px'
							},
							onClick: () => openSession(s.id)
						},
							h('span', { style: { flex: 'none' } }, pinned ? '📌' : '💬'),
							h('span', {
								style: {
									width: '8px', height: '8px', borderRadius: '50%', flex: 'none',
									background: s.running ? 'var(--dsw-alias-state-success-primary)'
										: s.pendingInteraction ? 'var(--dsw-alias-state-warning-primary)'
										: s.completed ? '#4ade80' : 'var(--dsw-alias-border-l2)'
								}
							}),
							h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.displayTitle || s.id)),
						h('button', {
							style: { position: 'absolute', right: '4px', top: '7px', width: '20px', height: '20px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', borderRadius: '4px' },
							onClick: (e) => { e.stopPropagation(); setMenuFor(menuFor === s.id ? null : s.id); }
						}, '⋯'),
						menuFor === s.id && h(MoreMenu, {
							onClose: () => setMenuFor(null),
							items: [
								{ label: pinned ? '取消置顶' : '置顶', onClick: () => onTogglePin(s.id) },
								{ label: '删除', danger: true, onClick: () => setConfirmDelete(s.id) }
							]
						}));
				}),
				confirmDelete !== null && h(ConfirmDialog, {
					title: '删除会话？',
					text: '将归档该会话（从列表中隐藏，不删除对话记录）。',
					confirmLabel: busy ? '删除中…' : '确认删除',
					onCancel: () => setConfirmDelete(null),
					onConfirm: () => {
						setBusy(true);
						try {
							archiveSession(confirmDelete);
						} catch {
							/* ignore */
						}
						setBusy(false);
						setConfirmDelete(null);
					}
				}));
		};

		// Internal error boundary: if the sidebar content throws during React's
		// render, catch it HERE (before the slot renderer's outer boundary which
		// would abdicate our entry and silently fall back to the default view),
		// report the error to the host diag log and show a visible placeholder.
		class LeftBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			componentDidCatch(error, info) {
				try {
					const stack = error instanceof Error && error.stack ? error.stack : String(error);
					const compStack = info && typeof info.componentStack === 'string' ? info.componentStack : '';
					diag('left-render-error', `${stack}${compStack ? `\n---componentStack---\n${compStack}` : ''}`);
				} catch {
					/* ignore */
				}
			}
			render() {
				if (this.state.error !== null) {
					return h('div', { style: { padding: '10px 8px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' } },
						`左侧栏渲染错误：${this.state.error instanceof Error ? this.state.error.message : String(this.state.error)}`);
				}
				return this.props.children;
			}
		}

		const LeftSidebarInner = function LeftSidebarInner(props) {
			const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => null;
			const openSession = typeof props.openSession === 'function' ? props.openSession : () => {};
			const openFile = typeof props.openFile === 'function' ? props.openFile : () => {};
			const archiveSession = typeof props.archiveSession === 'function' ? props.archiveSession : () => {};
			// The selector hook REQUIRES a selector function (identity here) —
			// calling useSessions() bare crashes the selector machinery.
			const sessions = useSessions((s) => s);
			const [mode, setMode] = useState(() => {
				try {
					return localStorage.getItem('my-better-dsh.leftMode') || 'sessions';
				} catch {
					return 'sessions';
				}
			});
			// Pins: { sessions: SessionId[], files: { [cwd]: rel[] } } persisted locally.
			const [pins, setPins] = useState(() => {
				try {
					return JSON.parse(localStorage.getItem('my-better-dsh.pins') || '{}');
				} catch {
					return {};
				}
			});
			const [menuOpen, setMenuOpen] = useState(false);
			const lastModeRef = useRef('sessions');
			// One-time hint for the bottom-right 全局设定 button (persisted).
			const [gsHint, setGsHint] = useState(() => {
				try {
					return localStorage.getItem('my-better-dsh.gsHintSeen') !== '1';
				} catch {
					return true;
				}
			});
			useEffect(() => {
				if (!gsHint) return;
				const t = setTimeout(() => setGsHint(false), 8000);
				return () => clearTimeout(t);
			}, [gsHint]);
			const openGsMenu = () => {
				setGsHint(false);
				try {
					localStorage.setItem('my-better-dsh.gsHintSeen', '1');
				} catch {
					/* ignore */
				}
				setMenuOpen((v) => !v);
			};
			const savePins = (next) => {
				setPins(next);
				try {
					localStorage.setItem('my-better-dsh.pins', JSON.stringify(next));
				} catch {
					/* ignore */
				}
			};
			const togglePinSession = (id) => {
				const cur = new Set(pins.sessions || []);
				if (cur.has(id)) cur.delete(id); else cur.add(id);
				savePins({ ...pins, sessions: [...cur] });
			};
			const togglePinFile = (cwd, rel) => {
				const map = { ...(pins.files || {}) };
				const cur = new Set(map[cwd] || []);
				if (cur.has(rel)) cur.delete(rel); else cur.add(rel);
				map[cwd] = [...cur];
				savePins({ ...pins, files: map });
			};
			// Archived sessions (deleted via the ⋯ menu) must disappear from the
			// list — the archive set comes from the workspaces standard kit.
			const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : () => null;
			const workspacesState = useWorkspaces((s) => s);
			const archivedSessionIds = workspacesState !== null && workspacesState !== void 0 && Array.isArray(workspacesState.archivedSessionIds)
				? new Set(workspacesState.archivedSessionIds)
				: new Set();
			useEffect(() => {
				try {
					diag('left-mounted', Object.keys(props).join(','));
					console.log('[my-better-dsh] LeftSidebar mounted, mode=' + mode + ', props:', Object.keys(props).join(','));
				} catch {
					/* ignore */
				}
			}, []);
			useEffect(() => {
				try {
					localStorage.setItem('my-better-dsh.leftMode', mode);
				} catch {
					/* ignore */
				}
			}, [mode]);

			const tab = (key, label, icon) => h('button', {
				style: { ...LEFT_TAB, ...(mode === key ? LEFT_TAB_ACTIVE : {}) },
				onClick: () => setMode(key)
			}, icon, h('span', null, label));

			// Render inside try/catch: a failure here must not silently fall back
			// to the default view — report it and show a visible placeholder.
			let content;
			try {
				content = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
					h('div', { style: { display: 'flex', gap: '4px', padding: '8px 4px', borderBottom: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', flex: 'none' } },
						tab('files', '文件', '📁'),
						tab('sessions', '会话', '💬'),
						tab('outline', '大纲', '🗂')),
					mode === 'files'
						? h(FileTree, {
							cwd: sessions !== null && sessions !== void 0 && sessions.current ? (sessions.byId && sessions.byId[sessions.current] ? sessions.byId[sessions.current].cwd : null) : null,
							pins,
							onTogglePin: (rel) => togglePinFile(sessions !== null && sessions !== void 0 && sessions.current ? (sessions.byId && sessions.byId[sessions.current] ? sessions.byId[sessions.current].cwd : null) : null, rel),
							onOpenFile: (rel) => openFile(sessions !== null && sessions !== void 0 ? sessions.current : void 0, rel)
						})
						: mode === 'settings'
							? h(GlobalSettingsTab, { compact: true, onClose: () => setMode(lastModeRef.current) })
							: mode === 'outline'
								? h(ConversationOutline, { useSessions: props.useSessions, openSession: props.openSession })
								: h(SessionList, { sessions, openSession, archiveSession, pins, onTogglePin: togglePinSession, archivedSessionIds }),
					// ── bottom-right corner: security-mode switch + settings entry ──
					h('div', { style: { position: 'relative', flex: 'none', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '6px', padding: '4px 6px', borderTop: '1px solid var(--dsw-alias-border-l2-darkmode-thin)' } },
						menuOpen && h('div', { style: { position: 'fixed', inset: 0, zIndex: 299 }, onClick: () => setMenuOpen(false) }),
						menuOpen && h('div', { style: { position: 'absolute', right: '4px', bottom: 'calc(100% + 6px)', zIndex: 300, minWidth: '180px', background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '8px', boxShadow: '0 6px 24px rgba(0,0,0,0.25)', padding: '4px', display: 'flex', flexDirection: 'column' } },
							h('button', { style: MENU_ITEM, onClick: () => { lastModeRef.current = mode; setMode('settings'); setMenuOpen(false); } }, '全局设定'),
							h('div', { style: { ...TAB.meta, padding: '2px 10px' } }, '对所有会话生效的指令')),
						gsHint && h('div', {
							style: { position: 'absolute', right: '34px', bottom: 'calc(100% + 8px)', zIndex: 301, background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '8px', padding: '5px 10px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)', boxShadow: '0 6px 24px rgba(0,0,0,0.25)', whiteSpace: 'nowrap', pointerEvents: 'none' }
						}, '⚙️ 全局设定（所有会话生效）'),
						h(SecurityModeSwitch, {
							style: { padding: '2px 6px', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', background: 'var(--dsw-alias-interactive-bg-hover)', borderRadius: '6px' }
						}),
						h('button', {
							style: { position: 'relative', display: 'flex', alignItems: 'center', gap: '5px', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', lineHeight: '20px', padding: '2px 10px 2px 8px', borderRadius: '6px', cursor: 'pointer', whiteSpace: 'nowrap' },
							title: '全局设定（对所有会话生效）',
							'aria-label': '全局设定',
							onClick: openGsMenu
						}, '⚙️', h('span', null, '全局设定'), gsHint && h('span', {
							style: { position: 'absolute', top: '-2px', right: '-2px', width: '9px', height: '9px', borderRadius: '50%', background: 'var(--dsw-alias-state-warning-primary)', border: '2px solid var(--dsw-specific-input-major)' }
						}))),
					h(DeleteConfirmOverlay, { current: sessions !== null && sessions !== void 0 ? sessions.current : null }));
			} catch (error) {
				try {
					diag('left-render-error', error instanceof Error ? error.message : String(error));
				} catch {
					/* ignore */
				}
				content = h('div', { style: { padding: '10px 8px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' } },
					`左侧栏渲染错误：${error instanceof Error ? error.message : String(error)}`);
			}
			return content;
		};

		// ══ 对话大纲（Conversation Outline）══════════════════════════════════
		// 自动扫描当前会话聊天的用户消息 DOM（data-chat-flow-kind="user" +
		// data-chat-anchor-key，官方消息渲染的稳定锚点），生成导航目录：
		// 点击滚动定位并临时高亮，滚动时自动高亮当前阅读段，支持搜索过滤。
		// 只做「定位 → 滚动 → 高亮」，不改变聊天状态。
		const OUTLINE_STYLE = {
			search: { boxSizing: 'border-box', width: '100%', background: 'var(--dsw-alias-interactive-bg-hover)', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '8px', padding: '5px 10px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)', outline: 'none' },
			row: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%', padding: '5px 8px', borderRadius: '6px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', textAlign: 'left', fontSize: '12px', whiteSpace: 'nowrap' },
			rowActive: { background: 'var(--dsw-alias-interactive-bg-hover)' },
			num: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums', width: '20px' },
			dot: { flex: 'none', width: '7px', height: '7px', borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)' },
			title: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }
		};

		/** 从用户消息 flowItem 提取大纲标题：首句文本，截断到约 26 字符。 */
		function outlineTitleFromEl(el) {
			try {
				const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
				if (text === '') return null;
				const m = text.match(/^(.{1,26}?)(?:[。！？!?]|$)/);
				return (m ? m[1] : text.slice(0, 26)).trim();
			} catch {
				return null;
			}
		}

		const ConversationOutline = function ConversationOutline(props) {
			const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => null;
			const sessions = useSessions((s) => s);
			const current = sessions !== null && sessions !== void 0 ? sessions.current : null;
			const [query, setQuery] = useState('');
			const [items, setItems] = useState([]);
			const [activeKey, setActiveKey] = useState(null);
			const listRef = useRef(null);
			const dragRef = useRef(null);
			const lastStateRef = useRef('');
			// 自定义滚动条（DSH 主题默认隐藏原生滚动条）：thumb = {ratio, track, height}
			const [thumb, setThumb] = useState({ ratio: 0, track: 0, height: 0 });

			// 状态上报（仅变化时写 host diag，用于无浏览器控制台时的诊断）
			const reportState = useCallback((label, payload) => {
				const s = JSON.stringify(payload);
				if (lastStateRef.current === s) return;
				lastStateRef.current = s;
				try { diag(label, s); } catch { /* ignore */ }
			}, []);

			// 扫描用户消息 DOM → items（保持 DOM 顺序）
			const scan = useCallback(() => {
				const els = document.querySelectorAll('[data-chat-flow-kind="user"]');
				const next = [];
				els.forEach((el) => {
					const key = el.getAttribute('data-chat-anchor-key');
					if (!key) return;
					const title = outlineTitleFromEl(el);
					if (title === null) return;
					next.push({ key, title, el });
				});
				setItems((prev) => {
					if (prev.length === next.length && prev.every((p, i) => p.key === next[i].key && p.title === next[i].title)) return prev;
					return next;
				});
				reportState('outline-scan', { items: next.length });
			}, [reportState]);

			// 会话变化 / DOM 变化 → 刷新；兜底轮询兜底
			useEffect(() => {
				if (current === null || current === void 0) {
					setItems([]);
					return;
				}
				scan();
				let observer = null;
				try {
					const chatRoot = document.querySelector('[data-conversation-scroll]') ?? document.body;
					observer = new MutationObserver(() => scan());
					observer.observe(chatRoot, { childList: true, subtree: true });
				} catch {
					/* ignore */
				}
				const timer = setInterval(scan, 2000);
				return () => {
					if (observer !== null) observer.disconnect();
					clearInterval(timer);
				};
			}, [current, scan]);

			// 当前阅读位置：IntersectionObserver 取最靠上的可见用户消息
			useEffect(() => {
				const els = items.map((it) => it.el);
				if (els.length === 0) return;
				let io = null;
				try {
					io = new IntersectionObserver((entries) => {
						let best = null;
						let bestTop = Infinity;
						for (const entry of entries) {
							if (!entry.isIntersecting) continue;
							const top = entry.boundingClientRect.top;
							if (top < bestTop) {
								bestTop = top;
								best = entry.target.getAttribute('data-chat-anchor-key');
							}
						}
						if (best !== null) setActiveKey(best);
					}, { root: null, threshold: 0.05 });
					els.forEach((el) => io.observe(el));
				} catch {
					/* ignore */
				}
				return () => {
					if (io !== null) io.disconnect();
				};
			}, [items]);

			// 跳转：滚动定位 + 临时高亮消息（不改聊天状态）
			const jump = (item) => {
				setActiveKey(item.key);
				try {
					item.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
				} catch {
					/* ignore */
				}
				try {
					const node = item.el;
					const wasRelative = node.style.position !== 'static' && node.style.position !== '';
					if (!wasRelative) node.style.position = 'relative';
					const marker = document.createElement('span');
					marker.style.cssText = 'position:absolute;inset:0;pointer-events:none;border:2px solid var(--dsw-alias-state-warning-primary);border-radius:10px;z-index:5;';
					node.appendChild(marker);
					setTimeout(() => {
						try {
							marker.remove();
							if (!wasRelative) node.style.position = '';
						} catch {
							/* ignore */
						}
					}, 2000);
				} catch {
					/* ignore */
				}
				try {
					if (listRef.current !== null) {
						const row = listRef.current.querySelector(`[data-key="${item.key}"]`);
						if (row !== null) row.scrollIntoView({ block: 'nearest' });
					}
				} catch {
					/* ignore */
				}
			};

			// ── 自定义滚动条 ──────────────────────────────────────────────────
			const updateThumb = useCallback(() => {
				const el = listRef.current;
				if (el === null) return;
				const max = el.scrollHeight - el.clientHeight;
				const track = el.clientHeight;
				const height = track <= 0 ? 0 : Math.max(28, track * track / el.scrollHeight);
				const next = { ratio: max > 0 ? el.scrollTop / max : 0, track, height };
				setThumb(next);
				reportState('outline-thumb', { scrollH: el.scrollHeight, clientH: el.clientHeight, show: track > 0 && height < track });
			}, [reportState]);

			// 内容/尺寸变化时刷新滚动条
			useEffect(() => {
				updateThumb();
				const el = listRef.current;
				if (el === null) return;
				let ro = null;
				try {
					ro = new ResizeObserver(() => updateThumb());
					ro.observe(el);
				} catch {
					/* ignore */
				}
				return () => {
					if (ro !== null) ro.disconnect();
				};
			}, [items, updateThumb]);

			// 拖动滑块滚动列表
			const onThumbDown = (e) => {
				const el = listRef.current;
				if (el === null) return;
				dragRef.current = { startY: e.clientY, startTop: el.scrollTop };
				const move = (ev) => {
					const d = dragRef.current;
					if (d === null || el === null) return;
					const max = el.scrollHeight - el.clientHeight;
					if (max <= 0) return;
					const ratio = (ev.clientY - d.startY) / el.clientHeight;
					el.scrollTop = Math.max(0, Math.min(max, d.startTop + ratio * max));
					updateThumb();
				};
				const up = () => {
					dragRef.current = null;
					document.removeEventListener('mousemove', move);
					document.removeEventListener('mouseup', up);
				};
				document.addEventListener('mousemove', move);
				document.addEventListener('mouseup', up);
				e.preventDefault();
			};

			const q = query.trim().toLowerCase();
			const filtered = q === '' ? items : items.filter((it) => it.title.toLowerCase().includes(q));

			return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 4px 4px', flex: 'none' } },
					h('span', { style: { fontWeight: 600, fontSize: '13px', letterSpacing: '0.5px' } }, '🗂 对话大纲'),
					h('span', { style: { flex: 1 } }),
					items.length > 0 && h('span', { style: { ...TAB.meta } }, `${items.length} 条`)),
				h('div', { style: { padding: '0 6px 4px', flex: 'none' } },
					h('input', { style: OUTLINE_STYLE.search, placeholder: '🔍 搜索对话…', value: query, onChange: (e) => setQuery(e.target.value) })),
				h('div', { style: { position: 'relative', flex: 1, minHeight: 0, display: 'flex' } },
					h('div', {
						ref: listRef,
						onScroll: updateThumb,
						className: 'my-better-dsh-outline-scroll',
						style: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '4px 2px', fontSize: '13px' }
					},
						filtered.length === 0
							? h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', padding: '20px 8px', lineHeight: '20px', fontSize: '12px' } },
								q !== '' ? '无匹配节点' : '暂无用户消息')
							: filtered.map((it) => {
								const origIndex = items.indexOf(it);
								const active = it.key === activeKey;
								return h('div', {
									key: it.key,
									className: 'my-better-dsh-outline-row',
									style: { position: 'relative' }
								},
									h('button', {
										'data-key': it.key,
										style: { ...OUTLINE_STYLE.row, ...(active ? OUTLINE_STYLE.rowActive : {}) },
										title: it.title,
										onClick: () => jump(it)
									},
										h('span', { style: OUTLINE_STYLE.num }, String(origIndex + 1).padStart(2, '0')),
										active && h('span', { style: OUTLINE_STYLE.dot }),
										h('span', { style: OUTLINE_STYLE.title }, it.title)));
							})),
					// 自定义可见滚动条（thumb 只在可滚动时显示）
					thumb.track > 0 && thumb.height < thumb.track && h('div', {
						style: { position: 'absolute', right: 2, top: 0, bottom: 0, width: 8, pointerEvents: 'none' }
					},
						h('div', {
							onMouseDown: onThumbDown,
							style: {
								position: 'absolute', left: 0, width: 8, borderRadius: 4,
								top: thumb.ratio * (thumb.track - thumb.height),
								height: thumb.height,
								background: 'var(--dsh-scrollbar-thumb)',
								cursor: 'pointer',
								pointerEvents: 'auto',
								opacity: 0.85
							}
						}))));
		};

		// ══ 删除确认弹框（Security: Full Access except delete）═══════════════
		// host 在 DSH 官方统一工具入口 tools/pre-execute 拦截删除操作并挂起该
		// 工具；本组件轮询 /api/security/delete-pending 取回待确认项，用户点
		// 「允许删除 / 取消」后 POST resolve，host 据此放行（{kind:'allow'}）或
		// 拒绝（{kind:'deny'}，工具以 isError 返回「用户拒绝了该删除操作。」，
		// Agent run 不崩溃）。非删除操作不经此流程，Full Access 行为不变。
		const DELETE_DIALOG_STYLE = {
			wrap: { position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
			box: { background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: '12px', padding: '16px 18px', maxWidth: '400px', width: 'calc(100vw - 48px)', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)' },
			title: { fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' },
			body: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '20px', wordBreak: 'break-all', maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' },
			path: { color: 'var(--dsw-alias-label-primary)', fontFamily: 'monospace', fontSize: '12px' },
			hint: { fontSize: '11px', color: 'var(--dsw-alias-state-warning-primary)' },
			btnRow: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
			btnCancel: { ...OUTLINE_STYLE.row, width: 'auto', background: 'var(--dsw-alias-interactive-bg-hover)' },
			btnAllow: { ...OUTLINE_STYLE.row, width: 'auto', color: '#fff', background: 'var(--dsw-alias-state-error-primary)' }
		};

		const DeleteConfirmOverlay = function DeleteConfirmOverlay(props) {
			const current = props.current;
			const [pending, setPending] = useState(null);
			const [busy, setBusy] = useState(false);

			// 轮询 host 待确认删除项（工具已被挂起，直到用户决定）
			useEffect(() => {
				if (current === null || current === void 0) return;
				let alive = true;
				const poll = async () => {
					try {
						const res = await fetch(`/my-better-dsh/api/security/delete-pending?session=${encodeURIComponent(current)}`, { cache: 'no-store' });
						if (!res.ok) return;
						const data = await res.json();
						if (!alive || data === null || typeof data !== 'object' || data.ok !== true || !Array.isArray(data.items)) return;
						if (data.items.length > 0) setPending((prev) => prev ?? data.items[0]);
					} catch {
						/* keep the last state */
					}
				};
				void poll();
				const timer = setInterval(() => void poll(), 700);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [current]);

			const resolve = (allow) => {
				if (pending === null || busy) return;
				setBusy(true);
				fetch('/my-better-dsh/api/security/delete-resolve', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id: pending.id, allow })
				}).then((r) => r.json()).then(() => {
					setPending(null);
					setBusy(false);
				}).catch(() => setBusy(false));
			};

			if (pending === null) return null;
			const paths = Array.isArray(pending.paths) ? pending.paths : [];
			const isDir = pending.kind === 'directory';
			const isBatch = pending.kind === 'files' || paths.length > 1;
			const title = isDir ? '⚠️ 确认删除目录' : isBatch ? '⚠️ 确认批量删除' : '⚠️ 确认删除';
			const body = [];
			if (isDir) {
				body.push(h('div', null, 'Agent 正在尝试删除目录：'));
				body.push(h('div', { style: DELETE_DIALOG_STYLE.path }, `📁 ${paths[0] ?? ''}`));
				const st = pending.dirStats;
				if (st !== null && st !== void 0 && typeof st === 'object') {
					body.push(h('div', null, `包含：${st.files} 个文件、${st.dirs} 个子目录${st.truncated === true ? '（统计已截断）' : ''}`));
				} else {
					body.push(h('div', null, '包含内容无法统计（可能不存在或无权限）。'));
				}
			} else if (isBatch) {
				body.push(h('div', null, `Agent 正在尝试删除 ${paths.length} 个文件：`));
				const shown = paths.slice(0, 8);
				for (const p of shown) body.push(h('div', { style: DELETE_DIALOG_STYLE.path }, `📄 ${p}`));
				if (paths.length > shown.length) body.push(h('div', null, `… 等共 ${paths.length} 个`));
			} else {
				body.push(h('div', null, 'Agent 正在尝试删除：'));
				body.push(h('div', { style: DELETE_DIALOG_STYLE.path }, `📄 ${paths[0] ?? ''}`));
				body.push(h('div', null, '此操作将删除文件。'));
			}
			if (pending.recursive === true && !isDir) body.push(h('div', null, '（递归删除）'));

			return h('div', { style: DELETE_DIALOG_STYLE.wrap },
				h('div', { style: DELETE_DIALOG_STYLE.box },
					h('div', { style: DELETE_DIALOG_STYLE.title }, title),
					h('div', { style: DELETE_DIALOG_STYLE.body }, ...body),
					pending.hasCheckpoint === true && h('div', { style: DELETE_DIALOG_STYLE.hint }, '🛡 删除前已有 Checkpoint，可在需要时恢复。'),
					h('div', { style: DELETE_DIALOG_STYLE.btnRow },
						h('button', { style: DELETE_DIALOG_STYLE.btnCancel, disabled: busy, onClick: () => resolve(false) }, '取消'),
						h('button', { style: DELETE_DIALOG_STYLE.btnAllow, disabled: busy, onClick: () => resolve(true) }, busy ? '处理中…' : '允许删除'))));
		};

		// Registered component: wraps the inner sidebar in the internal error
		// boundary so a render failure is captured (diag + visible text) instead
		// of abdicating to the default view.
		const LeftSidebar = function LeftSidebar(props) {
			return h(LeftBoundary, null, h(LeftSidebarInner, props));
		};

		// Diagnostic reporter: POSTs events to the host log (readable via
		// GET /my-better-dsh/api/diag) so failures are visible without the
		// browser console.
		function diag(evt, detail) {
			try {
				void fetch('/my-better-dsh/api/diag', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ evt, detail: detail ?? null })
				});
			} catch {
				/* ignore */
			}
		}

		const inject = ['slots', 'betterSidebar', 'sessions', 'workspaces'];

		function apply(ctx) {
			diag('apply-start', 'v0.8.9');
			// Two-row dock layout: official StatsLine first, our status line second.
			ensureDockLayoutCss();
			// Status line below the input box.
			ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
				name: 'conversation.composer.dock',
				id: 'my-better-dsh-status',
				order: 120,
				inject: () => ({
					openSession: (id) => {
						try { ctx.sessions.open(id); } catch { /* ignore */ }
					},
					getCurrentSession: () => {
						try { return ctx.sessions?.list?.getSnapshot?.()?.current ?? null; } catch { return null; }
					},
					getMigratedFrom: () => {
						try {
							const snap = ctx.sessions?.list?.getSnapshot?.();
							const cur = snap?.current;
							if (!cur) return null;
							const meta = snap?.byId?.[cur] ?? null;
							return (meta && (meta.parentSession ?? meta.header?.parentSession)) ?? null;
						} catch {
							return null;
						}
					}
				})
			}, StatusBar));

			// Context-remaining indicator floating inside the input while
			// empty + focused, or while the agent is replying.
			ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
				name: 'conversation.input.overlay',
				id: 'my-better-dsh-remain',
				order: 100,
				inject: () => ({})
			}, ContextRemain));

			// CHECKPOINTS tab in the better-sidebar (service guaranteed by inject).
			ctx.effect(() => {
				try {
					const dispose = ctx.betterSidebar.registerTab({
						id: 'checkpoints',
						title: () => 'CHECKPOINTS',
						order: 60,
						single: true,
						component: CheckpointsTab
					});
					diag('bs-tab-ok', 'checkpoints');
					return dispose;
				} catch (error) {
					diag('bs-tab-failed', 'checkpoints: ' + (error instanceof Error ? error.message : String(error)));
					return void 0;
				}
			});

			// 全局设定 tab: edits ~/.dsh/AGENTS.md (CLAUDE.md-style user-global
			// instructions that every session loads). Order 55 → before CHECKPOINTS.
			ctx.effect(() => {
				try {
					const dispose = ctx.betterSidebar.registerTab({
						id: 'global-settings',
						title: () => '全局设定',
						order: 55,
						single: true,
						component: GlobalSettingsTab
					});
					diag('bs-tab-ok', 'global-settings');
					return dispose;
				} catch (error) {
					diag('bs-tab-failed', 'global-settings: ' + (error instanceof Error ? error.message : String(error)));
					return void 0;
				}
			});

			// Live Diff Review feed: a module-level poller runs while the plugin
			// is active (tab open or not), keeps the feed fresh, auto-opens the
			// Diff Review tab on the FIRST change of each workspace, and pokes
			// the tab bar so the unread badge re-renders live.
			ctx.effect(() => {
				const tick = async () => {
					try {
						let cwd = null;
						try {
							const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
							const cur = snap && snap.current ? snap.current : null;
							if (cur && snap.byId && snap.byId[cur]) cwd = snap.byId[cur].cwd || null;
						} catch {
							/* keep null */
						}
						if (cwd === null) return;
						const after = cwd === diffFeed.cwd ? diffFeed.lastSeq : 0;
						const res = await fetch(`/my-better-dsh/api/diff-review?cwd=${encodeURIComponent(cwd)}&after=${after}`, { cache: 'no-store' });
						if (!res.ok) return;
						const data = await res.json();
						if (!data.ok) return;
						const cwdChanged = cwd !== diffFeed.cwd;
						diffFeed.cwd = cwd;
						diffFeed.lastSeq = data.latestSeq || 0;
						if (cwdChanged) {
							// Rebuild history for the newly active workspace.
							diffFeed.entries = [];
							diffFeed.unread = 0;
							diffFeed.lastFlash = null;
							const histRes = await fetch(`/my-better-dsh/api/diff-review?cwd=${encodeURIComponent(cwd)}&after=0`, { cache: 'no-store' });
							if (histRes.ok) {
								const hist = await histRes.json();
								if (hist.ok && Array.isArray(hist.changes)) {
									diffFeed.entries = [...hist.changes].reverse().slice(0, 6);
									diffFeed.lastSeq = hist.latestSeq || 0;
								}
							}
							diffEmit();
							return;
						}
						const fresh = Array.isArray(data.changes) ? data.changes : [];
						if (fresh.length === 0) return;
						const known = new Set(diffFeed.entries.map((e) => e.seq));
						const add = fresh.filter((e) => !known.has(e.seq));
						if (add.length === 0) return;
						diffFeed.entries = [...add.reverse(), ...diffFeed.entries].slice(0, 6);
						diffFeed.lastFlash = add[add.length - 1].seq;
						diffFeed.unread += add.length;
						// Auto-open the Diff Review tab once per workspace so the right
						// side reacts in real time without the user opening it first.
						if (!diffFeed._autoOpened.has(cwd)) {
							diffFeed._autoOpened.add(cwd);
							try {
								ctx.betterSidebar.openTab({ type: 'diff-review', title: 'Diff Review', path: 'diff-review' });
							} catch {
								/* ignore */
							}
						}
						// Poke the tab bar (no-op when the tab is closed) so the badge
						// re-renders with the new unread count.
						try {
							ctx.betterSidebar.updateTab('diff-review', { meta: Date.now() });
						} catch {
							/* ignore */
						}
						diffEmit();
					} catch {
						/* keep the last feed */
					}
				};
				void tick();
				const timer = setInterval(() => void tick(), DIFF_POLL_MS);
				return () => clearInterval(timer);
			}, 'my-better-dsh: diff review feed');

			// Diff Review tab: live agent file changes with real-time follow.
			// Order 65 → after CHECKPOINTS (60).
			ctx.effect(() => {
				try {
					const dispose = ctx.betterSidebar.registerTab({
						id: 'diff-review',
						title: () => 'Diff Review',
						order: 65,
						single: true,
						badge: () => (diffFeed.unread > 0 ? diffFeed.unread : null),
						component: DiffReviewTab
					});
					diag('bs-tab-ok', 'diff-review');
					return dispose;
				} catch (error) {
					diag('bs-tab-failed', 'diff-review: ' + (error instanceof Error ? error.message : String(error)));
					return void 0;
				}
			});

			// Left sidebar: shadow the default workspace/session browser with the
			// Files/Sessions two-mode view (priority -100 < default 0 → lowest
			// renders). Dual path: try the direct register first; if the slot is
			// not yet declared it throws, and we fall back to the deferred
			// slots.inject (which waits for the declaration). Every branch is
			// reported to the host diag log.
			let sidebarRegistered = false;
			const registerSidebar = () => ctx.slots.register({
				name: 'sidebar.workspaces',
				id: 'my-better-dsh-left',
				priority: -100,
				inject: () => ({
					openSession: (id) => {
						try {
							ctx.sessions.open(id);
						} catch {
							/* ignore */
						}
					},
					openFile: (sessionId, rel) => {
						if (!sessionId || !rel) return;
						try {
							ctx.betterSidebar.openFile({ sessionId }, rel);
						} catch {
							/* ignore */
						}
					},
					archiveSession: (id) => {
						try {
							void ctx.workspaces.archiveSession(id);
						} catch {
							/* ignore */
						}
					}
				})
			}, LeftSidebar);
			try {
				registerSidebar();
				sidebarRegistered = true;
				diag('sidebar-register-ok', 'direct');
			} catch (error) {
				diag('sidebar-register-failed', error instanceof Error ? error.message : String(error));
				console.error('[my-better-dsh] left sidebar direct register failed, falling back to deferred inject:', error);
				try {
					ctx.slots.inject('sidebar.workspaces', () => {
						registerSidebar();
						sidebarRegistered = true;
						diag('sidebar-register-ok', 'inject-fallback');
					});
				} catch (error2) {
					diag('sidebar-inject-failed', error2 instanceof Error ? error2.message : String(error2));
					console.error('[my-better-dsh] left sidebar inject fallback failed:', error2);
				}
			}
			diag('apply-done', sidebarRegistered ? 'sidebar-registered' : 'sidebar-missing');
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
