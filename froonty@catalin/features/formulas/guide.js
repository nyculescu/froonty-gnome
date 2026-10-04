// SPDX-License-Identifier: GPL-3.0-or-later
// The Formulas tab's short syntax guide (docs/features/formulas.md §2),
// written for Froonty: each topic, a line or two, and an example that
// can be put into the editor. Pure, for plain gjs tests; the view
// translates the titles and texts.

export const GUIDE = [
    {
        title: 'Letters, numbers, signs',
        text: 'Type them as they are: a + b = c. Spaces do not show; use \\, for a thin one and \\quad for a wide one.',
        example: 'a + b = c \\quad x\\,y',
    },
    {
        title: 'Commands',
        text: 'A backslash starts a command: \\alpha is α, \\le is ≤. Search the symbols by name to find one.',
        example: '\\alpha \\le \\beta',
    },
    {
        title: 'Groups',
        text: 'Braces make several characters count as one, and do not show. Write \\{ and \\} for visible braces.',
        example: 'x^{10} \\quad \\{1, 2\\}',
    },
    {
        title: 'Powers and indices',
        text: '^ raises and _ lowers the next character or group. Both can follow the same thing.',
        example: 'x_i^2 + e^{i\\pi}',
    },
    {
        title: 'Fractions and roots',
        text: '\\frac takes the top and then the bottom; \\sqrt takes what goes under it, and an optional degree in square brackets.',
        example: '\\frac{1}{2} + \\sqrt[3]{x}',
    },
    {
        title: 'Brackets that grow',
        text: 'Put \\left and \\right before a pair of brackets and they grow to fit what is inside.',
        example: '\\left( \\frac{a}{b} \\right)',
    },
    {
        title: 'Sums, integrals, limits',
        text: 'Their bounds are an index and a power. In display style they go below and above.',
        example: '\\sum_{k=1}^{n} k \\quad \\int_0^1 x \\, \\mathrm{d}x',
    },
    {
        title: 'Words in a formula',
        text: '\\text keeps the spaces and the upright letters of ordinary text. \\mathrm sets letters upright, as for units or the d of an integral.',
        example: 'v = 3 \\,\\mathrm{m/s} \\text{ at rest}',
    },
    {
        title: 'Matrices and cases',
        text: 'Inside an environment, & moves to the next column and \\\\ starts a new row. The templates start one for you.',
        example: '\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}',
    },
    {
        title: 'Lining up equations',
        text: 'In aligned, each row lines up at its & (put it before the = sign).',
        example: '\\begin{aligned} y &= (x+1)^2 \\\\ &= x^2 + 2x + 1 \\end{aligned}',
    },
    {
        title: 'Physics',
        text: '\\dv and \\pdv write derivatives, \\vb a bold vector, \\abs and \\norm bars that grow; \\hbar and \\degree are there too.',
        example: '\\pdv{\\psi}{t} \\quad \\vb{F} = m\\vb{a}',
    },
    {
        title: 'Chemistry',
        text: 'Inside \\ce, digits become subscripts, charges go up, and -> or <=> become reaction arrows.',
        example: '\\ce{2H2 + O2 -> 2H2O}',
    },
    {
        title: 'In a note',
        text: 'A note holds a formula between dollar signs: $…$ inside a line, $$…$$ on a line of its own. The copy buttons add them.',
        example: 'E = mc^2',
    },
];
