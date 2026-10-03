// SPDX-License-Identifier: GPL-3.0-or-later
// The Writing tab's engines, in button order (docs/features/writing.md).
// Each is {id, title, cloud, actions, limit, busyText({chars}), destination(settings),
// availability({settings, network, cache}), run(request)}; its switch is
// writing-<id>-enabled.

import claudeCode from './claudeCode.js';
import languageTool from './languageTool.js';
import ollama from './ollama.js';

export const ENGINES = [claudeCode, languageTool, ollama];

export const enabledKey = id => `writing-${id}-enabled`;
