/**
 * Last-resort process crash guard (issue #125 — "pi agent shouldn't crash in
 * timeout").
 *
 * Why this exists: Node's default unhandled-rejection mode terminates the
 * whole host process when any promise rejects without a handler, and any
 * throw inside a timer or event listener is fatal the same way. pi-webaio
 * runs dozens of background lanes (Google/Reddit CDP, broker, prefetch,
 * browser pool) whose promises can settle long after the tool call that
 * spawned them has returned. Every known lane is individually guarded —
 * probes over the real broker machinery (late-rejecting lanes,
 * late-resolving lanes, broker process death, no-socket deadline, user
 * cancel) all report zero unhandled rejections — but the guarantee the issue
 * asks for ("extension could reach timeout but not crash agent. it should
 * only stop trying") needs a net over every path, including code loaded into
 * the host process that this extension does not own.
 *
 * Contract:
 *   - installCrashGuard() is idempotent; handlers never rethrow and never
 *     exit. The host decides its own lifecycle; the guard only records.
 *   - Bounded observability: the first MAX_RECORDS events keep message +
 *     capped stack; anything further collapses into a suppressed counter.
 *     Records are mirrored to debug("crash-guard", …), and the FIRST record
 *     of a session also writes one stderr line even without PI_WEBAIO_DEBUG
 *     so a silent survival is still reportable — issue #125 arrived with no
 *     evidence at all, which is why it could not be attributed.
 *   - One record per event kind per session is not the model here: each
 *     distinct failure event is bounded-counted, matching the principle that
 *     repeated degradations go through a counted record, never an unbounded
 *     one.
 */
import { debug } from "./debug.ts";

export type CrashGuardKind = "unhandledRejection" | "uncaughtException";

export interface CrashRecord {
	kind: CrashGuardKind;
	message: string;
	/** Capped at MAX_STACK_CHARS so a pathological stack cannot balloon memory. */
	stack?: string;
	at: number;
}

/** Events that keep full detail before collapsing into the counter. */
const MAX_RECORDS = 5;
/** Per-record stack cap (bounded along both axes: count and size). */
const MAX_STACK_CHARS = 2000;

interface CrashGuardState {
	records: CrashRecord[];
	suppressed: number;
	installed: boolean;
}

const state: CrashGuardState = {
	records: [],
	suppressed: 0,
	installed: false,
};

function describe(error: unknown): { message: string; stack?: string } {
	if (error instanceof Error) {
		return {
			message: error.message,
			stack: error.stack?.slice(0, MAX_STACK_CHARS),
		};
	}
	return { message: String(error) };
}

function record(kind: CrashGuardKind, error: unknown): void {
	// The guard must never become the crash it guards against: the whole body
	// is defensive because it runs in the two contexts where arbitrary state
	// corruption is already assumed.
	try {
		const { message, stack } = describe(error);
		if (state.records.length < MAX_RECORDS) {
			state.records.push({ kind, message, stack, at: Date.now() });
			if (state.records.length === 1) {
				try {
					process.stderr.write(
						`[pi-webaio:crash-guard] suppressed a fatal process error (${kind}): ${message} — host stays alive; set PI_WEBAIO_DEBUG=1 to trace\n`,
					);
				} catch {
					// stderr may be closed or redirected; survival matters more.
				}
			}
		} else {
			state.suppressed += 1;
		}
		debug("crash-guard", kind, message, stack ?? "(no stack)");
	} catch {
		// Intentionally ignored: recording must never throw.
	}
}

/**
 * Install the process-level guard. Idempotent — safe to call from every host
 * entry (pi extension, MCP server). Never throws.
 */
export function installCrashGuard(): void {
	if (state.installed) return;
	state.installed = true;
	try {
		process.on("unhandledRejection", (reason: unknown) => {
			record("unhandledRejection", reason);
		});
		process.on("uncaughtException", (error: Error) => {
			record("uncaughtException", error);
		});
	} catch {
		// A host that forbids process listeners must still load the extension.
		state.installed = false;
	}
}

/** Snapshot of the records captured so far (bounded; test/diagnostic seam). */
export function crashGuardRecords(): readonly CrashRecord[] {
	return state.records;
}

/** Events dropped after the record cap (bounded; test/diagnostic seam). */
export function crashGuardSuppressedCount(): number {
	return state.suppressed;
}

/** Test seam: clear captured records/counter without touching the handlers. */
export function resetCrashGuardForTests(): void {
	state.records = [];
	state.suppressed = 0;
}
