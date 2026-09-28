// SPDX-License-Identifier: GPL-3.0-or-later
// Base class for feature services: connect()/disconnect()/emit().
//
// GNOME Shell's EventEmitter (misc/signals.js) is built on the same GJS
// signals module but lives in a resource that only exists inside the
// Shell. Services extend this instead, so they also load in plain `gjs`
// unit tests. Views keep the handler ids and disconnect them in destroy().

const Signals = imports.signals;

export class Emitter {}

Signals.addSignalMethods(Emitter.prototype);
