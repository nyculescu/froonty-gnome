// SPDX-License-Identifier: GPL-3.0-or-later
// What the Btop tab shows, read from the kernel's /proc and /sys
// (docs/features/sysmon.md). NVIDIA's proprietary driver puts nothing of
// this in /sys, so its GPUs are read with nvidia-smi instead, and only
// while they are awake: asking a runtime-suspended GPU wakes it up.
//
// discover() finds the hardware once per visit; sample() reads one
// snapshot of the sections asked for. Load and network speed are the
// change since the previous sample, so the first one has none. No St.

import {
    coreInputs, CPU_CHIPS, cpuPackageInput, findEfiMount, loadPercent, NVIDIA_FIELDS,
    parseCpuMhz, parseCpuModel, parseMeminfo, parseNetDev, parseNvidiaSmi, parseStat,
    pciDeviceName, rate, sysfsNumber, vendorName,
} from './parse.js';

export const SECTIONS = ['cpu', 'gpu', 'memory', 'disks', 'network'];

const CPU_DIR = '/sys/devices/system/cpu';
const HWMON_DIR = '/sys/class/hwmon';
const DRM_DIR = '/sys/class/drm';
const NET_DIR = '/sys/class/net';
// Fixed system locations only, never $PATH.
const NVIDIA_SMI = ['/usr/bin/nvidia-smi', '/bin/nvidia-smi'];
const PCI_IDS = ['/usr/share/hwdata/pci.ids', '/usr/share/misc/pci.ids'];

