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

		const StatusBar = function StatusBar(props) {
			const [status, setStatus] = useState(null);
			const [, setTick] = useState(0);

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

			return h('div', { style: DOCK_STYLE, title: '余额/花费来自 DeepSeek 真实 API（60 秒刷新）；时段为官方峰谷定价（高峰 9-12、14-18 北京时间，空闲半价）' },
				`余额 ${balanceText} · 本次已消耗 ${spendText} · `,
				h('span', { style: { color: periodColor } }, periodLabel),
				` · 距切换 ${fmtCountdown(remain)}`
			);
		};

		// ══ Current-conversation remaining context window indicator ══════════
		// Shown in the composer when the input is empty + focused (cursor
		// floating), and also while the agent is sending a message (running).
		// Content: the remaining context window of the current conversation
		// (e.g. "剩 384K/1M"), colored by how much is left.
		function fmtTokens(n) {
			if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
			if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
			return String(n);
		}

		const ContextRemain = function ContextRemain(props) {
			const pressure = props.useProjection('contextPressure');
			const snapshot = props.useSession();
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

		const inject = ['slots'];

		function apply(ctx) {
			// Status line below the input box.
			ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
				name: 'conversation.composer.dock',
				id: 'my-better-dsh-status',
				order: 120,
				inject: () => ({})
			}, StatusBar));

			// Context-remaining % floating inside the input while empty + focused.
			ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
				name: 'conversation.input.overlay',
				id: 'my-better-dsh-remain',
				order: 100,
				inject: () => ({})
			}, ContextRemain));

			// CHECKPOINTS tab in the better-sidebar (absent → skip gracefully).
			const betterSidebar = ctx.get('betterSidebar');
			if (betterSidebar !== void 0) {
				ctx.effect(() => betterSidebar.registerTab({
					id: 'checkpoints',
					title: () => 'CHECKPOINTS',
					order: 60,
					single: true,
					component: CheckpointsTab
				}));
			}
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
