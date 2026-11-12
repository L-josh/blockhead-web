// The hiscore board for blockhe.ad: one row per player, their best run by kills, under three
// initials. A Cloudflare Pages Function on a D1 database bound as DB (docs/hiscore.md).
//
//   GET  /api/scores[?id=ID]   the top runs. With an id: which one is yours, and the player is
//                              remembered from now on (see the clock check below)
//   POST /api/scores           {id, name, kills, time, level, dares}: a run, kept if it's the
//                              player's best
//
// The game is the only client and treats every failure as "no board today".
//
// What stops a made-up score (none of it stops someone patient; it stops the lazy):
//   - kills can't be more than the spawner could have put out in that time (maxKills)
//   - a run can't be longer than the server has known the player, or than the time since their
//     last score: a fake long run costs that long in real waiting
//   - one row per player, and a day's cap on new players and posts per address

const TOP = 20;
const MAX_TIME = 2 * 3600;   // s. Foes' HP climbs so steeply that a run is over long before this
const DARES_COUNTED = 30;    // Dares past this add nothing to the bound
const SLACK = 30;            // s of grace on the clock check
const RANK_CAP = 999;        // ranks are counted this far; past it a rank reads RANK_CAP + 1
const NEW_PLAYERS_A_DAY = 100;   // per address
const POSTS_A_DAY = 300;         // per address
const MASK = '???';          // what a blocked name shows as
const ID = /^[0-9a-f]{32}$/;
const NAME = /^[A-Z]{3}$/;

// Initials nobody gets to show. The game keeps the same list to turn them down as they're typed
// (godot/scripts/hiscore.gd); deploy_web.py stops if the two differ. Names are masked on the way
// out as well as on the way in, so adding one here cleans up the board that's already there.
const BLOCKED = new Set([
	'ASS', 'ARS', 'AZZ', 'FUK', 'FUC', 'FCK', 'FUX', 'FUQ', 'FKU', 'FKN', 'PHK', 'PHU', 'FAP',
	'CUM', 'JIZ', 'SEX', 'TIT', 'DIK', 'DIC', 'DCK', 'DIX', 'COK', 'KOK', 'COC', 'CNT', 'KNT',
	'CUN', 'TWT', 'VAG', 'PUS', 'CLT', 'PNS', 'ANL', 'ANU', 'HOE', 'HOR', 'SLT', 'WNK', 'PIS',
	'SHT', 'TRD', 'BCH', 'WTF', 'NIG', 'NGR', 'NGA', 'NIP', 'JAP', 'CHK', 'GOK', 'GUK', 'KIK',
	'KYK', 'SPC', 'WOG', 'WOP', 'ABO', 'PKI', 'FAG', 'FGT', 'DYK', 'RTD', 'KKK', 'NAZ', 'NZI',
	'HTL', 'KYS', 'KMS', 'RPE', 'PED', 'PDO',
]);

// The most kills a run of t seconds could have. The game's spawner (game.gd, config.gd) trickles
// 0.9 + t/40 foes a second, and each Dare adds a tenth to that; rings, swarm packs, Splitters'
// young, elites and a boss's adds come on top. This allows half as much again as the trickle with
// every Dare counted from the first second, then 2 a second and 200 more: two to four times what
// a strong run gets, so an honest one is never near it.
function maxKills(t, dares) {
	const trickle = 0.9 * t + (t * t) / 80;
	return Math.ceil(1.5 * (1 + 0.1 * Math.min(dares, DARES_COUNTED)) * trickle + 2 * t + 200);
}

// A level takes more XP each time: the game's challenge is level 25 in 12 minutes or more.
function maxLevel(t) {
	return Math.floor(10 + t / 10);
}

// Why a posted run is turned down: 'bad' (not what the game sends), 'bound' (not possible), or ''.
function refuse(run) {
	if (!run || typeof run !== 'object') return 'bad';
	const { id, name, kills, time, level, dares } = run;
	if (typeof id !== 'string' || !ID.test(id) || typeof name !== 'string' || !NAME.test(name)) return 'bad';
	for (const n of [kills, time, level, dares]) {
		if (!Number.isInteger(n) || n < 0) return 'bad';
	}
	if (kills < 1 || time < 1 || level < 1) return 'bad';
	if (time > MAX_TIME || level > maxLevel(time)) return 'bound';
	if (dares >= level) return 'bound';              // a Dare is a level-up's pick
	if (kills > maxKills(time, dares)) return 'bound';
	return '';
}

function shown(name) {
	return BLOCKED.has(name) ? MASK : name;
}

function seconds() {
	return Math.floor(Date.now() / 1000);
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
	});
}

