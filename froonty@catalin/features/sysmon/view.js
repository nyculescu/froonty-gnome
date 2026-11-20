// SPDX-License-Identifier: GPL-3.0-or-later
// Btop tab: CPU (with each logical CPU in a fold-out), each GPU, memory,
// disks and network, live while the tab is on screen. Actors are made
// once and their text updated on each sample; only the GPU list, the
// drive list and the core grid are rebuilt, and only when they change.
// Each share (load, used space) is its value and then a level (level.js).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {levelCells, LEVEL_GLYPHS} from './level.js';

const DASH = '—';
// From this island width (logical px), two threads share a grid row;
// narrower, each has its own.
const TWO_CORE_COLUMNS_WIDTH = 460;

const size = bytes => GLib.format_size_full(bytes, GLib.FormatSizeFlags.IEC_UNITS);
const known = value => value !== null && value !== undefined;
const percent = value => known(value) ? _('%d%%').format(Math.round(value)) : DASH;
const celsius = value => known(value) ? _('%d °C').format(Math.round(value)) : DASH;
const speed = value => known(value) ? _('%s/s').format(GLib.format_size(Math.round(value))) : DASH;
const join = parts => parts.filter(Boolean).join(' · ');

function amount(used, total) {
    return known(used) && known(total) ? _('%s / %s').format(size(used), size(total)) : DASH;
}

/** used / total in 0…1, or null when unknown. */
function share(part, whole) {
    return known(part) && whole ? part / whole : null;
}

