window.__ModuleLoader__.load({
	id: 'my_better-dsh',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		let react = require('react');
		let { useEffect, useState, useRef } = react;
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
			// Beijing is UTC+8 with no DST: shift the clock, then read UTC fields.
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

		// ── Status bar below the composer (conversation.composer.dock) ──────────
		// API balance · real spend · current period · countdown to next switch.
		// Balance/spend come from the host proxy (real DeepSeek API, 60s refresh).
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

			// 1s clock drives the countdown.
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

		// ── Context-remaining indicator inside the composer (conversation.input.overlay) ──
		// Shown ONLY when the input is empty and focused (cursor floating), and only
		// as the remaining percentage number.
		const ContextRemain = function ContextRemain(props) {
			const pressure = props.useProjection('contextPressure');
			const ref = useRef(null);
			const [visible, setVisible] = useState(false);

			// Poll the composer textarea: show only while empty + focused.
			useEffect(() => {
				const timer = setInterval(() => {
					const el = ref.current;
					if (el === null) return;
					const card = el.parentElement; // overlayAnchor's parent = composer card
					const ta = card !== null ? card.querySelector('textarea') : null;
					const show = ta !== null && ta.value === '' && document.activeElement === ta;
					setVisible(show);
				}, 400);
				return () => clearInterval(timer);
			}, []);

			if (!visible) return null;

			const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
			const window = pressure?.contextWindow;
			if (used === void 0 || window === void 0 || window <= 0) return null;

			const remain = Math.max(0, 100 - Math.round((used / window) * 100));
			const color = remain > 50 ? '#4ade80' : remain > 20 ? '#facc15' : '#f87171';

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
				title: `上下文窗口剩余 ${remain}%（1M）`
			}, `${remain}%`);
		};

		const inject = ['slots'];

		function apply(ctx) {
			// Status line below the input box (the composer dock / stats-line seat).
			ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
				name: 'conversation.composer.dock',
				id: 'my-better-dsh-status',
				order: 120,
				inject: () => ({})
			}, StatusBar));

			// Context-remaining % floating inside the input while it is empty + focused.
			ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
				name: 'conversation.input.overlay',
				id: 'my-better-dsh-remain',
				order: 100,
				inject: () => ({})
			}, ContextRemain));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
