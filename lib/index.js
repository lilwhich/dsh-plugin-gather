// my_better-dsh host half: DeepSeek account status proxy.
//
// - Polls the REAL DeepSeek balance API (https://api.deepseek.com/user/balance)
//   every 60 seconds, using the DEEPSEEK_API_KEY credential (resolved through
//   the credentials service — the key never leaves the host).
// - Tracks the first-seen total balance to report REAL spend (the balance
//   delta since this host process started).
// - Serves GET /my-better-dsh/api/status for the client status bar.
//
// The client computes the DeepSeek peak/idle pricing-period countdown locally;
// only the account numbers come from the real API via this route.

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

/** Services required from the host composition. */
export const inject = ['webServer', 'credentials'];

/**
 * Poll the balance API and cache the result. Failures are recorded in
 * `lastError` and clear the cached balance so the client can show "--".
 */
export function apply(ctx) {
	let balance = null;
	let initialTotal = null;
	let lastError = null;

	async function refresh() {
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

	const timer = setInterval(() => void refresh(), REFRESH_MS);
	void refresh();

	const disposeRoute = ctx.webServer.register({
		kind: 'exact',
		path: '/my-better-dsh/api/status',
		handler: (_req, res) => {
			res.setHeader('content-type', 'application/json');
			res.setHeader('cache-control', 'no-store');
			const spend = balance !== null && balance.total !== null && initialTotal !== null
				? Math.max(0, initialTotal - balance.total)
				: null;
			res.end(JSON.stringify({
				ok: balance !== null && lastError === null,
				balance: balance?.total ?? null,
				currency: balance?.currency ?? null,
				isAvailable: balance?.isAvailable ?? null,
				spend,
				fetchedAt: balance?.fetchedAt ?? null,
				error: lastError
			}));
		}
	});

	return () => {
		clearInterval(timer);
		disposeRoute();
	};
}
