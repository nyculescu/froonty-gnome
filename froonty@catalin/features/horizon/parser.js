// SPDX-License-Identifier: GPL-3.0-or-later
// Extracts structured items from Horizon Markdown briefings, as plain text.

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
        if (title && url)
            items.push({title: plainText(title), url, summary: plainText(summary || '')});
        current = null;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        // A blank line ends a briefing's paragraph.
        if (!trimmed) {
            if (current)
                current.inParagraph = false;
            continue;
        }

        // Horizon's own format: "### [Title](url) ⭐️ 8.0/10", then a paragraph.
        const headed = trimmed.match(/^#{2,6}\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
        if (headed) {
            pushCurrent();
            current = {title: headed[1].trim(), url: headed[2].trim(), summary: '', wantsSummary: true};
            continue;
        }
        const prose = !/^(#|\*\*|<|---|>|\||[-*]\s*\[)/.test(trimmed);
        if (current?.wantsSummary) {
            current.wantsSummary = false;
            if (prose) {
                current.summary = trimmed;
                current.inParagraph = true;
                continue;
            }
        } else if (current?.inParagraph && prose) {
            current.summary += ` ${trimmed}`;
            continue;
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

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

// Horizon's Markdown as it reads: backslash escapes (`\(`, `&\#x27;`),
// then HTML entities, links as their text, no emphasis or code marks.
export function plainText(text) {
    return text
        .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1')
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
        .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}
