// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    coreInputs, cpuPackageInput, driveName, findEfiMount, isSnapMount, loadPercent,
    parseCpuMhz, parseCpuModel, parseDiskMounts, parseMeminfo, parseNetDev, parseNvidiaSmi,
    parseStat, pciDeviceName, pciIdsLines, rate,
} from '../../froonty@catalin/features/sysmon/parse.js';
import {SYSTEM_IO} from '../../froonty@catalin/features/sysmon/io.js';
import {levelCells, levelClass} from '../../froonty@catalin/features/sysmon/level.js';
import {NvidiaLoop, nvidiaLoop} from '../../froonty@catalin/features/sysmon/nvidiaLoop.js';
import {Sampler, SECTIONS} from '../../froonty@catalin/features/sysmon/sampler.js';
import {SysmonService} from '../../froonty@catalin/features/sysmon/service.js';
import {
    PANIC_LOAD_KEY, PANIC_TEMP_KEY, PanicMetricsService, READOUTS_INTERVAL_KEY,
    ReadoutMetricsService, panicLoad, panicTemperature, temperatureColor,
} from '../../froonty@catalin/features/sysmon/panicMetrics.js';
import {done, eq, ok, sleep, test, waitFor} from './test.js';

const CPUINFO = `processor\t: 0
vendor_id\t: GenuineIntel
model name\t: 13th Gen Intel(R) Core(TM) i9-13980HX
cpu MHz\t\t: 3400.000

processor\t: 1
vendor_id\t: GenuineIntel
model name\t: 13th Gen Intel(R) Core(TM) i9-13980HX
cpu MHz\t\t: 1600.000
`;

const STAT = n => `cpu  ${100 + n} 0 ${100 + n} ${800 + 2 * n} 0 0 0 0 0 0
cpu0 ${50 + n} 0 50 400 0 0 0 0 0 0
cpu1 50 0 ${50 + n} ${400 + 2 * n} 0 0 0 0 0 0
intr 1 2 3
`;

const MEMINFO = `MemTotal:       16000000 kB
MemFree:         2000000 kB
MemAvailable:    6000000 kB
Buffers:          100000 kB
Cached:          3000000 kB
SwapTotal:       8000000 kB
SwapFree:        7000000 kB
SReclaimable:     400000 kB
`;

const NETDEV = (rx, tx) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0
enp1s0: ${rx} 10 0 0 0 0 0 0 ${tx} 10 0 0 0 0 0 0
docker0: 999 10 0 0 0 0 0 0 999 10 0 0 0 0 0 0
`;

const PCI_IDS = `# comment
8086  Intel Corporation
\ta788  Raptor Lake-S UHD Graphics
\t\t1043 1234  Some subsystem
10de  NVIDIA Corporation
\t27e0  AD104M [GeForce RTX 4080 Max-Q / Mobile]
1002  Advanced Micro Devices, Inc. [AMD/ATI]
\t744c  Navi 31 [Radeon RX 7900 XT/7900 XTX]
`;

test('CPU model loses trademark signs and the nominal clock', () => {
    eq(parseCpuModel(CPUINFO), '13th Gen Intel Core i9-13980HX');
    eq(parseCpuModel('model name\t: Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz\n'),
        'Intel Core i7-8700');
    eq(parseCpuModel('model name\t: AMD Ryzen 9 7950X 16-Core Processor\n'), 'AMD Ryzen 9 7950X');
    eq(parseCpuModel('flags: fpu\n'), null);
});

test('each logical CPU keeps its clock', () => {
    eq([...parseCpuMhz(CPUINFO)], [[0, 3400], [1, 1600]]);
    eq(parseCpuMhz('processor : 0\nBogoMIPS : 50\n').size, 0);
});

test('load is busy time over total time between two samples', () => {
    const a = parseStat(STAT(0));
    const b = parseStat(STAT(100));
    eq(a.all, {busy: 200, total: 1000});
    eq(a.cpus.size, 2);
    // 200 more busy jiffies out of 400 more in total.
    eq(loadPercent(a.all, b.all), 50);
    eq(loadPercent(a.cpus.get(0), b.cpus.get(0)), 100);
    eq(loadPercent(null, b.all), null);
    eq(loadPercent(a.all, a.all), null);
});

test('memory used is total minus available; cache is buff/cache', () => {
    const k = 1024;
    eq(parseMeminfo(MEMINFO), {
        total: 16000000 * k,
        used: 10000000 * k,
        cache: 3500000 * k,
        swapTotal: 8000000 * k,
        swapUsed: 1000000 * k,
    });
    eq(parseMeminfo('').used, null);
});

test('network counters by interface', () => {
    const counters = parseNetDev(NETDEV(100, 200));
    eq(counters.get('enp1s0'), {rx: 100, tx: 200});
    eq(counters.get('lo'), {rx: 5000, tx: 5000});
    eq(rate(100, 300, 2), 100);
    eq(rate(null, 300, 2), null);
    // A counter that went back (an interface gone) has no rate.
    eq(rate(300, 100, 2), null);
});

test('the EFI partition is a mounted FAT file system, never an automount', () => {
    eq(findEfiMount('/dev/nvme0n1p1 / ext4 rw 0 0\n/dev/nvme0n1p3 /boot/efi vfat rw 0 0\n'),
        '/boot/efi');
    eq(findEfiMount('systemd-1 /efi autofs rw 0 0\n'), null);
    eq(findEfiMount('/dev/sda1 /boot ext4 rw 0 0\n'), null);
});

test('mounted drives: block devices only, each once, names unescaped', () => {
    const mounts = [
        'proc /proc proc rw 0 0',
        'tmpfs /tmp tmpfs rw 0 0',
        '/dev/nvme0n1p2 /home btrfs rw,subvol=/home 0 0',
        '/dev/nvme0n1p2 / btrfs rw,subvol=/ 0 0',
        '/dev/sda /run/media/me/MY\\040STICK vfat rw 0 0',
        'systemd-1 /efi autofs rw 0 0',
        '/dev/loop3 /snap/core22/2987 squashfs ro 0 0',
        'gvfsd-fuse /run/user/1000/gvfs fuse.gvfsd-fuse rw 0 0',
    ].join('\n');
    const drives = parseDiskMounts(mounts);
    eq(drives.map(d => [d.source, d.target, d.type]), [
        ['/dev/nvme0n1p2', '/', 'btrfs'],
        ['/dev/sda', '/run/media/me/MY STICK', 'vfat'],
        ['/dev/loop3', '/snap/core22/2987', 'squashfs'],
    ]);
    eq(drives.map(isSnapMount), [false, false, true]);
    eq(driveName('/run/media/me/MY STICK'), 'MY STICK');
    eq(driveName('/media/me/JLINK'), 'JLINK');
    eq(driveName('/srv/shared'), '/srv/shared');
});

test('CPU temperature inputs by chip and label', () => {
    const labels = new Map([['temp1_input', 'Package id 0'], ['temp2_input', 'Core 0'],
        ['temp6_input', 'Core 4']]);
    eq(cpuPackageInput('coretemp', labels), 'temp1_input');
    eq([...coreInputs(labels)], [[0, 'temp2_input'], [4, 'temp6_input']]);
    eq(cpuPackageInput('k10temp', new Map([['temp1_input', 'Tctl'], ['temp3_input', 'Tccd1']])),
        'temp1_input');
    eq(cpuPackageInput('k10temp', new Map([['temp3_input', 'Tccd1'], ['temp2_input', 'Tdie']])),
        'temp2_input');
    eq(cpuPackageInput('cpu_thermal', new Map([['temp1_input', null]])), 'temp1_input');
});

test('GPU names from pci.ids, marketing name first', () => {
    eq(pciDeviceName(PCI_IDS, '0x8086', '0xa788'), 'Intel Raptor Lake-S UHD Graphics');
    eq(pciDeviceName(PCI_IDS, '0x10de', '0x27e0'), 'NVIDIA GeForce RTX 4080 Max-Q / Mobile');
    eq(pciDeviceName(PCI_IDS, '0x1002', '0x744c'), 'AMD Radeon RX 7900 XT/7900 XTX');
    // Device ids are looked up in their own vendor's block only.
    eq(pciDeviceName(PCI_IDS, '0x10de', '0xa788'), null);
    eq(pciDeviceName(PCI_IDS, '0x1234', '0x0001'), null);
});

test('pci.ids: only the vendor\'s and the device\'s lines are decoded, giving the same name', () => {
    const blocks = `${PCI_IDS}10df  Another vendor
