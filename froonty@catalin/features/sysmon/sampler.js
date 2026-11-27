// SPDX-License-Identifier: GPL-3.0-or-later
// What the Btop tab shows, read from the kernel's /proc and /sys
// (docs/features/sysmon.md). NVIDIA's proprietary driver puts nothing of
// this in /sys, so its GPUs are read with nvidia-smi instead, and only
// while they are awake: asking a runtime-suspended GPU wakes it up.
//
// discover() finds the hardware the sections read, once per visit, the
// first time a sample reads them; sample() reads one snapshot of the
// sections asked for. Load and network speed are the change since the
// previous sample, so the first one has none. No St.

import {nvidiaLoop} from './nvidiaLoop.js';
import {
    coreInputs, CPU_CHIPS, cpuPackageInput, driveName, findEfiMount, isSnapMount,
    loadPercent, NVIDIA_FIELDS, parseCpuMhz, parseCpuModel, parseDiskMounts, parseMeminfo,
    parseNetDev, parseNvidiaSmi, parseStat, pciDeviceName, pciIdsLines, PROBE_VENDORS, rate,
    sysfsNumber, vendorName,
} from './parse.js';

export const SECTIONS = ['cpu', 'gpu', 'memory', 'disks', 'network'];

const CPU_DIR = '/sys/devices/system/cpu';
const HWMON_DIR = '/sys/class/hwmon';
const DRM_DIR = '/sys/class/drm';
const NET_DIR = '/sys/class/net';
const BLOCK_DIR = '/sys/class/block';
// Fixed system locations only, never $PATH.
const NVIDIA_SMI = ['/usr/bin/nvidia-smi', '/bin/nvidia-smi'];
const PCI_IDS = ['/usr/share/hwdata/pci.ids', '/usr/share/misc/pci.ids'];

