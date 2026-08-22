// ─── Search provider orchestration helpers ─────────────────────────
//
// Reddit is opt-in via the request flag (v1.0.1): `reddit: true` enables the
// standalone Reddit provider; it no longer runs as an implicit companion.
// Google remains opt-in via `google` (default true). Keep both policies
// explicit so the two CDP providers do not accidentally drift apart.

export function shouldRunReddit(
	redditRequested: boolean,
	cdpAvailable: boolean,
	providerAvailable: boolean,
): boolean {
	return redditRequested && cdpAvailable && providerAvailable;
}

/** Google is opt-in via the request flag; unlike Reddit, it is never implicit. */
export function shouldRunGoogle(
	useGoogle: boolean,
	cdpAvailable: boolean,
	providerAvailable: boolean,
): boolean {
	return useGoogle && cdpAvailable && providerAvailable;
}

export interface ProviderDeadlineResult<K extends string, V> {
	/** Values observed before the deadline. Late values are deliberately absent. */
	values: Partial<Record<K, V>>;
	/** True when at least one provider was still pending at the deadline. */
	timedOut: boolean;
}

/**
 * Wait for provider values up to a hard response deadline.
 *
 * Providers are observed as they settle, so a timeout returns the values that
 * were actually available instead of awaiting the slowest provider. The
 * rejection handler is attached before the wait begins and late settlements
 * are ignored, preventing abandoned CDP work from becoming unhandled
 * rejections or mutating the returned snapshot.
 */
export async function collectProviderResults<K extends string, V>(
	providers: ReadonlyArray<readonly [K, PromiseLike<V>]>,
	deadlineMs: number,
): Promise<ProviderDeadlineResult<K, V>> {
	const values = {} as Partial<Record<K, V>>;
	let acceptingValues = true;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	const observed = providers.map(([key, provider]) =>
		Promise.resolve(provider).then(
			(value) => {
				if (acceptingValues) values[key] = value;
				return value;
			},
			() => undefined,
		),
	);
	const allProviders = Promise.all(observed);
	const timeout = new Promise<true>((resolve) => {
		timeoutHandle = setTimeout(() => resolve(true), deadlineMs);
		(
			timeoutHandle as ReturnType<typeof setTimeout> & { unref?: () => void }
		).unref?.();
	});

	let timedOut = false;
	try {
		timedOut = await Promise.race([
			allProviders.then(() => false as const),
			timeout,
		]);
	} finally {
		acceptingValues = false;
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}

	return { values, timedOut };
}
