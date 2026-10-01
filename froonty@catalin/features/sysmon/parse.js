// SPDX-License-Identifier: GPL-3.0-or-later
// Parsers for what the Btop tab reads (docs/features/sysmon.md):
// the kernel's /proc and /sys text, pci.ids and nvidia-smi's CSV. Pure
// functions of text, so they load in plain gjs tests.

/**
 * The CPU's model from /proc/cpuinfo, without trademark signs and the
 * nominal clock ("Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz" ->
 * "Intel Core i7-8700").
 *
 * @returns {?string}
 */
export function parseCpuModel(cpuinfo) {
    const match = /^(?:model name|Model|Hardware)\s*:\s*(.+)$/m.exec(cpuinfo);
    if (!match)
        return null;
    return match[1]
        .replace(/\((?:R|TM|tm)\)/g, '')
        .replace(/\s+(?:CPU\s+)?@\s*[\d.]+\s*GHz\s*$/i, '')
        .replace(/\s+CPU$/i, '')
        .replace(/\s+\d+-Core Processor$/i, '')
        .replace(/\s+/g, ' ')
        .trim() || null;
}

/**
 * Each logical CPU's clock in MHz, by CPU number, from /proc/cpuinfo's
 * "cpu MHz" lines (x86 only; other architectures have none).
 *
 * @returns {Map<number, number>}
 */
export function parseCpuMhz(cpuinfo) {
    const clocks = new Map();
    for (const block of cpuinfo.split(/\n\s*\n/)) {
        const cpu = /^processor\s*:\s*(\d+)$/m.exec(block);
        const mhz = /^cpu MHz\s*:\s*([\d.]+)$/m.exec(block);
        if (cpu && mhz)
            clocks.set(Number(cpu[1]), Number(mhz[1]));
    }
    return clocks;
}

/**
 * Busy and total jiffies from /proc/stat: `all` for the "cpu" line, and
 * `cpus` by CPU number. Idle counts idle and iowait, as top does.
 *
 * @returns {{all: ?{busy: number, total: number}, cpus: Map<number, object>}}
 */
export function parseStat(text) {
    const result = {all: null, cpus: new Map()};
    for (const line of text.split('\n')) {
        const match = /^cpu(\d*)\s+(.+)$/.exec(line);
        if (!match)
            continue;
        // user nice system idle iowait irq softirq steal (guest time is
        // already in user and nice).
        const fields = match[2].trim().split(/\s+/).slice(0, 8).map(Number);
        const total = fields.reduce((sum, value) => sum + value, 0);
        const busy = total - fields[3] - (fields[4] ?? 0);
        if (match[1] === '')
            result.all = {busy, total};
        else
            result.cpus.set(Number(match[1]), {busy, total});
    }
    return result;
}

/** Percent busy between two samples of parseStat's counters; null if unknown. */
export function loadPercent(previous, current) {
    if (!previous || !current)
        return null;
    const total = current.total - previous.total;
    if (total <= 0)
        return null;
    return Math.min(100, Math.max(0, 100 * (current.busy - previous.busy) / total));
}

/**
 * /proc/meminfo, in bytes. `cache` is what `free` calls buff/cache.
 *
 * @returns {{total, used, cache, swapTotal, swapUsed}} numbers or null
 */
export function parseMeminfo(text) {
    const kb = {};
    for (const match of text.matchAll(/^(\w+):\s+(\d+)\s*kB$/gm))
        kb[match[1]] = Number(match[2]) * 1024;
    const has = key => key in kb;
    const total = kb.MemTotal ?? null;
    return {
        total,
        used: total !== null && has('MemAvailable') ? total - kb.MemAvailable : null,
        cache: has('Cached') ? kb.Cached + (kb.Buffers ?? 0) + (kb.SReclaimable ?? 0) : null,
        swapTotal: kb.SwapTotal ?? null,
        swapUsed: has('SwapTotal') && has('SwapFree') ? kb.SwapTotal - kb.SwapFree : null,
    };
}

/**
 * Received and sent bytes by interface, from /proc/net/dev.
 *
 * @returns {Map<string, {rx: number, tx: number}>}
 */
export function parseNetDev(text) {
    const counters = new Map();
    for (const line of text.split('\n')) {
        const match = /^\s*([^\s:]+):\s*(.+)$/.exec(line);
        if (!match)
            continue;
        const fields = match[2].trim().split(/\s+/).map(Number);
        if (fields.length >= 9)
            counters.set(match[1], {rx: fields[0], tx: fields[8]});
    }
    return counters;
}

// Where distributions mount the EFI system partition, most likely first.
const EFI_MOUNTS = ['/boot/efi', '/efi', '/boot'];

/**
 * The EFI system partition's mount point from /proc/self/mounts, or null.
 * Only a mounted FAT file system counts: an automount point (autofs) is
 * left alone, since reading its size would mount it.
 */
export function findEfiMount(mounts) {
    const fat = new Set();
    for (const line of mounts.split('\n')) {
        const [, target, type] = line.split(' ');
        if (type === 'vfat' || type === 'msdos')
            fat.add(unescapeMount(target));
    }
    return EFI_MOUNTS.find(path => fat.has(path)) ?? null;
}

