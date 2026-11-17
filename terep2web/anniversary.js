// The zips the page plays from, read here (no library): the Terep2 30th
// Anniversary Edition's, a megapack's (a folder a map) or one map's (its
// files at the top).  Each gives the maps to pick from, and the Anniversary
// Edition's the car models (.dat), their textures (.pcx) and the files every
// map shares (fog and translucency tables) too.  A file is { path, read }:
// read() gives its contents, an ArrayBuffer.

// In the Anniversary Edition, under the folder that holds TEREP/ and Extras/
// (its zip's "Terep - 30th Anniversary Edition/"): folder -> its name in the lists.
export const CAR_DIRS = {
    'TEREP/AUTOK/': 'Terep 2',
    'Extras/Car Models/': 'Extras',
    'Extras/Car Models/More/': 'Extras (more)',
};
export const CAR_TEXTURE_DIRS = {
    'TEREP/CARTEX/': 'Terep 2',
    'Extras/Car Textures/': 'Extras',
};
export const TRACK_DIRS = {
    'TEREP/PALYAK/': 'Terep 2',
    'Extras/Tracks/': 'Extras',
};
// The files of every map, in SHARED_DIR (a map's own one goes first).
export const SHARED_DIR = 'TEREP/';
export const SHARED_FILES = ['fog.dat', 'smoke.dat', 'textures.pcx', 'sim.cfg'];

// A map's files: only the kinds the game reads (PCX images, .dat tables and
// cars, sim.cfg); a folder with one of NEEDED or WANTED is a map.
export const MAP_FILE = /\.(pcx|dat|cfg)$/i;
export const NEEDED = ['map.pcx', 'col.pcx', 'maptex.pcx'];         // without one of them, no map (load_map)
export const WANTED = ['textures.pcx', 'fog.dat', 'smoke.dat'];     // without them it plays, looking wrong
// A map's own checkpoints, in its files (else the page's checkpoints/).
export const CHECKPOINTS_FILE = 'checkpoints.txt';

export const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);

// The files of a zip: its central directory, at the end, lists each file's
// name and where its data is, stored or deflated (which the browser's
// DecompressionStream undoes).
export function readZip(buffer) {
    const buf = new Uint8Array(buffer), dv = new DataView(buffer);
    let end = buf.length - 22;          // the end of central directory record, after a comment of up to 64K
    while (end >= 0 && dv.getUint32(end, true) !== 0x06054b50)
        end--;
    if (end < 0)
        throw new Error('not a zip');
    const decoder = new TextDecoder(), files = [];
    for (let n = dv.getUint16(end + 10, true), p = dv.getUint32(end + 16, true); n--;) {
        const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true), local = dv.getUint32(p + 42, true);
        const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen)).replaceAll('\\', '/');
        p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        const data = buf.subarray(start, start + size);
        if (name.endsWith('/'))
            continue;
        files.push({ path: name, read: method === 0 ? async () => data.slice().buffer
            : method === 8 ? () => new Response(new Blob([data]).stream()
                .pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()
            : () => Promise.reject(new Error(name + ': unknown zip compression ' + method)) });
    }
    return files;
}

// The files right in one of the folders of dirs, under root (lower case),
// not in their subfolders, whose names match ext, as { group, name, file },
// in the order of dirs.
function choices(files, root, dirs, ext) {
    const found = [];
    for (const [dir, group] of Object.entries(dirs)) {
        const d = root + dir.toLowerCase(), inDir = [];
        for (const file of files) {
            const path = file.path.toLowerCase();
            if (path.startsWith(d) && !path.slice(d.length).includes('/') && ext.test(path))
                inDir.push({ group, name: baseName(file.path), file });
        }
        found.push(...inDir.sort((a, b) => a.name.localeCompare(b.name)));
    }
    return found;
}

// The folder of a path ('' at the top), and the folders of the files, each
// with its '/' (lower case).
const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);

function folders(files) {
    const dirs = new Set();
    for (const f of files)
        for (let i = f.path.indexOf('/'); i >= 0; i = f.path.indexOf('/', i + 1))
            dirs.add(f.path.slice(0, i + 1).toLowerCase());
    return dirs;
}

// Where the Anniversary Edition is in the zip: the folder (lower case, ''
// at the top) with both TEREP/ and Extras/ in it, or null.
function anniversaryRoot(files) {
    const dirs = folders(files);
    for (const d of dirs)
        if (d.endsWith('terep/') && dirs.has(d.slice(0, -'terep/'.length) + 'extras/'))
            return d.slice(0, -'terep/'.length);
    return null;
}

