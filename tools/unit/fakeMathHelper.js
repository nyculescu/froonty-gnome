// SPDX-License-Identifier: GPL-3.0-or-later
// A stand-in for the math renderer helper (features/formulas/renderer/
// helper.js) in formulas-client.test.js: the same JSON-lines protocol,
// no MathJax. What it does depends on the formula:
//
//   crash        exits before answering, every time
//   crash-once   exits before answering the first time (a marker file,
//                FAKE_MATH_MARKER, remembers), then answers
//   hang         never answers this one (the next ones wait behind it)
//   bad          answers with a TeX error
//   slow         answers after 300 ms
//   anything     answers with a 1 × 1 PNG; width counts the requests this
//                helper answered, so a test can tell what was sent
//
// Run as `gjs -m fakeMathHelper.js`; it ends when stdin closes.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import System from 'system';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');

// A transparent 1 × 1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

// System.exit() from a callback does not end gjs: main() returns the
// exit code, and the module ends the process once the loop stops.
async function main() {
    const input = new Gio.DataInputStream({
        base_stream: new GioUnix.InputStream({fd: 0, close_fd: false}),
    });
    const output = new GioUnix.OutputStream({fd: 1, close_fd: false});
    const reply = message => output.write_all(new TextEncoder().encode(`${JSON.stringify(message)}\n`), null);
    let answered = 0;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
        if (line === null)
            return 0;
        const {id, tex} = JSON.parse(new TextDecoder().decode(line));
        if (tex === 'crash')
            return 3;
        if (tex === 'crash-once') {
            const marker = GLib.getenv('FAKE_MATH_MARKER');
            if (!GLib.file_test(marker, GLib.FileTest.EXISTS)) {
                GLib.file_set_contents(marker, 'crashed');
                return 3;
            }
        }
        if (tex === 'hang') {
            // eslint-disable-next-line no-await-in-loop
            await new Promise(() => {});
        }
        if (tex === 'slow') {
            // eslint-disable-next-line no-await-in-loop
            await sleep(300);
        }
        answered++;
        if (tex === 'bad')
            reply({id, error: 'Missing close brace', kind: 'tex'});
        else
            reply({id, png: PNG, width: answered, height: 1, baseline: 0.5});
    }
}

const loop = new GLib.MainLoop(null, false);
let status = 1;
main().then(code => (status = code), e => printerr(e.message)).finally(() => loop.quit());
loop.run();
System.exit(status);