// The tables make themselves the first time a fresh copy of this code runs.
let ready = false;
async function init(db) {
	if (ready) return;
	await db.batch([
		// at: when the best was set (the earlier of two equal scores ranks higher).
		// mark: when the player was first seen, then when each best was taken (the clock check).
		db.prepare(`CREATE TABLE IF NOT EXISTS scores (
			id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', kills INTEGER NOT NULL DEFAULT 0,
			time INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0, dares INTEGER NOT NULL DEFAULT 0,
			at INTEGER NOT NULL DEFAULT 0, mark INTEGER NOT NULL)`),
		db.prepare('CREATE INDEX IF NOT EXISTS scores_top ON scores (kills DESC, at ASC)'),
		// A day's counts per address (hashed), for the caps.
		db.prepare(`CREATE TABLE IF NOT EXISTS hits (
			ip TEXT PRIMARY KEY, day INTEGER NOT NULL, made INTEGER NOT NULL DEFAULT 0, posts INTEGER NOT NULL DEFAULT 0)`),
	]);
	ready = true;
}

// Counts one more of `what` ('made' or 'posts') for this address today; false once it's over.
async function allow(db, request, what, limit) {
	const ip = request.headers.get('CF-Connecting-IP') || '';
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('blockhead hits ' + ip));
	const key = [...new Uint8Array(bytes).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
	const day = Math.floor(Date.now() / 86400000);
	const row = await db.prepare(
		`INSERT INTO hits (ip, day, made, posts) VALUES (?1, ?2, ?3, ?4)
		ON CONFLICT(ip) DO UPDATE SET
			made = CASE WHEN day = excluded.day THEN made ELSE 0 END + excluded.made,
			posts = CASE WHEN day = excluded.day THEN posts ELSE 0 END + excluded.posts,
			day = excluded.day
		RETURNING made, posts`,
	).bind(key, day, what === 'made' ? 1 : 0, what === 'posts' ? 1 : 0).first();
	return row[what] <= limit;
}

// First sight of a player: the clock check counts from here.
async function remember(db, request, id, now) {
	if (!(await allow(db, request, 'made', NEW_PLAYERS_A_DAY))) return false;
	await db.prepare('INSERT OR IGNORE INTO scores (id, mark) VALUES (?, ?)').bind(id, now).run();
	return true;
}

export async function onRequestGet({ request, env }) {
	const db = env.DB;
	if (!db) return json({ ok: false, why: 'off' }, 503);
	try {
		await init(db);
		const id = new URL(request.url).searchParams.get('id') || '';
		const out = { ok: true, top: [] };
		if (ID.test(id)) {
			const row = await db.prepare('SELECT kills FROM scores WHERE id = ?').bind(id).first();
			out.known = row ? true : await remember(db, request, id, seconds());
			out.best = row ? row.kills : 0;
		}
		const rows = await db.prepare('SELECT id, name, kills FROM scores WHERE kills > 0 ORDER BY kills DESC, at ASC LIMIT ?')
			.bind(TOP).all();
		for (const r of rows.results) {
			const entry = { n: shown(r.name), k: r.kills };
			if (r.id === id) entry.me = true;
			out.top.push(entry);
		}
		return json(out);
	} catch (e) {
		return json({ ok: false, why: 'error' }, 500);
	}
}

export async function onRequestPost({ request, env }) {
	const db = env.DB;
	if (!db) return json({ ok: false, why: 'off' }, 503);
	try {
		const text = await request.text();
		let run = null;
		try {
			run = text.length <= 400 ? JSON.parse(text) : null;
		} catch (e) {
			run = null;
		}
		const why = refuse(run);
		if (why) return json({ ok: false, why }, why === 'bad' ? 400 : 422);
		await init(db);
		const now = seconds();
		const row = await db.prepare('SELECT name, kills, mark FROM scores WHERE id = ?').bind(run.id).first();
		if (!row) {              // a stranger: known from now, and the run is taken once that's long enough ago
			await remember(db, request, run.id, now);
			return json({ ok: false, why: 'wait', in: run.time }, 429);
		}
		if (!(await allow(db, request, 'posts', POSTS_A_DAY))) return json({ ok: false, why: 'rate' }, 429);
		const name = shown(run.name);
		let kills = row.kills;
		if (run.kills > row.kills) {
			const since = now - row.mark + SLACK;
			if (run.time > since) return json({ ok: false, why: 'wait', in: run.time - since }, 429);
			kills = run.kills;
			await db.prepare('UPDATE scores SET name = ?, kills = ?, time = ?, level = ?, dares = ?, at = ?, mark = ? WHERE id = ?')
				.bind(name, run.kills, run.time, run.level, run.dares, now, now, run.id).run();
		} else if (name !== row.name) {      // the same best under new initials
			await db.prepare('UPDATE scores SET name = ? WHERE id = ?').bind(name, run.id).run();
		}
		const ahead = await db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM scores WHERE kills > ? LIMIT ?)')
			.bind(kills, RANK_CAP).first();
		return json({ ok: true, kills, rank: ahead.n + 1 });
	} catch (e) {
		return json({ ok: false, why: 'error' }, 500);
	}
}