const byNumber = (a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
const basename = path => path?.split('/').filter(Boolean).pop() ?? null;
const average = values => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

// io -> Map of "vendor:device" -> the GPU's pci.ids name (null: not in it),
// for every Sampler on that io. Module state outlives disable(), so
// SYSTEM_IO's is read from pci.ids once per GPU model and Shell process.
const gpuNames = new WeakMap();
const gpuKey = gpu => `${gpu.vendorId}:${gpu.deviceId}`.toLowerCase();

export class Sampler {
    /** @param {object} io SYSTEM_IO (io.js) or a fake of the same shape */
    constructor(io) {
        this._io = io;
        // cpu, gpu: each found the first time a sample reads it.
        this._hardware = {cpu: null, gpu: null};
        // The shared nvidia-smi (nvidiaLoop.js), while this holds it.
        this._loop = null;
        // Interface name -> whether it is a physical device (see _network).
        this._physical = new Map();
        // "source target" -> what the device is (_device), and a snap
        // image's size, which never changes while it is mounted.
        this._devices = new Map();
        this._snapSizes = new Map();
        this._previous = {time: null, stat: null, net: null};
    }

    /** Forgets the hardware and the previous sample (a new visit). */
    reset() {
        this._hardware = {cpu: null, gpu: null};
        this._previous = {time: null, stat: null, net: null};
    }

    /**
     * Lets go of the shared nvidia-smi, which stops once no sampler holds
     * it. Every user calls this when it stops sampling (hidden, disabled);
     * a later sample of a card that cannot sleep holds it again.
     */
    release() {
        this._loop?.release(this);
        this._loop = null;
    }

    /** Finds the hardware that `sections` read and is not known yet. */
    async discover(sections, cancellable = null) {
        const want = new Set(sections);
        const [cpu, gpu] = await Promise.all([
            want.has('cpu') && !this._hardware.cpu ? this._discoverCpu(cancellable) : null,
            want.has('gpu') && !this._hardware.gpu ? this._discoverGpuHardware(cancellable) : null,
        ]);
        // Cancelled reads come back empty; the next visit looks again.
        if (cancellable?.is_cancelled())
            return;
        this._hardware.cpu ??= cpu;
        this._hardware.gpu ??= gpu;
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
     * @param {?number} options.interval seconds until the next sample; with
     *   it, an NVIDIA card that cannot sleep is read from the shared
     *   nvidia-smi (nvidiaLoop.js), and the caller calls release()
     */
    async sample(sections, {cores = false, now, interval = null, cancellable = null}) {
        const want = new Set(sections);
        if (!want.has('gpu'))
            this.release();
        await this.discover(sections, cancellable);
        if (cancellable?.is_cancelled())
            return null;
        const read = path => this._io.read(path, cancellable);
        const [stat, cpuinfo, meminfo, netdev, mounts] = await Promise.all([
            want.has('cpu') ? read('/proc/stat') : null,
            want.has('cpu') ? read('/proc/cpuinfo') : null,
            want.has('memory') || want.has('disks') ? read('/proc/meminfo') : null,
            want.has('network') ? read('/proc/net/dev') : null,
            want.has('disks') ? read('/proc/self/mounts') : null,
        ]);
        // A new visit's reset() may have dropped the hardware meanwhile.
        if (cancellable?.is_cancelled())
            return null;
        const memory = meminfo === null ? null : parseMeminfo(meminfo);
        const seconds = this._previous.time === null ? 0 : now - this._previous.time;

        const [cpu, gpus, disks, network] = await Promise.all([
            want.has('cpu') ? this._cpu(stat, cpuinfo, cores, cancellable) : null,
            want.has('gpu') ? this._gpus(interval, cancellable) : null,
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

    async _discoverGpuHardware(cancellable) {
        const gpus = await this._discoverGpus(cancellable);
        const nvidiaSmi = gpus.some(gpu => gpu.driver === 'nvidia')
            ? await this._findExecutable(NVIDIA_SMI, cancellable) : null;
        return {gpus, nvidiaSmi};
    }

    async _discoverGpus(cancellable) {
        const io = this._io;
        const names = await io.list(DRM_DIR, cancellable);
        const cards = names.filter(name => /^card\d+$/.test(name)).sort(byNumber);
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
                // Its outputs ("card2-eDP-1"), for _cannotSleep.
                connectors: names.filter(name => name.startsWith(`${card}-`)).sort(),
                name: null,
            };
        }));
        const found = gpus.filter(Boolean);
        await this._nameGpus(found, cancellable);
        return found;
    }

    // From the shared names; pci.ids is read only for a GPU model without one.
    async _nameGpus(gpus, cancellable) {
        let names = gpuNames.get(this._io);
        if (!names) {
            names = new Map();
            gpuNames.set(this._io, names);
        }
        const missing = gpus.filter(gpu => !names.has(gpuKey(gpu)));
        if (missing.length) {
            const bytes = await this._readPciIds(cancellable);
            // A cancelled or failed read is no answer; the next visit reads it again.
            if (bytes && !cancellable?.is_cancelled()) {
                for (const gpu of missing) {
                    const lines = pciIdsLines(bytes, gpu.vendorId, gpu.deviceId);
                    names.set(gpuKey(gpu), lines && pciDeviceName(lines, gpu.vendorId, gpu.deviceId));
                }
            }
        }
        for (const gpu of gpus)
            gpu.name = names.get(gpuKey(gpu)) ?? vendorName(gpu.vendorId) ?? gpu.driver ?? gpu.card;
    }

    async _readPciIds(cancellable) {
        for (const path of PCI_IDS) {
            // eslint-disable-next-line no-await-in-loop
            const bytes = await this._io.readBytes(path, cancellable);
            if (bytes)
                return bytes;
        }
        return null;
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
                // The physical core (threads of one share it), for the
                // panic thermometer's average.
                core: hw.coreIds.get(cpu) ?? null,
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

    async _gpus(interval, cancellable) {
        const {gpus, nvidiaSmi} = this._hardware.gpu;
        const states = (await Promise.all(gpus.map(gpu =>
            this._io.read(`${gpu.dev}/power/runtime_status`, cancellable))))
            .map(state => state?.trim() ?? null);
        const awake = states.map(state => state !== 'suspended');

        const nvidia = gpus.filter((gpu, i) => awake[i] && gpu.driver === 'nvidia' && gpu.address);
        const followable = interval && nvidiaSmi
            ? await Promise.all(nvidia.map(gpu =>
                this._cannotSleep(gpu, states[gpus.indexOf(gpu)], cancellable)))
            : nvidia.map(() => false);
        const followed = nvidia.filter((_gpu, i) => followable[i]).map(gpu => gpu.address);
        const spawned = nvidia.filter((_gpu, i) => !followable[i]).map(gpu => gpu.address);
        // A sample its caller cancelled must not hold the loop again after
        // the caller's release().
        if (cancellable?.is_cancelled())
            return null;
        // Let go by every reader at once, so the slowest one does not keep it awake.
        if (interval && nvidiaSmi) {
            for (const address of spawned)
                nvidiaLoop(this._io).forget(address);
        }
        if (followed.length) {
            this._loop = nvidiaLoop(this._io);
            this._loop.hold(this, {path: nvidiaSmi, addresses: followed,
                intervalMs: Math.round(interval * 1000)});
        } else {
            this.release();
        }

        const [fromLoop, fromRun] = await Promise.all([
            followed.length ? this._loop.read(followed, cancellable) : new Map(),
            spawned.length && nvidiaSmi
                ? this._io.run([nvidiaSmi,
                    `--query-gpu=${NVIDIA_FIELDS.join(',')}`, '--format=csv,noheader,nounits',
                    '-i', spawned.join(',')], cancellable).then(output => parseNvidiaSmi(output ?? ''))
                : new Map(),
        ]);
        const smi = new Map([...fromRun, ...fromLoop]);
        return Promise.all(gpus.map((gpu, i) =>
            this._gpu(gpu, awake[i], smi, !nvidiaSmi, cancellable)));
    }

    // Only a card that never sleeps anyway (runtime power management off,
    // or it lights a display) may be followed: an NVML client keeps it
    // awake. These files report the kernel's state and wake nothing.
    async _cannotSleep(gpu, state, cancellable) {
        if (state === 'unsupported')
            return true;
        const read = async path => (await this._io.read(path, cancellable))?.trim() ?? null;
        const [control, statuses] = await Promise.all([
            read(`${gpu.dev}/power/control`),
            Promise.all(gpu.connectors.map(connector => read(`${DRM_DIR}/${connector}/status`))),
        ]);
        if (control === 'on')
            return true;
        const connected = gpu.connectors.filter((_connector, i) => statuses[i] === 'connected');
        const enabled = await Promise.all(connected.map(connector =>
            read(`${DRM_DIR}/${connector}/enabled`)));
        return enabled.includes('enabled');
    }

    async _gpu(gpu, awake, smi, noTool, cancellable) {
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
            result.noTool = noTool;
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

    // Every mounted drive with its size, Root first, then EFI, the others
    // by name and virtual ones last; snap images together. `root` alone is
    // what the disk readout shows.
    async _disks(memory, mounts, cancellable) {
        const all = mounts === null ? [] : parseDiskMounts(mounts);
        const snapMounts = all.filter(isSnapMount);
        const listed = all.filter(m => !isSnapMount(m));
        // A root that is no block device (a container's overlay) still counts.
        if (!listed.some(m => m.target === '/'))
            listed.unshift({source: null, target: '/', type: null});
        const efiPath = mounts === null ? null : findEfiMount(mounts);

        const [usages, devices, snapSizes] = await Promise.all([
            Promise.all(listed.map(m => this._io.filesystem(m.target, cancellable))),
            Promise.all(listed.map(m => this._device(m, cancellable))),
            Promise.all(snapMounts.map(m => this._snapSize(m, cancellable))),
        ]);
        if (!cancellable?.is_cancelled()) {
            const current = new Set(all.map(m => `${m.source} ${m.target}`));
            for (const cache of [this._devices, this._snapSizes]) {
                for (const key of cache.keys()) {
                    if (!current.has(key))
                        cache.delete(key);
                }
            }
        }

        const rank = d => d.role === 'root' ? 0 : d.role === 'efi' ? 1 : d.virtual ? 3 : 2;
        const drives = listed.map((m, i) => ({
            path: m.target,
            name: driveName(m.target),
            role: m.target === '/' ? 'root' : m.target === efiPath ? 'efi' : null,
            type: m.type,
            total: usages[i]?.total ?? null,
            used: usages[i]?.used ?? null,
            ...devices[i],
        })).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

        const sizes = snapSizes.filter(size => size !== null);
        const swap = memory?.swapTotal === null || memory?.swapTotal === undefined
            ? null : {total: memory.swapTotal, used: memory.swapUsed};
        return {
            root: usages[listed.findIndex(m => m.target === '/')] ?? null,
            swap,
            drives,
            snaps: snapMounts.length
                ? {count: snapMounts.length, total: sizes.length ? sizes.reduce((a, b) => a + b, 0) : null}
                : null,
        };
    }

    /**
     * What a mounted device is, from /sys/class/block: {model, usb,
     * virtual, probe, image}. virtual is 'probe' for a drive a debug probe
     * or bootloader emulates over USB (probe: its vendor), 'image' for a
     * disk image on a loop device (image: the file's name), else null.
     */
    async _device(mount, cancellable) {
        const key = `${mount.source} ${mount.target}`;
        if (this._devices.has(key))
            return this._devices.get(key);
        let info = {model: null, usb: false, virtual: null, probe: null, image: null};
        if (mount.source) {
            const read = async path => (await this._io.read(path, cancellable))?.trim() || null;
            // /dev/mapper/NAME and /dev/disk/by-*/… are links to the device.
            const name = basename(await this._io.link(mount.source, cancellable) ?? mount.source);
            const sys = `${BLOCK_DIR}/${name}`;
            if (name.startsWith('loop')) {
                const backing = await read(`${sys}/loop/backing_file`);
                info = {...info, virtual: 'image', image: basename(backing?.replace(/ \(deleted\)$/, ''))};
            } else {
                const [where, partition] = await Promise.all([
                    this._io.link(sys, cancellable),
                    this._io.exists(`${sys}/partition`, cancellable),
                ]);
                // A partition's folder sits in its disk's: …/block/sda/sda1.
                const parts = where?.split('/') ?? [];
                const disk = partition && parts.length > 1 ? parts[parts.length - 2] : name;
                const [vendor, model] = await Promise.all([
                    read(`${BLOCK_DIR}/${disk}/device/vendor`),
                    read(`${BLOCK_DIR}/${disk}/device/model`),
                ]);
                const usb = Boolean(where?.includes('/usb'));
                const probe = usb && PROBE_VENDORS.includes(vendor) ? vendor : null;
                info = {...info, model, usb, virtual: probe ? 'probe' : null, probe};
            }
        }
        if (!cancellable?.is_cancelled())
            this._devices.set(key, info);
        return info;
    }

    async _snapSize(mount, cancellable) {
        const key = `${mount.source} ${mount.target}`;
        if (this._snapSizes.has(key))
            return this._snapSizes.get(key);
        const size = (await this._io.filesystem(mount.target, cancellable))?.total ?? null;
        if (size !== null && !cancellable?.is_cancelled())
            this._snapSizes.set(key, size);
        return size;
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
        // A cancelled check answers false: not kept, so it is asked again.
        if (!cancellable?.is_cancelled())
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