// /proc/self/mounts writes space, tab, newline and backslash as octal.
function unescapeMount(path) {
    return path.replace(/\\([0-7]{3})/g, (_m, octal) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * The hwmon temperature input that stands for a CPU package, given each
 * input's label (null when it has none), or null.
 *
 * @param {string} chip the hwmon "name" (coretemp, k10temp, zenpower, …)
 * @param {Map<string, ?string>} labels input file ("temp1_input") -> label
 */
export function cpuPackageInput(chip, labels) {
    const wanted = {
        coretemp: [/^Package id 0$/, /^Physical id 0$/],
        k10temp: [/^Tctl$/, /^Tdie$/],
        zenpower: [/^Tdie$/, /^Tctl$/],
    }[chip] ?? [];
    for (const pattern of wanted) {
        for (const [input, label] of labels) {
            if (label && pattern.test(label))
                return input;
        }
    }
    return labels.has('temp1_input') ? 'temp1_input' : null;
}

/**
 * coretemp's per-core inputs, by core id ("Core 8" is core_id 8).
 *
 * @returns {Map<number, string>} core id -> input file
 */
export function coreInputs(labels) {
    const cores = new Map();
    for (const [input, label] of labels) {
        const match = /^Core (\d+)$/.exec(label ?? '');
        if (match)
            cores.set(Number(match[1]), input);
    }
    return cores;
}

// hwmon chips that measure the CPU, best first.
export const CPU_CHIPS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'cpu-thermal'];

const VENDORS = {'0x8086': 'Intel', '0x10de': 'NVIDIA', '0x1002': 'AMD'};

/** A short vendor name for a PCI vendor id ("0x10de"), or null. */
export function vendorName(vendorId) {
    return VENDORS[vendorId?.toLowerCase()] ?? null;
}

/**
 * A device's name from pci.ids, or null. Marketing names in brackets win
 * ("AD104M [GeForce RTX 4080 Max-Q / Mobile]" -> "GeForce RTX 4080
 * Max-Q / Mobile"), prefixed with the vendor's short name.
 *
 * @param {string} ids the pci.ids text
 * @param {string} vendorId "0x10de"
 * @param {string} deviceId "0x27e0"
 */
export function pciDeviceName(ids, vendorId, deviceId) {
    const vendor = vendorId.replace(/^0x/i, '').toLowerCase();
    const device = deviceId.replace(/^0x/i, '').toLowerCase();
    const start = ids.search(new RegExp(`^${vendor}  `, 'm'));
    if (start < 0)
        return null;
    // The vendor's devices run to the next line that does not start with a tab.
    const devices = ids.slice(ids.indexOf('\n', start) + 1);
    const end = devices.search(/^[^\t#\n]/m);
    const block = end < 0 ? devices : devices.slice(0, end);
    const match = new RegExp(`^\\t${device}  (.+)$`, 'm').exec(block);
    if (!match)
        return null;
    const bracket = /\[([^\]]+)\]/.exec(match[1]);
    const name = (bracket ? bracket[1] : match[1]).trim();
    const short = vendorName(vendorId);
    return short && !name.startsWith(short) ? `${short} ${name}` : name;
}

// nvidia-smi --query-gpu fields, in order; see NVIDIA_QUERY.
export const NVIDIA_FIELDS = ['pci.bus_id', 'name', 'utilization.gpu', 'temperature.gpu',
    'power.draw', 'memory.used', 'memory.total'];

const MIB = 1024 * 1024;

function nvidiaNumber(text) {
    const value = Number(text);
    return text === '' || !Number.isFinite(value) ? null : value;
}

/**
 * nvidia-smi's CSV (noheader, nounits) for NVIDIA_FIELDS, by PCI address
 * as sysfs writes it ("0000:01:00.0"). "[N/A]" and "[Not Supported]"
 * become null.
 *
 * @returns {Map<string, object>}
 */
export function parseNvidiaSmi(text) {
    const gpus = new Map();
    for (const line of text.split('\n')) {
        const fields = line.split(',').map(field => field.trim());
        if (fields.length < NVIDIA_FIELDS.length)
            continue;
        const [busId, name, load, temp, power, used, total] = fields;
        // nvidia-smi pads the PCI domain to 8 digits; sysfs uses 4.
        const address = busId.toLowerCase().replace(/^0000(?=[0-9a-f]{4}:)/, '');
        const memUsed = nvidiaNumber(used);
        const memTotal = nvidiaNumber(total);
        gpus.set(address, {
            name: name && !name.startsWith('[') ? name : null,
            load: nvidiaNumber(load),
            temp: nvidiaNumber(temp),
            power: nvidiaNumber(power),
            memUsed: memUsed === null ? null : memUsed * MIB,
            memTotal: memTotal === null ? null : memTotal * MIB,
        });
    }
    return gpus;
}

/** A sysfs number, scaled; null if the text is not one. */
export function sysfsNumber(text, scale = 1) {
    const value = Number(text?.trim());
    return text === null || text === undefined || text.trim() === '' || !Number.isFinite(value)
        ? null : value * scale;
}

/** Bytes per second between two counter samples `seconds` apart; null if unknown. */
export function rate(previous, current, seconds) {
    if (previous === null || previous === undefined || seconds <= 0 || current < previous)
        return null;
    return (current - previous) / seconds;
}
