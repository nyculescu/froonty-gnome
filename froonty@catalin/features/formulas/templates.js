// SPDX-License-Identifier: GPL-3.0-or-later
// The Formulas tab's templates (docs/features/formulas.md §2): common
// structures with their slots left empty. ‸ marks the first slot, where
// the cursor goes (or a selection, and the cursor to the next; edit.js). Pure, for plain gjs tests;
// labels are translated by the view.

/** In button order. */
export const TEMPLATES = [
    {id: 'fraction', label: 'Fraction', glyph: 'a⁄b', insert: '\\frac{‸}{‸}'},
    {id: 'root', label: 'Root', glyph: '√x', insert: '\\sqrt{‸}'},
    {id: 'nth-root', label: 'n-th root', glyph: 'ⁿ√x', insert: '\\sqrt[‸]{‸}'},
    {id: 'power', label: 'Power and index', glyph: 'xⁿᵢ', insert: '‸^{‸}_{‸}'},
    {id: 'sum', label: 'Sum', glyph: '∑', insert: '\\sum_{‸}^{‸}'},
    {id: 'integral', label: 'Integral', glyph: '∫', insert: '\\int_{‸}^{‸} \\, \\mathrm{d}x'},
    {id: 'limit', label: 'Limit', glyph: 'lim', insert: '\\lim_{‸ \\to ‸}'},
    {id: 'derivative', label: 'Derivative', glyph: 'd/dx', insert: '\\frac{\\mathrm{d}‸}{\\mathrm{d}x}'},
    {id: 'partial', label: 'Partial derivative', glyph: '∂/∂x', insert: '\\frac{\\partial ‸}{\\partial x}'},
    {id: 'matrix', label: 'Matrix', glyph: '(⋱)', insert: '\\begin{pmatrix}\n‸ & ‸ \\\\\n‸ & ‸\n\\end{pmatrix}'},
    {id: 'determinant', label: 'Determinant', glyph: '|⋱|', insert: '\\begin{vmatrix}\n‸ & ‸ \\\\\n‸ & ‸\n\\end{vmatrix}'},
    {id: 'cases', label: 'Cases', glyph: '{⋮', insert: 'f(x) = \\begin{cases}\n‸ & \\text{if } ‸ \\\\\n‸ & \\text{otherwise}\n\\end{cases}'},
    {id: 'aligned', label: 'Aligned equations', glyph: '&=', insert: '\\begin{aligned}\n‸ &= ‸ \\\\\n&= ‸\n\\end{aligned}'},
    {id: 'binomial', label: 'Binomial', glyph: '(ⁿₖ)', insert: '\\binom{‸}{‸}'},
    {id: 'text', label: 'Text', glyph: 'abc', insert: '\\text{‸}'},
];

export function templateById(id) {
    return TEMPLATES.find(t => t.id === id) ?? null;
}
