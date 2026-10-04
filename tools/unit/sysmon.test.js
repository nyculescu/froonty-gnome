// SPDX-License-Identifier: GPL-3.0-or-later
import {
    coreInputs, cpuPackageInput, findEfiMount, loadPercent, parseCpuMhz, parseCpuModel,
    parseMeminfo, parseNetDev, parseNvidiaSmi, parseStat, pciDeviceName, rate,
} from '../../froonty@catalin/features/sysmon/parse.js';
import {levelCells, levelClass} from '../../froonty@catalin/features/sysmon/level.js';
import {Sampler, SECTIONS} from '../../froonty@catalin/features/sysmon/sampler.js';
import {SysmonService} from '../../froonty@catalin/features/sysmon/service.js';
import {done, eq, ok, test} from './test.js';

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

// A fake /proc and /sys: `files` maps paths to text, `links` to targets.
// Directory listings come from the paths under them.
function fakeIo({files = {}, links = {}, executables = [], filesystems = {}, smi = null}) {
    const calls = [];
    const io = {
        read: async path => files[path] ?? null,
        list: async dir => {
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
    };
    return {io, calls};
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
        {cpu: 0, load: 100, ghz: 3.4, temp: 55},
        {cpu: 1, load: 33.333333333333336, ghz: 1.6, temp: 58},
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

test('disks: root, swap from meminfo, the EFI partition', async () => {
    const {second} = await twoSamples(machine(), ['disks']);
    eq(second.disks, {
        root: {total: 1000, used: 400},
        swap: {total: 8000000 * 1024, used: 1000000 * 1024},
        efi: {total: 100, used: 5, path: '/boot/efi'},
    });
});

test('sections that are off are not read', async () => {
    const reads = [];
    const fake = fakeIo(machine());
    const read = fake.io.read;
    fake.io.read = path => {
        reads.push(path);
        return read(path);
    };
    const sampler = new Sampler(fake.io);
    const snapshot = await sampler.sample(['memory'], {now: 1});
    eq(Object.keys(snapshot), ['memory']);
    ok(!reads.includes('/proc/stat'));
    ok(!reads.includes('/proc/net/dev'));
    eq(fake.calls.length, 0);
});

// Just what SysmonService uses of Gio.Settings.
function fakeSettings(values) {
    const handlers = new Map();
    let nextId = 1;
    return {
        get_boolean: key => values[key] ?? true,
        get_int: key => values[key] ?? 2,
        set_boolean: (key, value) => {
            values[key] = value;
            for (const [, {signal, fn}] of handlers) {
                if (signal === `changed::${key}`)
                    fn();
            }
        },
        connect: (signal, fn) => {
            handlers.set(nextId, {signal, fn});
            return nextId++;
        },
        disconnect: id => handlers.delete(id),
        handlers,
    };
}

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

await done();