export class SysmonView {
    constructor(service) {
        this._service = service;
        // The listed GPUs' ids; null before the first sample, '' for none.
        this._gpuKey = undefined;
        // The listed drives' mount points, the same way.
        this._driveKey = undefined;
        this._coreCount = -1;
        this._coreColumns = 0;

        this.actor = new St.BoxLayout({
            style_class: 'froonty-sysmon',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this._empty = new St.Label({
            style_class: 'froonty-sysmon-empty',
            text: _('Nothing to show. Choose what the tab shows in Settings → Btop.'),
            x_expand: true,
        });
        this._empty.clutter_text.line_wrap = true;
        this.actor.add_child(this._empty);

        const list = new St.BoxLayout({
            style_class: 'froonty-sysmon-sections',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.add_child(list);
        this.actor.add_child(this._scroll);

        this._sections = {
            cpu: this._buildCpu(list),
            gpu: this._buildGpu(list),
            memory: this._buildMemory(list),
            disks: this._buildDisks(list),
            network: this._buildNetwork(list),
        };

        this._serviceId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        this.actor.destroy();
    }

    _section(parent, title) {
        const box = new St.BoxLayout({
            style_class: 'froonty-sysmon-section',
            orientation: Clutter.Orientation.VERTICAL,
        });
        box.add_child(new St.Label({style_class: 'froonty-sysmon-heading', text: title}));
        parent.add_child(box);
        return box;
    }

    _buildCpu(parent) {
        const box = this._section(parent, _('CPU'));
        this._cpu = addMeter(box);

        const content = new St.BoxLayout({style_class: 'froonty-sysmon-expander-content'});
        this._expanderIcon = new St.Icon({icon_name: 'pan-end-symbolic'});
        this._expanderLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        content.add_child(this._expanderIcon);
        content.add_child(this._expanderLabel);
        this._expander = new St.Button({
            style_class: 'froonty-sysmon-expander',
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            child: content,
        });
        this._expander.connect('clicked', () =>
            this._service.setCoresExpanded(!this._service.coresExpanded));
        box.add_child(this._expander);

        this._coreGrid = new Clutter.GridLayout();
        this._cores = new St.Widget({
            style_class: 'froonty-sysmon-cores',
            layout_manager: this._coreGrid,
        });
        this._coreCells = [];
        box.add_child(this._cores);
        return box;
    }

    _buildGpu(parent) {
        const box = this._section(parent, _('GPU'));
        this._gpuList = new St.BoxLayout({
            style_class: 'froonty-sysmon-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._gpus = [];
        box.add_child(this._gpuList);
        return box;
    }

    _buildMemory(parent) {
        const box = this._section(parent, _('Memory'));
        this._memory = addMeter(box);
        return box;
    }

    _buildDisks(parent) {
        const box = this._section(parent, _('Disks'));
        this._driveList = new St.BoxLayout({
            style_class: 'froonty-sysmon-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._drives = [];
        box.add_child(this._driveList);
        this._snaps = addMeter(box, {level: false});
        this._swap = addMeter(box, {detail: false});
        return box;
    }

    _buildNetwork(parent) {
        const box = this._section(parent, _('Network'));
        this._download = addMeter(box, {level: false});
        this._upload = addMeter(box, {level: false});
        return box;
    }

    _sync() {
        const {sections, snapshot, coresExpanded} = this._service;
        this._empty.visible = sections.length === 0;
        this._scroll.visible = sections.length > 0;
        for (const [section, box] of Object.entries(this._sections))
            box.visible = sections.includes(section);

        if (sections.includes('cpu'))
            this._syncCpu(snapshot?.cpu ?? null, coresExpanded);
        if (sections.includes('gpu'))
            this._syncGpus(snapshot?.gpus ?? null);
        if (sections.includes('memory'))
            this._syncMemory(snapshot?.memory ?? null);
        if (sections.includes('disks'))
            this._syncDisks(snapshot?.disks ?? null);
        if (sections.includes('network'))
            this._syncNetwork(snapshot?.network ?? null);
    }

    _syncCpu(cpu, expanded) {
        this._cpu.update({
            name: cpu?.model ?? _('Processor'),
            value: percent(cpu?.load),
            fraction: share(cpu?.load, 100),
            detail: join([
                known(cpu?.ghz) && _('%s GHz').format(cpu.ghz.toFixed(2)),
                known(cpu?.temp) && celsius(cpu.temp),
            ]),
        });

        this._expanderIcon.icon_name = expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
        this._expanderLabel.text = known(cpu?.threads)
            ? _('%d threads').format(cpu.threads) : _('Threads');
        this._expander.accessible_name = expanded ? _('Hide each thread') : _('Show each thread');
        this._cores.visible = expanded;
        if (expanded && cpu?.cores)
            this._syncCores(cpu.cores);
    }

    // One grid row per one or two threads (by the island's width): name,
    // load, level, temperature.
    _syncCores(cores) {
        const columns = this._service.width >= TWO_CORE_COLUMNS_WIDTH ? 2 : 1;
        if (cores.length !== this._coreCount || columns !== this._coreColumns) {
            this._cores.destroy_all_children();
            this._coreCells = cores.map((core, i) => {
                const column = (i % columns) * 4;
                const row = Math.floor(i / columns);
                const name = new St.Label({
                    style_class: 'froonty-sysmon-core-name',
                    text: _('CPU %d').format(core.cpu),
                });
                const load = new St.Label({style_class: 'froonty-sysmon-core-value'});
                const level = new Level('froonty-sysmon-core-level');
                const temp = new St.Label({style_class: 'froonty-sysmon-core-value'});
                [name, load, level, temp].forEach((actor, j) =>
                    this._coreGrid.attach(actor, column + j, row, 1, 1));
                return {load, level, temp};
            });
            this._coreCount = cores.length;
            this._coreColumns = columns;
        }
        cores.forEach((core, i) => {
            const {load, level, temp} = this._coreCells[i];
            load.text = percent(core.load);
            level.setFraction(share(core.load, 100));
            temp.text = celsius(core.temp);
        });
    }

    _syncGpus(gpus) {
        const key = gpus ? gpus.map(gpu => gpu.id).join(',') : null;
        if (key !== this._gpuKey) {
            this._gpuList.destroy_all_children();
            this._gpus = (gpus ?? []).map(() => addMeter(this._gpuList, {steadyDetail: true}));
            if (gpus && !gpus.length) {
                this._gpuList.add_child(new St.Label({
                    style_class: 'froonty-sysmon-detail',
                    text: _('No graphics card found'),
                }));
            }
            this._gpuKey = key;
        }
        gpus?.forEach((gpu, i) => this._gpus[i].update(gpuRow(gpu)));
    }

    _syncMemory(memory) {
        this._memory.update({
            name: _('RAM'),
            value: amount(memory?.used, memory?.total),
            fraction: share(memory?.used, memory?.total),
            detail: known(memory?.cache) ? _('Cache %s').format(size(memory.cache)) : '',
        });
    }

    _syncDisks(disks) {
        // Before the first sample, one row of dashes.
        const rows = disks ? (disks.drives ?? []).map(driveRow) : [{name: _('Root'), value: DASH}];
        const key = disks ? (disks.drives ?? []).map(drive => drive.path).join('\n') : null;
        if (key !== this._driveKey) {
            this._driveList.destroy_all_children();
            this._drives = rows.map(() => addMeter(this._driveList));
            this._driveKey = key;
        }
        rows.forEach((row, i) => this._drives[i].update(row));

        this._snaps.visible = Boolean(disks?.snaps);
        if (disks?.snaps) {
            const {count, total} = disks.snaps;
            this._snaps.update({
                name: _('Snap packages'),
                tag: _('Virtual'),
                value: known(total) ? _('%d images · %s').format(count, size(total)) : _('%d images').format(count),
                detail: _('Read-only images, one per installed snap revision'),
            });
        }
        this._swap.update({
            name: _('Swap'),
            value: disks?.swap?.total ? amount(disks.swap.used, disks.swap.total)
                : disks?.swap ? _('None') : DASH,
            fraction: share(disks?.swap?.used, disks?.swap?.total || null),
        });
    }

    _syncNetwork(network) {
        const total = value => known(value) ? _('%s in total').format(GLib.format_size(value)) : '';
        this._download.update({
            name: _('Download'),
            value: speed(network?.down),
            detail: total(network?.downTotal),
        });
        this._upload.update({
            name: _('Upload'),
            value: speed(network?.up),
            detail: total(network?.upTotal),
        });
    }
}

// A GPU's row. Asleep, it says so and nothing else (user request). Intel
// reports no load: its clock stands in, and 0 MHz (power-gated) is "Idle".
function gpuRow(gpu) {
    if (gpu.asleep)
        return {name: gpu.name, value: _('Asleep'), fraction: null};
    if (gpu.noTool) {
        return {
            name: gpu.name,
            value: DASH,
            fraction: null,
            detail: _('Reading NVIDIA graphics cards needs nvidia-smi, from NVIDIA’s driver utilities'),
        };
    }
    const idle = !known(gpu.load) && gpu.mhz === 0;
    return {
        name: gpu.name,
        value: idle ? _('Idle') : percent(gpu.load),
        fraction: share(gpu.load, 100),
        detail: join([
            known(gpu.temp) && celsius(gpu.temp),
            known(gpu.power) && _('%s W').format(gpu.power.toFixed(1)),
            known(gpu.memTotal) && _('%s memory').format(amount(gpu.memUsed, gpu.memTotal)),
            gpu.mhz > 0 && _('%d MHz').format(gpu.mhz),
        ]),
    };
}

// A drive's row: its name (Root, EFI, the volume name or the mount
// point), used / total, and what it is. Virtual drives carry a tag.
function driveRow(drive) {
    const name = drive.role === 'root' ? _('Root') : drive.role === 'efi' ? _('EFI') : drive.name;
    let what;
    if (drive.virtual === 'probe')
        what = probeText(drive.probe);
    else if (drive.virtual === 'image')
        what = drive.image ? _('Disk image %s').format(drive.image) : _('Disk image');
    else
        what = join([drive.model, drive.usb && _('USB')]);
    return {
        name,
        tag: drive.virtual ? _('Virtual') : null,
        value: amount(drive.used, drive.total),
        fraction: share(drive.used, drive.total),
        // The mount point, unless it is already the name.
        detail: join([what, drive.type, name !== drive.path && drive.path]),
    };
}

// The drive a debug probe or bootloader emulates over USB, by its vendor.
function probeText(vendor) {
    switch (vendor) {
    case 'SEGGER':
        return _('SEGGER J-Link probe’s drive');
    case 'MBED':
        return _('Debug probe’s drive (ST-LINK or DAPLink)');
    case 'RPI':
        return _('Raspberry Pi RP2 bootloader’s drive');
    default:
        return _('Debug probe’s drive');
    }
}

function addMeter(parent, options) {
    const meter = new Meter(options);
    parent.add_child(meter);
    return meter;
}

// A share as five cells (level.js), one label each: a ClutterText's
// markup colours do not reach its first character, CSS classes do.
const Level = GObject.registerClass(
class Level extends St.BoxLayout {
    _init(styleClass = '') {
        super._init({style_class: `froonty-sysmon-level ${styleClass}`});
        for (let i = 0; i < LEVEL_GLYPHS.length; i++)
            this.add_child(new St.Label());
    }

    /** Shows the level for `fraction` (0…1), or hides it when unknown (null). */
    setFraction(fraction) {
        this.visible = fraction !== null;
        if (fraction === null)
            return;
        const cells = this.get_children();
        levelCells(fraction).forEach(({glyph, styleClass}, i) => {
            if (cells[i].text !== glyph)
                cells[i].text = glyph;
            if (cells[i].style_class !== styleClass)
                cells[i].style_class = styleClass;
        });
    }
});

// A name, its value and level on the right (optional), and a line of
// detail under them (optional), updated in place. Its children are found
// by name, so it holds no references of its own to release.
const Meter = GObject.registerClass(
class Meter extends St.BoxLayout {
    /**
     * @param {object} [options]
     * @param {boolean} [options.level] a level after the value
     * @param {boolean} [options.detail] a line of detail under them
     * @param {boolean} [options.steadyDetail] keep that line's room when it
     *   is empty, so the row's height never changes: a row that grew and
     *   shrank with each sample (an iGPU between idle and busy) made the
     *   list jump while scrolled to its end
     */
    _init({level = true, detail = true, steadyDetail = false} = {}) {
        super._init({
            style_class: 'froonty-sysmon-row',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._steadyDetail = steadyDetail;
        const heading = new St.BoxLayout();
        heading.add_child(new St.Label({
            name: 'name', style_class: 'froonty-sysmon-name', x_expand: true,
        }));
        heading.add_child(new St.Label({name: 'value', style_class: 'froonty-sysmon-value'}));
        if (level) {
            const levelActor = new Level();
            levelActor.name = 'level';
            heading.add_child(levelActor);
        }
        this.add_child(heading);
        if (detail)
            this.add_child(new St.Label({name: 'detail', style_class: 'froonty-sysmon-detail'}));
    }

    _part(name) {
        return this.get_children().flatMap(child => [child, ...child.get_children()])
            .find(child => child.name === name) ?? null;
    }

    // tag: a short word after the name ("Virtual"), or null.
    update({name, value, fraction = null, detail = '', tag = null}) {
        const nameLabel = this._part('name');
        if (tag) {
            const escape = text => GLib.markup_escape_text(text, -1);
            nameLabel.clutter_text.set_markup(
                `${escape(name)}  <span weight="normal" size="small" foreground="#8ab4f8">${escape(tag)}</span>`);
        } else {
            nameLabel.clutter_text.use_markup = false;
            nameLabel.text = name;
        }
        this._part('value').text = value;
        this._part('level')?.setFraction(fraction);
        const detailLabel = this._part('detail');
        if (detailLabel) {
            detailLabel.text = detail;
            detailLabel.visible = this._steadyDetail || Boolean(detail);
        }
    }
});
