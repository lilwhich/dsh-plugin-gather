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
		const DOCK_STYLE = {
			boxSizing: 'border-box',
			color: 'var(--dsw-alias-label-tertiary)',
			fontSize: '12px',
			fontVariantNumeric: 'tabular-nums',
			lineHeight: '20px',
			margin: '0 auto',
			maxWidth: 'var(--dsh-chat-content-width)',
			overflow: 'hidden',
			padding: '0 var(--dsh-composer-side-clearance)',
			textAlign: 'center',
			textOverflow: 'ellipsis',
			whiteSpace: 'nowrap',
			width: '100%'
		};

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

		const StatusBar = function StatusBar(props) {
			const [status, setStatus] = useState(null);
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

			return h('div', { style: DOCK_STYLE, title: '余额/花费来自 DeepSeek 真实 API（60 秒刷新）；时段为官方峰谷定价（高峰 9-12、14-18 北京时间，空闲半价）；上下文为当前对话剩余窗口' },
				`余额 ${balanceText} · 本次已消耗 ${spendText} · `,
				h('span', { style: { color: periodColor } }, periodLabel),
				` · 距切换 ${fmtCountdown(remain)} · 上下文`,
				h('span', { style: { color: ctxColor, fontWeight: 600 } }, ` ${ctxText}`)
			);
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
			const rows = ids.map((id) => byId[id]).filter((s) => s !== void 0 && !s.blank && !archived.has(s.id));
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
						tab('sessions', '会话', '💬')),
					mode === 'files'
						? h(FileTree, {
							cwd: sessions !== null && sessions !== void 0 && sessions.current ? (sessions.byId && sessions.byId[sessions.current] ? sessions.byId[sessions.current].cwd : null) : null,
							pins,
							onTogglePin: (rel) => togglePinFile(sessions !== null && sessions !== void 0 && sessions.current ? (sessions.byId && sessions.byId[sessions.current] ? sessions.byId[sessions.current].cwd : null) : null, rel),
							onOpenFile: (rel) => openFile(sessions !== null && sessions !== void 0 ? sessions.current : void 0, rel)
						})
						: h(SessionList, { sessions, openSession, archiveSession, pins, onTogglePin: togglePinSession, archivedSessionIds }));
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
			diag('apply-start', 'v0.6.5');
			// Status line below the input box.
			ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
				name: 'conversation.composer.dock',
				id: 'my-better-dsh-status',
				order: 120,
				inject: () => ({})
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
			ctx.effect(() => ctx.betterSidebar.registerTab({
				id: 'checkpoints',
				title: () => 'CHECKPOINTS',
				order: 60,
				single: true,
				component: CheckpointsTab
			}));

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
