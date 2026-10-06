// SPDX-License-Identifier: GPL-3.0-or-later
// Tooltips of the Writing tab and of Settings → Writing: what each action
// does, and which models did best when the prompts were tried on
// 2026-10-05 (docs/features/writing.md §3.1). In one place so the tab and
// the settings say the same; each side passes them through its gettext.

export const MODEL_ADVICE = 'Recommended: qwen3:4b-instruct-2507-q4_K_M as Model (the best editor: under a second per version), gemma3:4b as Model for Translate. As a rewriter gemma3:4b adds "Please" and "I\'m struggling", answers questions, and caused most odd results; qwen3:4b thinks first (30 s or more per version).';

export const HINTS = {
    grammar: 'Two versions. B2: a light edit that keeps your own words and your politeness. C1: a fluent rewrite, same tone, at most slightly more courteous. Both keep your directness: no "really", no added "please". Best with qwen3:4b-instruct-2507-q4_K_M.',
    shorten: 'About half the words: it cuts, never adds. A result that is not clearly shorter is asked for once more.',
    formal: 'A formal, professional tone for work e-mail or documents, still direct and concise.',
    humanize: 'Says exactly what the text says, in everyday words a real person would use: no buzzwords, no filler, same meaning and formality.',
    translate: 'Translates faithfully, with your directness and politeness; idioms by meaning, listed below the translation with an example. The languages are kept. Best with gemma3:4b as Ollama\'s Model for Translate; idioms from a 4B model are hit and miss.',
    again: 'Asks again for other wording than the versions so far for this text (they go along, to be avoided).',
    language: 'Choose the language; the choice is kept for next time.',
    ollama: MODEL_ADVICE,
    'claude-code': 'The B2/C1, Humanize, Translate and directness prompts were tried only with local models; Claude Code was not tried with them (it would count toward your plan).',
    languagetool: 'Fix grammar only: one corrected text and the list of its changes, no B2/C1 versions and no Another option.',
    firstLanguage: 'The models are told you think in this language and then write in English, so they look for its sentence structure and literal translations. English: none.',
    translateModel: 'gemma3:4b translated Romanian best of the models tried; qwen3:4b-instruct mistranslated idioms ("Nu mai trage de timp" became "Not anymore"). Empty: the Model above.',
};
