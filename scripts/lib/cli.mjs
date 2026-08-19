// Shared CLI prologue for scripts/*.mjs runners: parse argv or die.
//
// Every runner used to duplicate this identical try/catch (parse args, print
// the error, optionally print help, exit(2)). Kept here so the runners stay
// focused on their actual job instead of carrying boilerplate.

/**
 * Parse argv with `parser`; on failure print the error and exit(2).
 *
 * @param {(...argv: string[]) => Record<string, unknown>} parser
 * @param {string[]} argv
 * @param {{ printHelp?: () => void }} [opts]
 * @returns {Record<string, unknown>}
 */
export function parseArgsOrExit(parser, argv, { printHelp } = {}) {
	let args;
	try {
		args = parser(argv);
	} catch (err) {
		process.stderr.write(`${String(err.message || err)}\n`);
		if (printHelp) printHelp();
		process.exit(2);
	}
	return args;
}