const byNumber = (a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
const basename = path => path?.split('/').filter(Boolean).pop() ?? null;
const average = values => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export class Sampler {
    /** @param {object} io SYSTEM_IO (io.js) or a fake of the same shape */
    constructor(io) {
        this._io = io;
        this._hardware = null;
        this._pciIds = undefined;
        // Interface name -> whether it is a physical device (see _network).
        this._physical = new Map();
        this._previous = {time: null, stat: null, net: null};
    }

    /** Forgets the hardware and the previous sample (a new visit). */
    reset() {
        this._hardware = null;
        this._previous = {time: null, stat: null, net: null};
    }

    async discover(cancellable = null) {
        const [cpu, gpus] = await Promise.all([
            this._discoverCpu(cancellable),
            this._discoverGpus(cancellable),
        ]);
        const nvidiaSmi = gpus.some(gpu => gpu.driver === 'nvidia')
            ? await this._findExecutable(NVIDIA_SMI, cancellable) : null;
        this._hardware = {cpu, gpus, nvidiaSmi};
    }

    /**
     * One snapshot of `sections` (SECTIONS values). Each value is null
     * when it cannot be read on this computer. Resolves null when
     * `cancellable` was cancelled meanwhile.
     *
     * @param {string[]} sections
     * @param {object} options
     * @param {boolean} options.cores also each logical CPU
     * @param {number} options.now monotonic time in seconds
     */
    async sample(sections, {cores = false, now, cancellable = null}) {
        if (!this._hardware)
            await this.discover(cancellable);
        const want = new Set(sections);
        const read = path => this._io.read(path, cancellable);
        const [stat, cpuinfo, meminfo, netdev, mounts] = await Promise.all([
            want.has('cpu') ? read('/proc/stat') : null,
            want.has('cpu') ? read('/proc/cpuinfo') : null,
            want.has('memory') || want.has('disks') ? read('/proc/meminfo') : null,
            want.has('network') ? read('/proc/net/dev') : null,
            want.has('disks') ? read('/proc/self/mounts') : null,
        ]);
        const memory = meminfo === null ? null : parseMeminfo(meminfo);
        const seconds = this._previous.time === null ? 0 : now - this._previous.time;

        const [cpu, gpus, disks, network] = await Promise.all([
            want.has('cpu') ? this._cpu(stat, cpuinfo, cores, cancellable) : null,
            want.has('gpu') ? this._gpus(cancellable) : null,
            want.has('disks') ? this._disks(memory, mounts, cancellable) : null,
            want.has('network') ? this._network(netdev, seconds, cancellable) : null,
        ]);
        // Left for a new visit (reset()), which must not inherit it.
        if (cancellable?.is_cancelled())
            return null;

        this._previous = {
            time: now,
            stat: cpu?.stat ?? null,
            net: network?.counters ?? null,
        };
        const snapshot = {};
        if (want.has('cpu'))
            snapshot.cpu = cpu.result;
        if (want.has('gpu'))
            snapshot.gpus = gpus;
        if (want.has('memory'))
            snapshot.memory = memory && {total: memory.total, used: memory.used, cache: memory.cache};
        if (want.has('disks'))
            snapshot.disks = disks;
        if (want.has('network'))
            snapshot.network = network.result;
        return snapshot;
    }

    async _findExecutable(paths, cancellable) {
        for (const path of paths) {
            // eslint-disable-next-line no-await-in-loop
            if (await this._io.executable(path, cancellable))
                return path;
        }
        return null;
    }

    async _discoverCpu(cancellable) {
        const io = this._io;
        const cpus = (await io.list(CPU_DIR, cancellable))
            .filter(name => /^cpu\d+$/.test(name)).sort(byNumber)
            .map(name => Number(name.slice(3)));
        const [cpuinfo, coreIds, sensor] = await Promise.all([
            io.read('/proc/cpuinfo', cancellable),
            Promise.all(cpus.map(cpu =>
                io.read(`${CPU_DIR}/cpu${cpu}/topology/core_id`, cancellable)))
                .then(ids => new Map(cpus.map((cpu, i) => [cpu, sysfsNumber(ids[i])]))),
            this._discoverCpuSensor(cancellable),
        ]);
        return {
            model: cpuinfo === null ? null : parseCpuModel(cpuinfo),
            cpus,
            coreIds,
            ...sensor,
        };
    }

    // The hwmon chip that measures the CPU: its package input and, for
    // coretemp, one input per core.
    async _discoverCpuSensor(cancellable) {
        const io = this._io;
        const dirs = (await io.list(HWMON_DIR, cancellable)).map(name => `${HWMON_DIR}/${name}`);
        const chips = await Promise.all(dirs.map(dir => io.read(`${dir}/name`, cancellable)));
        let best = -1;
        let dir = null;
        chips.forEach((chip, i) => {
            const rank = CPU_CHIPS.indexOf(chip?.trim());
            if (rank >= 0 && (best < 0 || rank < best)) {
                best = rank;
                dir = dirs[i];
            }
        });
        const none = {tempDir: null, packageInput: null, coreInputs: new Map()};
        if (!dir)
            return none;

        const inputs = (await io.list(dir, cancellable)).filter(name => /^temp\d+_input$/.test(name));
        const labels = await Promise.all(inputs.map(input =>
            io.read(`${dir}/${input.replace('_input', '_label')}`, cancellable)));
        const labelled = new Map(inputs.map((input, i) => [input, labels[i]?.trim() ?? null]));
        const chip = CPU_CHIPS[best];
        return {
            tempDir: dir,
            packageInput: cpuPackageInput(chip, labelled),
            coreInputs: chip === 'coretemp' ? coreInputs(labelled) : none.coreInputs,
        };
    }

    async _discoverGpus(cancellable) {
        const io = this._io;
        const cards = (await io.list(DRM_DIR, cancellable))
            .filter(name => /^card\d+$/.test(name)).sort(byNumber);
        const gpus = await Promise.all(cards.map(async card => {
            const dev = `${DRM_DIR}/${card}/device`;
            const [vendor, device, driver, address, hwmon] = await Promise.all([
                io.read(`${dev}/vendor`, cancellable),
                io.read(`${dev}/device`, cancellable),
                io.link(`${dev}/driver`, cancellable),
                io.link(dev, cancellable),
                io.list(`${dev}/hwmon`, cancellable),
            ]);
            // PCI GPUs only; this also leaves out simpledrm's boot framebuffer.
            if (!vendor || !device)
                return null;
            return {
                card,
                dev,
                address: basename(address),
                vendorId: vendor.trim(),
                deviceId: device.trim(),
                driver: basename(driver),
                hwmon: hwmon.length ? `${dev}/hwmon/${hwmon.sort(byNumber)[0]}` : null,
                name: null,
            };
        }));
        const found = gpus.filter(Boolean);
        if (found.length) {
            const ids = await this._readPciIds(cancellable);
            for (const gpu of found) {
                gpu.name = (ids && pciDeviceName(ids, gpu.vendorId, gpu.deviceId)) ??
                    vendorName(gpu.vendorId) ?? gpu.driver ?? gpu.card;
            }
        }
        return found;
    }

    // pci.ids holds the GPUs' names; read once per Shell session.
    async _readPciIds(cancellable) {
        if (this._pciIds !== undefined)
            return this._pciIds;
        let ids = null;
        for (const path of PCI_IDS) {
            // eslint-disable-next-line no-await-in-loop
            ids = await this._io.read(path, cancellable);
            if (ids)
                break;
        }
        this._pciIds = ids;
        return ids;
    }

    async _temperature(path, cancellable) {
        return sysfsNumber(await this._io.read(path, cancellable), 1 / 1000);
    }

    async _cpu(statText, cpuinfo, withCores, cancellable) {
        const hw = this._hardware.cpu;
        const stat = statText === null ? null : parseStat(statText);
        const cpus = hw.cpus.length ? hw.cpus : [...stat?.cpus.keys() ?? []];
        let clocks = cpuinfo === null ? new Map() : parseCpuMhz(cpuinfo);
        const [scaling, packageTemp, coreTemps] = await Promise.all([
            clocks.size ? null : this._scalingClocks(cpus, cancellable),
            hw.packageInput
                ? this._temperature(`${hw.tempDir}/${hw.packageInput}`, cancellable) : null,
            withCores ? this._coreTemperatures(hw, cancellable) : null,
        ]);
        clocks = scaling ?? clocks;

        const previous = this._previous.stat;
        const mhz = average([...clocks.values()]);
        const result = {
            model: hw.model,
            ghz: mhz === null ? null : mhz / 1000,
            temp: packageTemp,
            load: loadPercent(previous?.all, stat?.all),
            threads: cpus.length || null,
            cores: null,
        };
        if (withCores) {
            result.cores = cpus.map(cpu => ({
                cpu,
                load: loadPercent(previous?.cpus.get(cpu), stat?.cpus.get(cpu)),
                ghz: clocks.has(cpu) ? clocks.get(cpu) / 1000 : null,
                temp: coreTemps.get(hw.coreIds.get(cpu)) ?? null,
            }));
        }
        return {result, stat};
    }

    // Each CPU's clock from cpufreq, for architectures whose /proc/cpuinfo
    // has none.
    async _scalingClocks(cpus, cancellable) {
        const khz = await Promise.all(cpus.map(cpu => this._io.read(
            `${CPU_DIR}/cpu${cpu}/cpufreq/scaling_cur_freq`, cancellable)));
        const clocks = new Map();
        cpus.forEach((cpu, i) => {
            const mhz = sysfsNumber(khz[i], 1 / 1000);
            if (mhz !== null)
                clocks.set(cpu, mhz);
        });
        return clocks;
    }

    // Core id -> °C, from coretemp's per-core inputs.
    async _coreTemperatures(hw, cancellable) {
        const entries = [...hw.coreInputs];
        const temps = await Promise.all(entries.map(([, input]) =>
            this._temperature(`${hw.tempDir}/${input}`, cancellable)));
        return new Map(entries.map(([core], i) => [core, temps[i]]));
    }

    async _gpus(cancellable) {
        const {gpus, nvidiaSmi} = this._hardware;
        const states = await Promise.all(gpus.map(gpu =>
            this._io.read(`${gpu.dev}/power/runtime_status`, cancellable)));
        const awake = states.map(state => state?.trim() !== 'suspended');

        const nvidia = gpus.filter((gpu, i) => awake[i] && gpu.driver === 'nvidia' && gpu.address);
        let smi = new Map();
        if (nvidia.length && nvidiaSmi) {
            const output = await this._io.run([nvidiaSmi,
                `--query-gpu=${NVIDIA_FIELDS.join(',')}`, '--format=csv,noheader,nounits',
                '-i', nvidia.map(gpu => gpu.address).join(',')], cancellable);
            smi = parseNvidiaSmi(output ?? '');
        }
        return Promise.all(gpus.map((gpu, i) => this._gpu(gpu, awake[i], smi, cancellable)));
    }

    async _gpu(gpu, awake, smi, cancellable) {
        const result = {
            id: gpu.address ?? gpu.card,
            name: gpu.name,
            asleep: !awake,
            load: null,
            temp: null,
            power: null,
            memUsed: null,
            memTotal: null,
            mhz: null,
            noTool: false,
        };
        if (!awake)
            return result;

        if (gpu.driver === 'nvidia') {
            const values = smi.get(gpu.address?.toLowerCase());
            if (values) {
                // nvidia-smi's name ("GeForce RTX 4080 Laptop GPU") is
                // more exact than pci.ids'; kept for when the GPU sleeps.
                gpu.name = values.name ? values.name : gpu.name;
                Object.assign(result, values, {name: gpu.name});
            }
            result.noTool = !this._hardware.nvidiaSmi;
            return result;
        }

        const read = path => this._io.read(path, cancellable);
        const hwmon = gpu.hwmon;
        const [temp, powerAverage, powerInput, busy, vramUsed, vramTotal, i915Mhz, xeMhz] =
            await Promise.all([
                hwmon ? read(`${hwmon}/temp1_input`) : null,
                hwmon ? read(`${hwmon}/power1_average`) : null,
                hwmon ? read(`${hwmon}/power1_input`) : null,
                gpu.driver === 'amdgpu' ? read(`${gpu.dev}/gpu_busy_percent`) : null,
                gpu.driver === 'amdgpu' ? read(`${gpu.dev}/mem_info_vram_used`) : null,
                gpu.driver === 'amdgpu' ? read(`${gpu.dev}/mem_info_vram_total`) : null,
                gpu.driver === 'i915' ? read(`${DRM_DIR}/${gpu.card}/gt_act_freq_mhz`) : null,
                gpu.driver === 'xe' ? read(`${gpu.dev}/tile0/gt0/freq0/act_freq`) : null,
            ]);
        Object.assign(result, {
            temp: sysfsNumber(temp, 1 / 1000),
            power: sysfsNumber(powerAverage, 1e-6) ?? sysfsNumber(powerInput, 1e-6),
            load: sysfsNumber(busy),
            memUsed: sysfsNumber(vramUsed),
            memTotal: sysfsNumber(vramTotal),
            mhz: sysfsNumber(i915Mhz) ?? sysfsNumber(xeMhz),
        });
        return result;
    }

    async _disks(memory, mounts, cancellable) {
        const efiPath = mounts === null ? null : findEfiMount(mounts);
        const [root, efi] = await Promise.all([
            this._io.filesystem('/', cancellable),
            efiPath ? this._io.filesystem(efiPath, cancellable) : null,
        ]);
        const swap = memory?.swapTotal === null || memory?.swapTotal === undefined
            ? null : {total: memory.swapTotal, used: memory.swapUsed};
        return {root, swap, efi: efi && {...efi, path: efiPath}};
    }

    // Physical interfaces only (those backed by a device): a VPN's or a
    // container bridge's traffic also crosses a physical one, and would
    // be counted twice.
    async _network(netdev, seconds, cancellable) {
        if (netdev === null)
            return {result: null, counters: null};
        const counters = parseNetDev(netdev);
        const unknown = [...counters.keys()].filter(name => !this._physical.has(name));
        const physical = await Promise.all(unknown.map(name =>
            this._io.exists(`${NET_DIR}/${name}/device`, cancellable)));
        unknown.forEach((name, i) => this._physical.set(name, physical[i]));

        let rx = 0;
        let tx = 0;
        for (const [name, counter] of counters) {
            if (this._physical.get(name)) {
                rx += counter.rx;
                tx += counter.tx;
            }
        }
        const previous = this._previous.net;
        return {
            result: {
                down: rate(previous?.rx, rx, seconds),
                up: rate(previous?.tx, tx, seconds),
                downTotal: rx,
                upTotal: tx,
            },
            counters: {rx, tx},
        };
    }
}
