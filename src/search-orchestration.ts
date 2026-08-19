// ─── Search provider orchestration helpers ─────────────────────────
//
// Reddit remains an automatic companion to aio-websearch whenever the shared
// CDP instance is available. `google: false` only disables Google; it does
// not disable the standalone Reddit provider. Keep this policy explicit so
// the two CDP providers do not accidentally drift apart.

export function shouldRunReddit(
	cdpAvailable: boolean,
	providerAvailable: boolean,
): boolean {
	return cdpAvailable && providerAvailable;
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
