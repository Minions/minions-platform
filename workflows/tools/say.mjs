import { spawnSync } from 'node:child_process';

// Cross-platform attention nudge. `say.ps1` only speaks on Windows (System.Speech),
// So a wing running on macOS or Linux had no way to call the human at all. Prefer
// This from any platform; say.ps1 stays for Windows callers already invoking it.
const ARGV_TEXT_START = 2;
const EXIT_FAILURE = 1;
const EXIT_SUCCESS = 0;

const text = process.argv.slice(ARGV_TEXT_START).join(' ');
if (!text) {
	console.error('Usage: node .meta/workflows/tools/say.mjs <text>');
	process.exit(EXIT_FAILURE);
}

const candidates = {
	darwin: [['say', [text]]],
	linux: [
		['spd-say', [text]],
		['espeak', [text]],
	],
	win32: [
		[
			'powershell',
			[
				'-NoProfile',
				'-Command',
				`Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(${JSON.stringify(text)})`,
			],
		],
	],
};

const spoke = (candidates[process.platform] ?? []).some(([command, args]) => {
	const result = spawnSync(command, args, { stdio: 'ignore' });
	return !result.error && result.status === EXIT_SUCCESS;
});

if (!spoke) {
	console.error(`No speech synthesizer available on ${process.platform}: ${text}`);
	process.exit(EXIT_FAILURE);
}