\t0001  First
# a comment inside the block

\t27e0  After a comment and a blank line
10e0  The next vendor
\t27e0  Not 10df's
`;
    const bytes = new TextEncoder().encode(blocks);
    eq(pciIdsLines(bytes, '0x10de', '0x27e0'),
        '10de  NVIDIA Corporation\n\t27e0  AD104M [GeForce RTX 4080 Max-Q / Mobile]\n');
    const pairs = [['0x8086', '0xa788'], ['0x10de', '0x27e0'], ['0x1002', '0x744c'], ['0x10DE', '0x27E0'],
        ['0x10df', '0x27e0'], ['0x10e0', '0x27e0']];
    for (const [vendor, device] of pairs) {
        eq(pciDeviceName(pciIdsLines(bytes, vendor, device), vendor, device),
            pciDeviceName(blocks, vendor, device), `${vendor}:${device}`);
    }
    eq(pciDeviceName(pciIdsLines(bytes, '0x10df', '0x27e0'), '0x10df', '0x27e0'),
        'After a comment and a blank line');
    // Another vendor's device, a subsystem line, an unknown vendor.
    eq(pciIdsLines(bytes, '0x10de', '0xa788'), null);
    eq(pciIdsLines(bytes, '0x8086', '0x1043'), null);
    eq(pciIdsLines(bytes, '0x1234', '0x0001'), null);
    eq(pciIdsLines(new Uint8Array(0), '0x10de', '0x27e0'), null);
});

test('nvidia-smi rows by sysfs PCI address; N/A is unknown', () => {
    const gpus = parseNvidiaSmi(
        '00000000:01:00.0, NVIDIA GeForce RTX 4080 Laptop GPU, 8, 52, 15.38, 1664, 12282\n' +
        '00000000:41:00.0, NVIDIA RTX A6000, [N/A], 40, [Not Supported], 10, 49140\n');
    eq(gpus.get('0000:01:00.0'), {
        name: 'NVIDIA GeForce RTX 4080 Laptop GPU',
        load: 8,
        temp: 52,
        power: 15.38,
        memUsed: 1664 * 1024 * 1024,
        memTotal: 12282 * 1024 * 1024,
    });
    eq(gpus.get('0000:41:00.0').load, null);
    eq(gpus.get('0000:41:00.0').power, null);
    eq(parseNvidiaSmi('').size, 0);
});

test('levels: one cell per 20%, green to red', () => {
    const glyphs = fraction => levelCells(fraction).map(cell => cell.glyph).join('');
    eq(glyphs(0), '_____');
    eq(glyphs(0.2), '▂____');
    eq(glyphs(0.4), '▂▄___');
    eq(glyphs(0.6), '▂▄▆__');
    eq(glyphs(0.8), '▂▄▆▇_');
    eq(glyphs(1), '▂▄▆▇█');
    eq(glyphs(1.5), '▂▄▆▇█');
    eq(levelCells(1).map(cell => cell.styleClass), [1, 2, 3, 4, 5].map(n => `froonty-sysmon-cell-${n}`));
    eq(levelCells(0.2)[1].styleClass, 'froonty-sysmon-cell-empty');
});

test('levels: a whole number takes the colour of its 20% band (the CPU load button)', () => {
    const cell = percent => Number(levelClass(percent).at(-1));
    eq([0, 19, 20, 39, 40, 59, 60, 79, 80, 99, 100].map(cell), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5]);
    eq(cell(-3), 1, 'below 0');
    eq(cell(140), 5, 'over 100');
});

test('panic metrics: load source reports one selected CPU, GPU or RAM value', () => {
    const snapshot = {
        cpu: {load: 41},
        gpus: [{load: null}, {load: 68}, {load: 32}],
        memory: {used: 75, total: 100},
    };
    eq(panicLoad(snapshot, 'cpu'), 41);
    eq(panicLoad(snapshot, 'gpu'), 68);
    eq(panicLoad(snapshot, 'memory'), 75);
    eq(panicLoad({}, 'gpu'), null);
});

test('panic thermometer: CPU average/max and GPU in °C; linked RAM falls back to CPU', () => {
    const snapshot = {
        cpu: {temp: 61, cores: [{temp: 55}, {temp: 58}, {temp: null}]},
        gpus: [{temp: 48}, {temp: 66}],
        memory: {used: 75, total: 100},
    };
    eq(panicTemperature(snapshot, 'average-cpu', 'cpu'), 56.5);
    eq(panicTemperature(snapshot, 'max-cpu', 'cpu'), 58);
    eq(panicTemperature(snapshot, 'gpu', 'cpu'), 66);
    eq(panicTemperature(snapshot, 'load-source', 'gpu'), 66);
    eq(panicTemperature(snapshot, 'load-source', 'memory'), 56.5);
    eq(panicTemperature({cpu: {temp: 61}}, 'average-cpu', 'cpu'), 61);
});

test('thermometer colors are green through 50, yellow at 75, and red at 100', () => {
    eq(temperatureColor(30), 'rgb(51, 209, 122)');
    eq(temperatureColor(50), 'rgb(51, 209, 122)');
    eq(temperatureColor(75), 'rgb(246, 211, 45)');
    eq(temperatureColor(100), 'rgb(224, 27, 36)');
});

// A fake /proc and /sys: `files` maps paths to text, `links` to targets.
// Directory listings come from the paths under them. `reads` records the
// files read and folders listed. follow() starts a fake nvidia-smi that
// prints `smi` at once; a test prints more with emit() and ends it with
// end().
function fakeIo({files = {}, links = {}, executables = [], filesystems = {}, smi = null}) {
    const calls = [];
    const followed = [];
    const reads = [];
    const io = {
        read: async path => {
            reads.push(path);
            return files[path] ?? null;
        },
        readBytes: async path => {
            reads.push(path);
            const text = files[path] ?? null;
            return text === null ? null : new TextEncoder().encode(text);
        },
        list: async dir => {
            reads.push(dir);
            const names = new Set();
            for (const path of [...Object.keys(files), ...Object.keys(links)]) {
                if (path.startsWith(`${dir}/`))
                    names.add(path.slice(dir.length + 1).split('/')[0]);
            }
            return [...names];
        },
        link: async path => links[path] ?? null,
        exists: async path => path in files || Object.keys(files).some(p => p.startsWith(`${path}/`)),
        executable: async path => executables.includes(path),
        filesystem: async path => filesystems[path] ?? null,
        run: async argv => {
            calls.push(argv);
            return smi;
        },
        follow: (argv, onLines, onEnd) => {
            const process = {
                argv,
                stopped: false,
                emit: text => {
                    if (!process.stopped)
                        onLines(text.split('\n').filter(Boolean));
                },
                end: () => {
                    if (process.stopped)
                        return;
                    process.stopped = true;
                    onEnd();
                },
                stop: () => {
                    process.stopped = true;
                },
            };
            followed.push(process);
            if (smi)
                Promise.resolve().then(() => process.emit(smi));
            return process;
        },
    };
    return {io, calls, followed, reads};
}

const DRM = '/sys/class/drm';
const MACHINE = {
    files: {
        '/proc/cpuinfo': CPUINFO,
        '/proc/meminfo': MEMINFO,
        '/proc/self/mounts': '/dev/a / ext4 rw 0 0\n/dev/b /boot/efi vfat rw 0 0\n',
        '/sys/devices/system/cpu/cpu0/topology/core_id': '0\n',
        '/sys/devices/system/cpu/cpu1/topology/core_id': '4\n',
        '/sys/class/hwmon/hwmon0/name': 'acpitz\n',
        '/sys/class/hwmon/hwmon0/temp1_input': '30000\n',
        '/sys/class/hwmon/hwmon1/name': 'coretemp\n',
        '/sys/class/hwmon/hwmon1/temp1_input': '61000\n',
        '/sys/class/hwmon/hwmon1/temp1_label': 'Package id 0\n',
        '/sys/class/hwmon/hwmon1/temp2_input': '55000\n',
        '/sys/class/hwmon/hwmon1/temp2_label': 'Core 0\n',
        '/sys/class/hwmon/hwmon1/temp6_input': '58000\n',
        '/sys/class/hwmon/hwmon1/temp6_label': 'Core 4\n',
        [`${DRM}/card1/device/vendor`]: '0x8086\n',
        [`${DRM}/card1/device/device`]: '0xa788\n',
        [`${DRM}/card1/gt_act_freq_mhz`]: '650\n',
        [`${DRM}/card2/device/vendor`]: '0x10de\n',
        [`${DRM}/card2/device/device`]: '0x27e0\n',
        [`${DRM}/card2/device/power/runtime_status`]: 'active\n',
        [`${DRM}/card3/device/vendor`]: '0x1002\n',
        [`${DRM}/card3/device/device`]: '0x744c\n',
        [`${DRM}/card3/device/gpu_busy_percent`]: '37\n',
        [`${DRM}/card3/device/mem_info_vram_used`]: '1073741824\n',
        [`${DRM}/card3/device/mem_info_vram_total`]: '25769803776\n',
        [`${DRM}/card3/device/hwmon/hwmon9/temp1_input`]: '48000\n',
        [`${DRM}/card3/device/hwmon/hwmon9/power1_average`]: '75000000\n',
        // A connector, not a card.
        [`${DRM}/card1-eDP-1/status`]: 'connected\n',
        '/sys/class/net/enp1s0/device/vendor': '0x10ec\n',
        '/usr/share/hwdata/pci.ids': PCI_IDS,
    },
    links: {
        [`${DRM}/card1/device`]: '../../../0000:00:02.0',
        [`${DRM}/card1/device/driver`]: '../../../bus/pci/drivers/i915',
        [`${DRM}/card2/device`]: '../../../0000:01:00.0',
        [`${DRM}/card2/device/driver`]: '../../../bus/pci/drivers/nvidia',
        [`${DRM}/card3/device`]: '../../../0000:03:00.0',
        [`${DRM}/card3/device/driver`]: '../../../bus/pci/drivers/amdgpu',
    },
    executables: ['/usr/bin/nvidia-smi'],
    filesystems: {
        '/': {total: 1000, used: 400},
        '/boot/efi': {total: 100, used: 5},
    },
    smi: '00000000:01:00.0, NVIDIA GeForce RTX 4080 Laptop GPU, 8, 52, 15.38, 1664, 12282\n',
};

function machine(changes = {}) {
    return {...MACHINE, ...changes, files: {...MACHINE.files, ...changes.files}};
}

async function twoSamples(spec, sections = SECTIONS, cores = false) {
    const fake = fakeIo(spec);
    const sampler = new Sampler(fake.io);
    spec.files['/proc/stat'] = STAT(0);
    spec.files['/proc/net/dev'] = NETDEV(1000, 2000);
    const first = await sampler.sample(sections, {cores, now: 10});
    spec.files['/proc/stat'] = STAT(100);
    spec.files['/proc/net/dev'] = NETDEV(5000, 3000);
    const second = await sampler.sample(sections, {cores, now: 12});
    return {first, second, calls: fake.calls};
}

test('the first sample has no load or speed; the second does', async () => {
    const {first, second} = await twoSamples(machine());
    eq(first.cpu.load, null);
    eq(first.network.down, null);
    eq(second.cpu.load, 50);
    eq(second.cpu.model, '13th Gen Intel Core i9-13980HX');
    eq(second.cpu.ghz, 2.5);
    eq(second.cpu.temp, 61);
    eq(second.cpu.threads, 2);
    eq(second.cpu.cores, null);
    // Physical interfaces only: not lo, not docker0.
    eq(second.network, {down: 2000, up: 500, downTotal: 5000, upTotal: 3000});
});

test('each thread has its load and its core temperature', async () => {
    const {second} = await twoSamples(machine(), ['cpu'], true);
    eq(second.cpu.cores, [
        {cpu: 0, core: 0, load: 100, ghz: 3.4, temp: 55},
        {cpu: 1, core: 4, load: 33.333333333333336, ghz: 1.6, temp: 58},
    ]);
});

test('GPUs: Intel by clock, NVIDIA by nvidia-smi, AMD by sysfs', async () => {
    const {second, calls} = await twoSamples(machine(), ['gpu']);
    eq(second.gpus.map(gpu => gpu.name), ['Intel Raptor Lake-S UHD Graphics',
        'NVIDIA GeForce RTX 4080 Laptop GPU', 'AMD Radeon RX 7900 XT/7900 XTX']);
    eq(second.gpus[0].mhz, 650);
    eq(second.gpus[0].load, null);
    eq(second.gpus[1].load, 8);
    eq(second.gpus[1].power, 15.38);
    eq(second.gpus[2].load, 37);
    eq(second.gpus[2].temp, 48);
    eq(second.gpus[2].power, 75);
    eq(second.gpus[2].memTotal, 25769803776);
    // Only the awake NVIDIA card, by address, from the fixed path.
    eq(calls.length, 2);
    eq(calls[0][0], '/usr/bin/nvidia-smi');
    eq(calls[0].slice(-2), ['-i', '0000:01:00.0']);
});

test('a sleeping NVIDIA card is not woken up', async () => {
    const {second, calls} = await twoSamples(machine({files: {
        [`${DRM}/card2/device/power/runtime_status`]: 'suspended\n',
    }}), ['gpu']);
    eq(calls.length, 0);
    eq(second.gpus[1].asleep, true);
    eq(second.gpus[1].load, null);
});

test('without nvidia-smi, the NVIDIA card says what is missing', async () => {
    const {second, calls} = await twoSamples({...machine(), executables: []}, ['gpu']);
    eq(calls.length, 0);
    eq(second.gpus[1].noTool, true);
});

test('GPUs and the CPU are found only once a sample reads them', async () => {
    const fake = fakeIo(machine());
    const sampler = new Sampler(fake.io);
    await sampler.sample(['memory'], {now: 1});
    ok(!fake.reads.some(path => path.startsWith(DRM)), 'no GPU discovery');
    ok(!fake.reads.includes('/usr/share/hwdata/pci.ids'), 'no pci.ids');
    ok(!fake.reads.includes('/sys/devices/system/cpu'), 'no CPU discovery');
    const snapshot = await sampler.sample(['gpu'], {now: 2});
    eq(snapshot.gpus.length, 3);
    ok(fake.reads.includes('/usr/share/hwdata/pci.ids'));
});

test('pci.ids is read once per io, whatever the samplers and visits', async () => {
    const fake = fakeIo(machine());
    const pciReads = () => fake.reads.filter(path => path.endsWith('/pci.ids')).length;
    const first = new Sampler(fake.io);
    await first.sample(['gpu'], {now: 1});
    first.reset();
    await first.sample(['gpu'], {now: 2});
    const other = await new Sampler(fake.io).sample(['gpu'], {now: 3});
    eq(pciReads(), 1);
    eq(other.gpus.map(gpu => gpu.name), ['Intel Raptor Lake-S UHD Graphics',
        'NVIDIA GeForce RTX 4080 Laptop GPU', 'AMD Radeon RX 7900 XT/7900 XTX']);
    // Another io (a test's fake with another pci.ids) has names of its own.
    const renamed = fakeIo(machine({files: {
        '/usr/share/hwdata/pci.ids': '8086  Intel Corporation\n\ta788  Another name\n',
    }}));
    eq((await new Sampler(renamed.io).sample(['gpu'], {now: 1})).gpus[0].name, 'Intel Another name');
});

// card2 lights the laptop's panel, so it cannot sleep.
const LIT = {
    [`${DRM}/card2-eDP-1/status`]: 'connected\n',
    [`${DRM}/card2-eDP-1/enabled`]: 'enabled\n',
    [`${DRM}/card2-DP-3/status`]: 'disconnected\n',
    [`${DRM}/card2-DP-3/enabled`]: 'disabled\n',
};
const smiLine = load => `00000000:01:00.0, NVIDIA GeForce RTX 4080 Laptop GPU, ${load}, 52, 15.38, 1664, 12282\n`;

test('a card that cannot sleep is read from one nvidia-smi -lms, not a run per sample', async () => {
    const fake = fakeIo(machine({files: LIT}));
    const sampler = new Sampler(fake.io);
    const first = await sampler.sample(['gpu'], {now: 1, interval: 2});
    eq(first.gpus[1].load, 8, 'it waits for the first line');
    eq(first.gpus[1].name, 'NVIDIA GeForce RTX 4080 Laptop GPU');
    eq(fake.calls.length, 0);
    eq(fake.followed.length, 1);
    eq(fake.followed[0].argv[0], '/usr/bin/nvidia-smi');
    eq(fake.followed[0].argv.slice(-4), ['-i', '0000:01:00.0', '-lms', '2000']);
    fake.followed[0].emit(smiLine(30));
    const second = await sampler.sample(['gpu'], {now: 3, interval: 2});
    eq(second.gpus[1].load, 30, 'the latest line');
    eq(fake.followed.length, 1, 'still the one process');
    sampler.release();
    ok(fake.followed[0].stopped, 'killed when the last sampler lets go');
    ok(!nvidiaLoop(fake.io).running);
});

test('runtime power management off counts as cannot sleep', async () => {
    const fake = fakeIo(machine({files: {[`${DRM}/card2/device/power/control`]: 'on\n'}}));
    const sampler = new Sampler(fake.io);
    await sampler.sample(['gpu'], {now: 1, interval: 1});
    eq(fake.followed.length, 1);
    eq(fake.calls.length, 0);
    sampler.release();
});

test('a card that can sleep is still read by one run per sample', async () => {
    const fake = fakeIo(machine({files: {...LIT, [`${DRM}/card2-eDP-1/enabled`]: 'disabled\n'}}));
    await new Sampler(fake.io).sample(['gpu'], {now: 1, interval: 2});
    eq(fake.followed.length, 0, 'a connected panel it does not light');
    eq(fake.calls.length, 1);
    // Without an interval (a caller that never releases), never followed.
    const unlit = fakeIo(machine({files: LIT}));
    await new Sampler(unlit.io).sample(['gpu'], {now: 1});
    eq(unlit.followed.length, 0);
    eq(unlit.calls.length, 1);
});

test('a display switched off lets the card sleep again: the loop stops', async () => {
    const spec = machine({files: LIT});
    const fake = fakeIo(spec);
    const sampler = new Sampler(fake.io);
    await sampler.sample(['gpu'], {now: 1, interval: 2});
    spec.files[`${DRM}/card2-eDP-1/enabled`] = 'disabled\n';
    const snapshot = await sampler.sample(['gpu'], {now: 3, interval: 2});
    ok(fake.followed[0].stopped);
    eq(fake.calls.length, 1, 'read by a run again');
    eq(snapshot.gpus[1].load, 8);
});

test('samplers share one nvidia-smi at the shortest interval; the last release kills it', async () => {
    const fake = fakeIo(machine({files: LIT}));
    const slow = new Sampler(fake.io);
    const quick = new Sampler(fake.io);
    await slow.sample(['gpu'], {now: 1, interval: 5});
    await quick.sample(['gpu'], {now: 1, interval: 1});
    eq(fake.followed.map(p => [p.argv.at(-1), p.stopped]), [['5000', true], ['1000', false]]);
    quick.release();
    eq(fake.followed.map(p => [p.argv.at(-1), p.stopped]),
        [['5000', true], ['1000', true], ['5000', false]], 'back to the slow one');
    await slow.sample(['gpu'], {now: 6, interval: 5});
    eq(fake.followed.length, 3, 'a sample that changes nothing restarts nothing');
    await slow.sample(['memory'], {now: 11, interval: 5});
    ok(fake.followed.every(p => p.stopped), 'a sample without the GPU lets go');
    ok(!nvidiaLoop(fake.io).running);
});

test('a sample cancelled meanwhile does not hold the loop after its caller let go', async () => {
    const fake = fakeIo(machine({files: LIT}));
    const sampler = new Sampler(fake.io);
    await sampler.sample(['gpu'], {now: 1, interval: 2});
    const cancellable = new Gio.Cancellable();
    const read = fake.io.read;
    // The caller goes inactive while the sample checks whether the card can sleep.
    fake.io.read = path => {
        if (path === `${DRM}/card2/device/power/control` && !cancellable.is_cancelled()) {
            cancellable.cancel();
            sampler.release();
        }
        return read(path);
    };
    eq(await sampler.sample(['gpu'], {now: 3, interval: 2, cancellable}), null);
    ok(!nvidiaLoop(fake.io).running);
    eq(fake.followed.length, 1);
});

test('the loop: lines go stale after two intervals; an exit nobody asked for starts it again, later each time', async () => {
    let now = 0;
    const fake = fakeIo({});
    const loop = new NvidiaLoop(fake.io, {now: () => now, firstRetryMs: 20, maxRetryMs: 40});
    const holder = {};
    const address = ['0000:01:00.0'];
    loop.hold(holder, {path: '/usr/bin/nvidia-smi', addresses: address, intervalMs: 1000});
    const waiting = loop.read(address);
    fake.followed[0].emit(smiLine(8));
    eq((await waiting).get('0000:01:00.0').load, 8, 'a read waits for the first lines');
    now = 2000;
    eq((await loop.read(address)).get('0000:01:00.0').load, 8, 'two intervals old');
    now = 2001;
    eq((await loop.read(address)).size, 0, 'older is no reading, and no wait');

    fake.followed[0].end();
    ok(!loop.running);
    ok(await waitFor(() => fake.followed.length === 2), 'started again');
    // An error message is a line, not a reading: the next wait still doubles.
    fake.followed[1].emit('Failed to initialize NVML: Driver/library version mismatch');
    const ended = GLib.get_monotonic_time();
    fake.followed[1].end();
    ok(await waitFor(() => fake.followed.length === 3));
    ok(GLib.get_monotonic_time() - ended >= 40 * 1000, 'after twice as long');
    fake.followed[2].emit(smiLine(9));
    eq(loop._retryMs, 20, 'a reading makes the next wait short again');

    const cancellable = new Gio.Cancellable();
    loop.hold(holder, {path: '/usr/bin/nvidia-smi', addresses: address, intervalMs: 500});
    eq(fake.followed.length, 4, 'a new interval starts it anew');
    // The last line stale, the new process not yet stalled.
    now = 5000;
    const cancelled = loop.read(address, cancellable);
    cancellable.cancel();
    eq((await cancelled).size, 0, 'a cancelled wait ends at once');

    fake.followed[3].end();
    loop.release(holder);
    ok(fake.followed.every(p => p.stopped));
    ok(!loop.running);
    eq(loop._retryId, 0, 'no start again after the last release');
});

test('the loop: a read waiting for a process that was replaced ends when the new one cannot start', async () => {
    const fake = fakeIo({});
    const loop = new NvidiaLoop(fake.io, {firstRetryMs: 60000});
    const holder = {};
    const address = ['0000:01:00.0'];
    loop.hold(holder, {path: '/usr/bin/nvidia-smi', addresses: address, intervalMs: 1000});
    const waiting = loop.read(address);
    const follow = fake.io.follow;
    fake.io.follow = () => null;
    loop.hold(holder, {path: '/usr/bin/nvidia-smi', addresses: address, intervalMs: 500});
    ok(!loop.running);
    const result = await Promise.race([waiting, sleep(1000).then(() => 'still waiting')]);
    eq(result instanceof Map ? result.size : result, 0, 'it ends at once, with no reading');
    fake.io.follow = follow;
    loop.release(holder);
    eq(loop._retryId, 0);
});

test('the loop: one that stops writing is killed and started again', async () => {
    let now = 0;
    const fake = fakeIo({});
    const loop = new NvidiaLoop(fake.io, {now: () => now, waitMs: 50, firstRetryMs: 20, maxRetryMs: 40});
    const holder = {};
    const address = ['0000:01:00.0'];
    loop.hold(holder, {path: '/usr/bin/nvidia-smi', addresses: address, intervalMs: 1000});
    fake.followed[0].emit(smiLine(8));
    now = 3000;
    await loop.read(address);
    ok(!fake.followed[0].stopped, 'three intervals without a line is not a stall yet');
    now = 3001;
    eq((await loop.read(address)).size, 0, 'no reading, and no wait');
    ok(fake.followed[0].stopped, 'killed');
    ok(await waitFor(() => fake.followed.length === 2), 'started again');
    loop.release(holder);
    ok(fake.followed.every(p => p.stopped));
    eq(loop._retryId, 0);
});

test('a card found able to sleep is let go by every sampler at once', async () => {
    const spec = machine({files: LIT});
    const fake = fakeIo(spec);
    const quick = new Sampler(fake.io);
    const slow = new Sampler(fake.io);
    await quick.sample(['gpu'], {now: 1, interval: 2});
    await slow.sample(['gpu'], {now: 1, interval: 5});
    ok(nvidiaLoop(fake.io).running);
    spec.files[`${DRM}/card2-eDP-1/enabled`] = 'disabled\n';
    await quick.sample(['gpu'], {now: 3, interval: 2});
    ok(!nvidiaLoop(fake.io).running, 'stopped before the slow sampler looks again');
    ok(fake.followed.every(p => p.stopped));
    slow.release();
});

test('disks: root, swap from meminfo, the EFI partition', async () => {
    const {second} = await twoSamples(machine(), ['disks']);
    eq(second.disks.root, {total: 1000, used: 400});
    eq(second.disks.swap, {total: 8000000 * 1024, used: 1000000 * 1024});
    eq(second.disks.drives.map(d => [d.path, d.role, d.total, d.used]),
        [['/', 'root', 1000, 400], ['/boot/efi', 'efi', 100, 5]]);
    eq(second.disks.snaps, null);
});

// This laptop on 2026-11-13: a J-Link and an ST-LINK board plugged in,
// a Windows partition, a disk image and two snaps.
const DRIVES = machine({
    files: {
        '/proc/self/mounts': [
            '/dev/nvme0n1p1 / ext4 rw 0 0',
            '/dev/nvme0n1p3 /boot/efi vfat rw 0 0',
            '/dev/nvme1n1p3 /run/media/me/Windows ntfs3 rw 0 0',
            '/dev/sdb /run/media/me/JLINK vfat rw 0 0',
            '/dev/sda /run/media/me/DIS_F413ZH vfat rw 0 0',
            '/dev/loop40 /mnt/iso iso9660 ro 0 0',
            '/dev/loop1 /snap/snapd/28254 squashfs ro 0 0',
            '/dev/loop2 /snap/core22/2987 squashfs ro 0 0',
        ].join('\n'),
        '/sys/class/block/nvme0n1p1/partition': '1\n',
        '/sys/class/block/nvme0n1p3/partition': '3\n',
        '/sys/class/block/nvme1n1p3/partition': '3\n',
        '/sys/class/block/nvme0n1/device/model': 'KINGSTON SKC3000S1024G   \n',
        '/sys/class/block/nvme1n1/device/model': 'SAMSUNG MZVL21T0HCLR-00B00\n',
        '/sys/class/block/sda/device/vendor': 'MBED    \n',
        '/sys/class/block/sda/device/model': 'microcontroller \n',
        '/sys/class/block/sdb/device/vendor': 'SEGGER  \n',
        '/sys/class/block/sdb/device/model': 'MSD Volume      \n',
        '/sys/class/block/loop40/loop/backing_file': '/home/me/Downloads/ubuntu.iso\n',
    },
});
DRIVES.links = {
    ...MACHINE.links,
    '/sys/class/block/nvme0n1p1': '../../devices/pci0000:00/0000:6c:00.0/nvme/nvme0/nvme0n1/nvme0n1p1',
    '/sys/class/block/nvme0n1p3': '../../devices/pci0000:00/0000:6c:00.0/nvme/nvme0/nvme0n1/nvme0n1p3',
    '/sys/class/block/nvme1n1p3': '../../devices/pci0000:00/0000:6d:00.0/nvme/nvme1/nvme1n1/nvme1n1p3',
    '/sys/class/block/sda': '../../devices/pci0000:00/0000:00:14.0/usb1/1-1/1-1.4/host1/block/sda',
    '/sys/class/block/sdb': '../../devices/pci0000:00/0000:00:14.0/usb1/1-1/1-1.2/host0/block/sdb',
};
DRIVES.filesystems = {
    '/': {total: 1000, used: 400},
    '/boot/efi': {total: 100, used: 5},
    '/run/media/me/Windows': {total: 900, used: 300},
    '/run/media/me/JLINK': {total: 11, used: 1},
    '/run/media/me/DIS_F413ZH': {total: 5, used: 0},
    '/mnt/iso': {total: 50, used: 50},
    '/snap/snapd/28254': {total: 45, used: 45},
    '/snap/core22/2987': {total: 74, used: 74},
};

test('disks: every mounted drive, its size, virtual ones marked and last', async () => {
    const {second} = await twoSamples(DRIVES, ['disks']);
    eq(second.disks.drives.map(d => [d.name, d.role, d.total, d.virtual, d.probe ?? d.image ?? d.model]), [
        ['/', 'root', 1000, null, 'KINGSTON SKC3000S1024G'],
        ['/boot/efi', 'efi', 100, null, 'KINGSTON SKC3000S1024G'],
        ['Windows', null, 900, null, 'SAMSUNG MZVL21T0HCLR-00B00'],
        ['/mnt/iso', null, 50, 'image', 'ubuntu.iso'],
        ['DIS_F413ZH', null, 5, 'probe', 'MBED'],
        ['JLINK', null, 11, 'probe', 'SEGGER'],
    ]);
    eq(second.disks.drives.filter(d => d.usb).map(d => d.name), ['DIS_F413ZH', 'JLINK']);
    eq(second.disks.snaps, {count: 2, total: 119});
});

test('sections that are off are not read', async () => {
    const fake = fakeIo(machine());
    const sampler = new Sampler(fake.io);
    const snapshot = await sampler.sample(['memory'], {now: 1});
    eq(Object.keys(snapshot), ['memory']);
    ok(!fake.reads.includes('/proc/stat'));
    ok(!fake.reads.includes('/proc/net/dev'));
    eq(fake.calls.length, 0);
    eq(fake.followed.length, 0);
});

// Just what SysmonService uses of Gio.Settings.
function fakeSettings(values) {
    const handlers = new Map();
    let nextId = 1;
    const changed = key => {
        for (const [, {signal, fn}] of handlers) {
            if (signal === `changed::${key}`)
                fn();
        }
    };
    return {
        get_boolean: key => values[key] ?? true,
        get_int: key => values[key] ?? 2,
        get_string: key => values[key] ?? '',
        set_boolean: (key, value) => {
            values[key] = value;
            changed(key);
        },
        set_string: (key, value) => {
            values[key] = value;
            changed(key);
        },
        connect: (signal, fn) => {
            handlers.set(nextId, {signal, fn});
            return nextId++;
        },
        disconnect: id => handlers.delete(id),
        handlers,
    };
}

test('panic sampler reads the union of the selected load and thermometer sources', () => {
    const settings = fakeSettings({
        [PANIC_LOAD_KEY]: 'gpu',
        [PANIC_TEMP_KEY]: 'average-cpu',
    });
    const service = new PanicMetricsService(settings, {io: fakeIo(machine()).io});
    service.start();
    eq([...service.sections].sort(), ['cpu', 'gpu']);
    settings.set_string(PANIC_TEMP_KEY, 'load-source');
    eq([...service.sections], ['gpu']);
    settings.set_string(PANIC_LOAD_KEY, 'memory');
    eq([...service.sections].sort(), ['cpu', 'memory']);
    service.stop();
    eq(settings.handlers.size, 0);
});

test('the readouts\' sampler reads only what they need, at their own interval, while shown', async () => {
    const settings = fakeSettings({[READOUTS_INTERVAL_KEY]: 7});
    const service = new ReadoutMetricsService(settings, {io: fakeIo(machine()).io, now: () => 1});
    eq(service.interval, 7);

    service.setActive(true);
    await sleep(0);
    eq(service.samples, 0, 'nothing chosen, nothing read');
    eq(service._timeoutId, 0);

    service.setNeeds(['memory'], false);
    ok(await waitFor(() => service.samples > 0), 'chosen, it reads');
    eq(Object.keys(service.snapshot), ['memory']);
    eq(service._timeoutId !== 0, true, 'a next reading is due');

    service.setActive(false);
    eq(service._timeoutId, 0);
    eq(service.samples, 0);
    service.stop();
    eq(settings.handlers.size, 0);
});

test('the service polls only while its tab is on screen', async () => {
    const settings = fakeSettings({'sysmon-cores-expanded': false});
    const service = new SysmonService(settings, {io: fakeIo(machine()).io, now: () => 1});
    service.start();
    eq(service.polling, false);
    service.setActive(true);
    eq(service.polling, true);
    ok(service._followUpId !== 0, 'a quick second sample is due');
    service.setActive(false);
    eq(service.polling, false);
    eq(service._followUpId, 0);
    service.stop();
    eq(settings.handlers.size, 0);
});

test('with every section off, nothing is polled', () => {
    const values = {'sysmon-cores-expanded': false};
    for (const section of SECTIONS)
        values[`sysmon-show-${section}`] = false;
    const service = new SysmonService(fakeSettings(values), {io: fakeIo(machine()).io});
    service.start();
    service.setActive(true);
    eq(service.sections, []);
    eq(service.polling, false);
    service.stop();
});

test('a sample taken for a visit that ended is dropped', async () => {
    const spec = machine({files: {'/proc/stat': STAT(0), '/proc/net/dev': NETDEV(1, 1)}});
    const service = new SysmonService(fakeSettings({'sysmon-cores-expanded': false}),
        {io: fakeIo(spec).io, now: () => 1});
    let changes = 0;
    service.connect('changed', () => changes++);
    service.start();
    service.setActive(true);
    service.setActive(false);
    // Let the sample started on activation finish.
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i++)
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    eq(changes, 0);
    eq(service.snapshot, null);
    service.stop();
});

test('Btop holds the shared nvidia-smi only while shown and reading GPUs', async () => {
    const settings = fakeSettings({'sysmon-cores-expanded': false});
    const fake = fakeIo(machine({files: LIT}));
    const service = new SysmonService(settings, {io: fake.io, now: () => 1});
    service.start();
    service.setActive(true);
    ok(await waitFor(() => service.snapshot?.gpus), 'sampled');
    eq(fake.followed.map(p => p.argv.at(-1)), ['2000'], 'at the tab\'s interval');
    eq(service.snapshot.gpus[1].load, 8);
    service.setActive(false);
    ok(fake.followed[0].stopped, 'hidden');
    service.setActive(true);
    ok(await waitFor(() => fake.followed.length === 2));
    settings.set_boolean('sysmon-show-gpu', false);
    ok(fake.followed[1].stopped, 'GPU section turned off');
    service.stop();
    ok(!nvidiaLoop(fake.io).running);
});

test('a Btop sample under way when its last section, GPU, is turned off lets go as it ends', async () => {
    const values = {'sysmon-cores-expanded': false};
    for (const section of SECTIONS)
        values[`sysmon-show-${section}`] = section === 'gpu';
    const settings = fakeSettings(values);
    const fake = fakeIo(machine({files: LIT}));
    const read = fake.io.read;
    let turnedOff = false;
    // Turned off while the sample checks whether the card can sleep, before it holds.
    fake.io.read = path => {
        if (path === `${DRM}/card2/device/power/control` && !turnedOff) {
            turnedOff = true;
            settings.set_boolean('sysmon-show-gpu', false);
        }
        return read(path);
    };
    const service = new SysmonService(settings, {io: fake.io, now: () => 1});
    service.start();
    service.setActive(true);
    ok(await waitFor(() => turnedOff && !service._sampling), 'the sample ended');
    eq(service.polling, false, 'no tick comes to let it go');
    eq(fake.followed.length, 1, 'it held the loop after the section went off');
    ok(fake.followed[0].stopped, 'and let go as it ended');
    ok(!nvidiaLoop(fake.io).running);
    service.stop();
});

test('follow() goes on reading after its line handler throws', async () => {
    const dir = GLib.dir_make_tmp('froonty-sysmon-XXXXXX');
    const go = `${dir}/go`;
    const batches = [];
    let ended = false;
    // "two" waits until the handler has had "one", so they come apart.
    const child = SYSTEM_IO.follow(['/bin/sh', '-c',
        `echo one; while [ ! -e '${go}' ]; do sleep 0.02; done; echo two`], lines => {
        batches.push(lines);
        if (batches.length === 1)
            throw new Error('a bug in the handler');
    }, () => {
        ended = true;
    });
    ok(child, 'started');
    ok(await waitFor(() => batches.length === 1));
    GLib.file_set_contents(go, '');
    ok(await waitFor(() => ended), 'read to the end');
    eq(batches, [['one'], ['two']]);
    Gio.File.new_for_path(go).delete(null);
    Gio.File.new_for_path(dir).delete(null);
});

test('the panic and readout samplers hold it only while active and reading GPUs', async () => {
    const fake = fakeIo(machine({files: LIT}));
    const settings = fakeSettings({[READOUTS_INTERVAL_KEY]: 3});
    const readouts = new ReadoutMetricsService(settings, {io: fake.io, now: () => 1});
    readouts.setNeeds(['gpu'], false);
    readouts.setActive(true);
    ok(await waitFor(() => readouts.samples > 0));
    eq(fake.followed.map(p => p.argv.at(-1)), ['3000']);
    readouts.setNeeds(['memory'], false);
    ok(fake.followed[0].stopped, 'no GPU readout any more');
    readouts.setNeeds(['gpu'], false);
    ok(await waitFor(() => fake.followed.length === 2));
    readouts.setActive(false);
    ok(fake.followed[1].stopped, 'island opened');

    const panic = new PanicMetricsService(fakeSettings({[PANIC_LOAD_KEY]: 'gpu'}), {io: fake.io, now: () => 1});
    panic.start();
    panic.setActive(true);
    ok(await waitFor(() => panic.samples > 0));
    eq(fake.followed.length, 3);
    panic.stop();
    ok(fake.followed[2].stopped, 'stopped');
    readouts.stop();
    ok(!nvidiaLoop(fake.io).running);
});

await done();
