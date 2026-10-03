// SPDX-License-Identifier: GPL-3.0-or-later
// Media tab extras (froonty@catalin/features/media/lyrics.js): LRC
// parsing, the active line and its wake-ups, the lrclib lookup rules, the
// lyrics memory and the TrackList's upcoming songs. Pure; no network.

import {
    LyricsMemory, activeIndex, adjustOffset, catalogAlbum, lrclibMatch, lrclibUrl, lyricsFromText,
    nextVerseDelay, offsetLabel, parseLrc, queueRows, sidecarPath, upcomingIds,
} from '../../froonty@catalin/features/media/lyrics.js';
import {done, eq, ok, test} from './test.js';

test('L1 LRC tags, repeated tags, sorted, simultaneous lines joined', () => {
    const lines = parseLrc('[ar:Someone]\n[00:10.00][00:30.50]Chorus\n[00:05.00]Intro\n[00:10.00]Echo\n', 180);
    eq(lines, [
        {time: 5, text: 'Intro'},
        {time: 10, text: 'Chorus\nEcho'},
        {time: 30.5, text: 'Chorus'},
    ]);
    eq(parseLrc('[1:02.5]x', 180), [{time: 62.5, text: 'x'}]);
    eq(parseLrc('[00:61.0]bad seconds', 180), []);
});

test('L2 [offset:±ms] up to 60 s, applied as time − offset', () => {
    eq(parseLrc('[offset:+500]\n[00:10.00]a', 180), [{time: 9.5, text: 'a'}]);
    eq(parseLrc('[offset:-1500]\n[00:10.00]a', 180), [{time: 11.5, text: 'a'}]);
    eq(parseLrc('[offset:90000]\n[00:10.00]a', 180), [{time: 10, text: 'a'}], 'over 60 s is ignored');
    eq(parseLrc('[00:00.20]a\n[offset:500]', 180), [{time: 0, text: 'a'}], 'never before 0');
});

test('L3 an empty timed line is a ♪ gap', () => {
    eq(parseLrc('[00:01.00]a\n[00:05.00]\n[00:09.00]b', 180),
        [{time: 1, text: 'a'}, {time: 5, text: ''}, {time: 9, text: 'b'}]);
    eq(parseLrc('[00:01.00]\n[00:02.00]', 180), [], 'only gaps is no lyrics');
});

