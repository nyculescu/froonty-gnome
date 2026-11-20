// SPDX-License-Identifier: GPL-3.0-or-later
// Extracts structured items from Horizon Markdown briefings.

export function parseHorizonMarkdown(rawMarkdown) {
    if (!rawMarkdown)
        return [];

    const lines = rawMarkdown.replace(/\r/g, '').split('\n');
    const items = [];
    let current = null;

    const pushCurrent = () => {
        if (!current)
            return;
        const {title, url, summary} = current;
        if (title && url) {
            items.push({title, url, summary: summary || ''});
        }
        current = null;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;

        // Horizon's own format: "### [Title](url) ⭐️ 8.0/10", then a paragraph.
        const headed = trimmed.match(/^#{2,6}\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
        if (headed) {
            pushCurrent();
            current = {title: headed[1].trim(), url: headed[2].trim(), summary: '', wantsSummary: true};
            continue;
        }
        if (current?.wantsSummary) {
            current.wantsSummary = false;
            if (!/^(#|\*\*|<|---|>|\|)/.test(trimmed)) {
                current.summary = firstSentence(trimmed);
                continue;
            }
        }

        const match = trimmed.match(/^[-*]\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)(?:\s*[-–—:]\s*(.*))?$/);
        if (match) {
            pushCurrent();
            current = {title: match[1].trim(), url: match[2].trim(), summary: (match[3] || '').trim()};
            continue;
        }

        const explicit = trimmed.match(/^\*\*([^*]+)\*\*\s*\((https?:\/\/[^)\s]+)\)(?:\s*[-–—:]\s*(.*))?$/);
        if (explicit) {
            pushCurrent();
            current = {title: explicit[1].trim(), url: explicit[2].trim(), summary: (explicit[3] || '').trim()};
            continue;
        }

        const heading = trimmed.match(/^#+\s+(.+)$/);
        if (heading && current) {
            current.summary = current.summary || heading[1].trim();
            continue;
        }

        if (current && trimmed.startsWith('http')) {
            current.url ??= trimmed;
            continue;
        }

        if (!current && /^[A-Za-z0-9].*(https?:\/\/)/.test(trimmed)) {
            const link = trimmed.match(/(https?:\/\/[^\s)]+)$/);
            if (link) {
                const title = trimmed.slice(0, trimmed.length - link[1].length)
                    .replace(/^[-*\s]+|[\s:–—-]+$/g, '');
                current = {title, url: link[1].trim(), summary: ''};
                continue;
            }
        }
    }

    pushCurrent();
    return items;
}

// A Horizon paragraph's first sentence, at most SUMMARY_CHARS long.
const SUMMARY_CHARS = 220;
function firstSentence(text) {
    const end = text.search(/[.!?](\s|$)/);
    const sentence = end >= 0 ? text.slice(0, end + 1) : text;
    if (sentence.length <= SUMMARY_CHARS)
        return sentence;
    const cut = sentence.slice(0, SUMMARY_CHARS);
    return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : SUMMARY_CHARS)}…`;
}