// The maps in files: each folder with a map's files, { dir, files } (its
// own, not its subfolders', of the kinds the game reads).
function mapFolders(files) {
    const dirs = new Map();
    for (const f of files) {
        if (!MAP_FILE.test(f.path))
            continue;
        const dir = dirOf(f.path).toLowerCase();
        if (!dirs.has(dir))
            dirs.set(dir, { dir: dirOf(f.path), files: [] });
        dirs.get(dir).files.push(f);
    }
    return [...dirs.values()].filter((m) => m.files.some((f) => [...NEEDED, ...WANTED].includes(baseName(f.path).toLowerCase())));
}

// A map's own checkpoints file, if it has one.
export const checkpointsOf = (files) => files.find((f) => baseName(f.path).toLowerCase() === CHECKPOINTS_FILE);

// A track's own name, the second line of its inst.inf (if it has one): the
// zip's or folder's name is DOS's, 8 letters at most.  An old DOS text, not
// always UTF-8: then each byte a letter (Latin-1).
export async function trackTitle(files) {
    const inf = files.find((f) => baseName(f.path).toLowerCase() === 'inst.inf');
    if (!inf)
        return null;
    const bytes = await inf.read();
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        text = new TextDecoder('latin1').decode(bytes);
    }
    return text.split(/\r?\n/)[1]?.trim() || null;
}

// What the zip (a File) has: { kind, tracks, cars, textures, shared },
// kind 'anniversary' (the 30th Anniversary Edition: its maps, cars, car
// textures, shared files), 'megapack' (a folder a map, or a zip a map: its
// maps only) or 'map' (one map: tracks has it alone).  The Anniversary
// Edition is known by its TEREP/ and Extras/ folders, whatever the zip is
// called (its name said so, or it was renamed).  A track is { group, name,
// title, files } (name: the zip's or folder's, for the page's checkpoints),
// sorted by title.
export async function openZip(zip) {
    const files = readZip(await zip.arrayBuffer());
    const root = anniversaryRoot(files);
    if (root !== null)
        return openAnniversary(files, root);

    // the maps: folders of their files, or zips of them (as the Anniversary Edition's)
    const tracks = mapFolders(files).map((m) => ({ group: '', name: baseName(m.dir.slice(0, -1)) || zip.name.replace(/\.[^.]*$/, ''),
        files: files.filter((f) => dirOf(f.path).toLowerCase() === m.dir.toLowerCase()) }));
    await Promise.all(files.filter((f) => /\.zip$/i.test(f.path)).map(async (f) => {
        try {
            const inner = readZip(await f.read());
            if (mapFolders(inner).some((m) => m.dir === ''))
                tracks.push({ group: '', name: baseName(f.path).replace(/\.[^.]*$/, ''), files: inner.filter((g) => !g.path.includes('/')) });
        } catch { /* not a map's */ }
    }));
    if (!tracks.length)
        throw new Error(/30th anniversary/i.test(zip.name)
            ? 'no TEREP and Extras folders in it, nor a map: is it the 30th Anniversary Edition zip?'
            : 'no map in it (a folder with map.pcx, col.pcx, maptex.pcx...)');
    await titled(tracks);
    return { kind: tracks.length > 1 ? 'megapack' : 'map', tracks, cars: [], textures: [], shared: [] };
}

// Each track's title: its inst.inf's, else its name; sorted by group, title.
async function titled(tracks, groups = ['']) {
    await Promise.all(tracks.map(async (t) => {
        t.title = await trackTitle(t.files) || t.name.replace(/\.[^.]*$/, '');
    }));
    tracks.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.title.localeCompare(b.title));
}

async function openAnniversary(files, root) {
    const shared = files.filter((f) => f.path.toLowerCase() === root + SHARED_DIR.toLowerCase() + baseName(f.path).toLowerCase()
        && SHARED_FILES.includes(baseName(f.path).toLowerCase()));
    const tracks = choices(files, root, TRACK_DIRS, /\.zip$/);
    await Promise.all(tracks.map(async (t) => {
        t.files = readZip(await t.file.read());
    }));
    await titled(tracks, Object.values(TRACK_DIRS));
    const cars = choices(files, root, CAR_DIRS, /\.dat$/);
    if (!tracks.length || !cars.length)
        throw new Error('no map or no car in its TEREP and Extras folders: is it the 30th Anniversary Edition zip?');
    return { kind: 'anniversary', tracks, cars, textures: choices(files, root, CAR_TEXTURE_DIRS, /\.pcx$/), shared };
}

// The files of a track (one of tracks), from its zip.
export async function trackFiles(track) {
    return track.files;
}