test('L4 2000 entries and 128 KiB of expanded text; more gives no lyrics', () => {
    const fine = Array.from({length: 2000}, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.00]l`).join('\n');
    eq(parseLrc(fine, 3600).length, 2000);
    eq(parseLrc(`${fine}\n[59:00.00]one more`, 3600), []);
    const tags = '[00:01.00]'.repeat(300);
    const long = `${tags}${'w'.repeat(500)}`;
    eq(parseLrc(long, 180), [], '300 copies of 500 bytes is over 128 KiB');
    eq(parseLrc('x'.repeat(130 * 1024), 180), []);
});

test('L5 untimed text is plain, never timed', () => {
    eq(lyricsFromText('Just words\nmore words', 180), {lines: [], plain: 'Just words\nmore words', instrumental: false});
    eq(lyricsFromText('[00:01.00]timed', 180).lines, [{time: 1, text: 'timed'}]);
    eq(lyricsFromText('   ', 180), null);
    eq(lyricsFromText(null, 180), null);
});

test('L6 active line by binary search with the user offset', () => {
    const lines = [{time: 5, text: 'a'}, {time: 10, text: 'b'}, {time: 20, text: 'c'}];
    eq([activeIndex(lines, 4), activeIndex(lines, 5), activeIndex(lines, 15), activeIndex(lines, 99)],
        [null, 0, 1, 2]);
    eq(activeIndex(lines, 10, 1), 0, 'a later offset holds the line back');
    eq(activeIndex(lines, 9, -1), 1, 'an earlier offset shows it sooner');
    eq(activeIndex(lines, NaN), null);
});

test('L7 next-verse wake only while playing with a position and a valid rate', () => {
    const lines = [{time: 5, text: 'a'}, {time: 10, text: 'b'}];
    const playback = {playing: true, hasPosition: true, rate: 1, positionS: 6, lengthS: 100};
    eq(nextVerseDelay(lines, playback), 4001);
    eq(nextVerseDelay(lines, {...playback, rate: 2}), 2001);
    eq(nextVerseDelay(lines, {...playback}, 1), 5001);
    eq(nextVerseDelay(lines, {...playback, playing: false}), null);
    eq(nextVerseDelay(lines, {...playback, hasPosition: false}), null);
    eq(nextVerseDelay(lines, {...playback, rate: 0}), null);
    eq(nextVerseDelay(lines, {...playback, positionS: 11}), null, 'no later verse');
});

test('L8 offset steps 0.25 s, ±10 s', () => {
    eq(adjustOffset(0, 0.25), 0.25);
    eq(adjustOffset(0.1, 0.25), 0.25, 'quantised');
    eq(adjustOffset(9.9, 0.25), 10);
    eq(adjustOffset(-9.9, -0.25), -10);
    eq([offsetLabel(0), offsetLabel(0.25), offsetLabel(-1.5)], ['+0.00', '+0.25', '−1.50']);
});

test('L9 lrclib URL preconditions; " - Single" and " - EP" dropped', () => {
    const track = {title: 'Song & Co', artist: 'Band', album: 'Hits - Single', lengthUs: 200.4e6};
    eq(lrclibUrl(track, 'https://lrclib.net/api/get'),
        'https://lrclib.net/api/get?track_name=Song%20%26%20Co&artist_name=Band&album_name=Hits&duration=200');
    eq(catalogAlbum('Thing - ep'), 'Thing');
    eq(catalogAlbum('Live - Deluxe'), 'Live - Deluxe');
    eq(lrclibUrl({...track, album: null}), null);
    eq(lrclibUrl({...track, artist: ''}), null);
    eq(lrclibUrl({...track, lengthUs: 0.4e6}), null);
    eq(lrclibUrl({...track, lengthUs: 3601e6}), null);
    eq(lrclibUrl({...track, title: 'x'.repeat(1025)}), null);
});

test('L10 lrclib match: case-insensitive exact title, artist, album; length within 2 s; 128 KiB cap', () => {
    const track = {title: 'Song', artist: 'Band', album: 'Hits - Single', lengthUs: 200e6};
    const answer = extra => JSON.stringify({
        trackName: 'song', artistName: 'BAND', albumName: 'Hits', duration: 201.5,
        plainLyrics: 'a\nb', syncedLyrics: '[00:01.00]a\n[00:02.00]b', instrumental: false, ...extra,
    });
    const match = lrclibMatch(answer(), track);
    eq([match.lines.length, match.plain], [2, 'a\nb']);
    eq(lrclibMatch(answer({trackName: 'Song (Live)'}), track), null);
    eq(lrclibMatch(answer({albumName: 'Other'}), track), null);
    eq(lrclibMatch(answer({duration: 203}), track), null);
    eq(lrclibMatch(answer({plainLyrics: '', syncedLyrics: ''}), track), null);
    eq(lrclibMatch(answer({instrumental: true}), track), {lines: [], plain: '', instrumental: true});
    eq(lrclibMatch('not json', track), null);
    eq(lrclibMatch(answer({plainLyrics: 'x'.repeat(130 * 1024)}), track), null);
});

test('L11 lyrics memory: one song; hiding keeps; a track change clears', () => {
    const memory = new LyricsMemory();
    memory.select('song-1');
    ok(memory.replace({lines: [], plain: 'x'}, 'song-1'));
    memory.adjust(0.25);
    memory.select('song-1');
    eq([memory.lyrics?.plain, memory.offset], ['x', 0.25], 'the same song keeps them');
    ok(!memory.replace({plain: 'y'}, 'song-0'), 'an old answer is not kept');
    memory.select('song-2');
    eq([memory.lyrics, memory.offset], [null, 0]);
});

test('L12 sidecar .lrc only for file:// urls', () => {
    eq(sidecarPath('file:///music/A%20Song.flac'), '/music/A Song.lrc');
    eq(sidecarPath('file:///music/noext'), '/music/noext.lrc');
    eq(sidecarPath('https://x.org/a.mp3'), null);
    eq(sidecarPath('file:///music/a.lrc'), null, 'never the song itself');
    eq(sidecarPath(null), null);
});

test('L13 queue decode: ≤20 after the current; duplicates, bad ids and an unknown current rejected', () => {
    const ids = Array.from({length: 30}, (_, i) => `/t/${i}`);
    eq(upcomingIds(ids, '/t/2').length, 20);
    eq(upcomingIds(ids, '/t/2')[0], '/t/3');
    eq(upcomingIds(ids, '/t/29'), []);
    eq(upcomingIds(['/a', '/a'], '/a'), null);
    eq(upcomingIds(['/a', 'bad id'], '/a'), null);
    eq(upcomingIds(['/a', '/b'], '/c'), null);
    eq(upcomingIds(['/a', '/b'], null), null);
    const rows = queueRows(['/b', '/c', '/d'], [
        {trackId: '/d', title: 'D', artist: 'x'},
        {trackId: '/b', title: 'B', artist: null},
        {trackId: '/c', title: null},
    ]);
    eq(rows, [
        {offset: 1, trackId: '/b', title: 'B', artist: null},
        {offset: 3, trackId: '/d', title: 'D', artist: 'x'},
    ]);
});

await done();
