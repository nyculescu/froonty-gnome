// SPDX-License-Identifier: GPL-3.0-or-later
// The Formulas tab's symbol palettes (docs/features/formulas.md §2): each
// symbol's glyph as plain Unicode (shown without MathJax), the LaTeX it
// inserts, and the words a search finds it by. Pure, for plain gjs tests.
//
// In `insert`, ‸ marks the empty places: the cursor goes to the first;
// a selection, if any, fills the first and the cursor goes to the second
// (edit.js). The marks themselves are dropped.
// Section titles are translated by the view.

const s = (glyph, insert, words = '') => ({glyph, insert, words});

/** In palette order. */
export const SECTIONS = [
    {
        id: 'greek-lower',
        title: 'Greek letters',
        symbols: [
            s('α', '\\alpha'), s('β', '\\beta'), s('γ', '\\gamma'), s('δ', '\\delta'),
            s('ε', '\\epsilon'), s('ζ', '\\zeta'), s('η', '\\eta'), s('θ', '\\theta'),
            s('ι', '\\iota'), s('κ', '\\kappa'), s('λ', '\\lambda', 'wavelength'), s('μ', '\\mu', 'micro mean'),
            s('ν', '\\nu', 'frequency'), s('ξ', '\\xi'), s('π', '\\pi'), s('ρ', '\\rho', 'density'),
            s('σ', '\\sigma', 'standard deviation'), s('τ', '\\tau'), s('υ', '\\upsilon'), s('φ', '\\phi'),
            s('χ', '\\chi'), s('ψ', '\\psi', 'wave function'), s('ω', '\\omega', 'angular frequency'),
        ],
    },
    {
        id: 'greek-upper',
        title: 'Capital Greek letters',
        symbols: [
            s('Γ', '\\Gamma'), s('Δ', '\\Delta', 'change difference'), s('Θ', '\\Theta'),
            s('Λ', '\\Lambda'), s('Ξ', '\\Xi'), s('Π', '\\Pi'), s('Σ', '\\Sigma'),
            s('Υ', '\\Upsilon'), s('Φ', '\\Phi', 'flux'), s('Ψ', '\\Psi'), s('Ω', '\\Omega', 'ohm'),
        ],
    },
    {
        id: 'greek-variants',
        title: 'Greek variants',
        symbols: [
            s('ϵ', '\\varepsilon', 'epsilon'), s('ϑ', '\\vartheta', 'theta'), s('ϖ', '\\varpi', 'pi'),
            s('ϱ', '\\varrho', 'rho'), s('ς', '\\varsigma', 'sigma'), s('ϕ', '\\varphi', 'phi'),
            s('ϰ', '\\varkappa', 'kappa'), s('μ', '\\upmu', 'upright mu micro'),
            s('π', '\\uppi', 'upright pi'),
        ],
    },
    {
        id: 'operators',
        title: 'Operators',
        symbols: [
            s('∑', '\\sum_{‸}^{‸}', 'sum sigma'), s('∏', '\\prod_{‸}^{‸}', 'product'),
            s('∫', '\\int_{‸}^{‸}', 'integral'), s('∬', '\\iint', 'double integral'),
            s('∭', '\\iiint', 'triple integral'), s('∮', '\\oint', 'contour integral'),
            s('∂', '\\partial', 'partial derivative'), s('∇', '\\nabla', 'nabla gradient del'),
            s('lim', '\\lim_{‸}', 'limit'), s('±', '\\pm', 'plus minus'), s('∓', '\\mp', 'minus plus'),
            s('×', '\\times', 'multiply cross'), s('·', '\\cdot', 'dot multiply'),
            s('∘', '\\circ', 'compose'), s('⊗', '\\otimes', 'tensor product'), s('⊕', '\\oplus', 'direct sum'),
            s('√', '\\sqrt{‸}', 'square root'), s('∞', '\\infty', 'infinity'), s('…', '\\ldots', 'dots ellipsis'),
            s('⋯', '\\cdots', 'dots centred'), s('⋮', '\\vdots', 'dots vertical'), s('⋱', '\\ddots', 'dots diagonal'),
        ],
    },
    {
        id: 'relations',
        title: 'Relations',
        symbols: [
            s('≤', '\\leq', 'less or equal'), s('≥', '\\geq', 'greater or equal'),
            s('≠', '\\neq', 'not equal'), s('≈', '\\approx', 'approximately'),
            s('≡', '\\equiv', 'identical congruent'), s('∼', '\\sim', 'similar distributed as'),
            s('≃', '\\simeq', 'asymptotically equal'), s('≅', '\\cong', 'congruent isomorphic'),
            s('∝', '\\propto', 'proportional'), s('≪', '\\ll', 'much less'), s('≫', '\\gg', 'much greater'),
            s('≔', '\\coloneqq', 'defined as colon equals'), s('≜', '\\triangleq', 'defined as'),
            s('⊥', '\\perp', 'perpendicular'), s('∥', '\\parallel', 'parallel'), s('∣', '\\mid', 'divides given'),
        ],
    },
    {
        id: 'arrows',
        title: 'Arrows',
        symbols: [
            s('→', '\\to', 'right arrow tends'), s('←', '\\leftarrow', 'left arrow'),
            s('↔', '\\leftrightarrow', 'both arrow'), s('⇒', '\\Rightarrow', 'implies'),
            s('⇐', '\\Leftarrow', 'implied by'), s('⇔', '\\Leftrightarrow', 'if and only if iff'),
            s('⟹', '\\implies', 'implies'), s('⟺', '\\iff', 'if and only if'), s('↦', '\\mapsto', 'maps to'),
            s('↑', '\\uparrow', 'up arrow'), s('↓', '\\downarrow', 'down arrow'),
            s('⇌', '\\rightleftharpoons', 'equilibrium harpoons'), s('⟶', '\\xrightarrow{‸}', 'arrow with text over'),
        ],
    },
    {
        id: 'sets-logic',
        title: 'Sets and logic',
        symbols: [
            s('∈', '\\in', 'element of'), s('∉', '\\notin', 'not element'), s('∋', '\\ni', 'contains'),
            s('⊂', '\\subset', 'subset'), s('⊆', '\\subseteq', 'subset equal'), s('⊃', '\\supset', 'superset'),
            s('⊇', '\\supseteq', 'superset equal'), s('∪', '\\cup', 'union'), s('∩', '\\cap', 'intersection'),
            s('∖', '\\setminus', 'set minus difference'), s('∅', '\\emptyset', 'empty set'),
            s('∀', '\\forall', 'for all'), s('∃', '\\exists', 'exists'), s('∄', '\\nexists', 'not exists'),
            s('¬', '\\neg', 'not negation'), s('∧', '\\land', 'and'), s('∨', '\\lor', 'or'),
            s('⊤', '\\top', 'true top'), s('⊢', '\\vdash', 'proves'), s('⊨', '\\models', 'models entails'),
            s('{ }', '\\{ ‸ \\}', 'braces set'), s('{x∣}', '\\{\\, ‸ \\mid ‸ \\,\\}', 'set builder'),
        ],
    },
    {
        id: 'accents',
        title: 'Accents',
        symbols: [
            s('x̂', '\\hat{‸}', 'hat unit vector'), s('x̄', '\\bar{‸}', 'bar mean'),
            s('x̃', '\\tilde{‸}', 'tilde'), s('v⃗', '\\vec{‸}', 'vector arrow'),
            s('ẋ', '\\dot{‸}', 'dot time derivative'), s('ẍ', '\\ddot{‸}', 'double dot'),
            s('x̲', '\\underline{‸}', 'underline'), s('x̅', '\\overline{‸}', 'overline conjugate'),
            s('x⃡', '\\overleftrightarrow{‸}', 'line segment'), s('⏞', '\\overbrace{‸}^{‸}', 'overbrace'),
            s('⏟', '\\underbrace{‸}_{‸}', 'underbrace'), s('x̸', '\\cancel{‸}', 'cancel strike'),
        ],
    },
    {
        id: 'brackets',
        title: 'Brackets',
        symbols: [
            s('( )', '\\left( ‸ \\right)', 'parentheses round'), s('[ ]', '\\left[ ‸ \\right]', 'square'),
            s('{ }', '\\left\\{ ‸ \\right\\}', 'curly braces'), s('⟨ ⟩', '\\langle ‸ \\rangle', 'angle'),
            s('| |', '\\left| ‸ \\right|', 'absolute value'), s('‖ ‖', '\\left\\| ‸ \\right\\|', 'norm'),
            s('⌊ ⌋', '\\lfloor ‸ \\rfloor', 'floor'), s('⌈ ⌉', '\\lceil ‸ \\rceil', 'ceiling'),
            s('⟨|⟩', '\\braket{‸}', 'bra ket dirac'), s('|⟩', '\\ket{‸}', 'ket dirac'), s('⟨|', '\\bra{‸}', 'bra dirac'),
        ],
    },
    {
        id: 'sets-fonts',
        title: 'Number sets and fonts',
        symbols: [
            s('ℕ', '\\mathbb{N}', 'natural numbers'), s('ℤ', '\\mathbb{Z}', 'integers'),
            s('ℚ', '\\mathbb{Q}', 'rationals'), s('ℝ', '\\mathbb{R}', 'reals real numbers'),
            s('ℂ', '\\mathbb{C}', 'complex numbers'), s('𝔸', '\\mathbb{‸}', 'blackboard bold'),
            s('𝒜', '\\mathcal{‸}', 'calligraphic'), s('𝓐', '\\mathscr{‸}', 'script'),
            s('𝔤', '\\mathfrak{‸}', 'fraktur'), s('𝐱', '\\mathbf{‸}', 'bold'),
            s('𝝁', '\\boldsymbol{‸}', 'bold symbol greek'), s('x', '\\mathrm{‸}', 'upright roman'),
            s('𝗑', '\\mathsf{‸}', 'sans serif'), s('𝚡', '\\mathtt{‸}', 'typewriter monospace'),
            s('abc', '\\text{‸}', 'text words'),
        ],
    },
    {
        id: 'functions',
        title: 'Functions',
        symbols: [
            s('sin', '\\sin', 'sine'), s('cos', '\\cos', 'cosine'), s('tan', '\\tan', 'tangent'),
            s('arcsin', '\\arcsin'), s('arccos', '\\arccos'), s('arctan', '\\arctan'),
            s('sinh', '\\sinh'), s('cosh', '\\cosh'), s('tanh', '\\tanh'),
            s('exp', '\\exp', 'exponential'), s('log', '\\log', 'logarithm'), s('ln', '\\ln', 'natural logarithm'),
            s('max', '\\max'), s('min', '\\min'), s('sup', '\\sup', 'supremum'), s('inf', '\\inf', 'infimum'),
            s('det', '\\det', 'determinant'), s('dim', '\\dim', 'dimension'), s('ker', '\\ker', 'kernel'),
            s('arg max', '\\operatorname*{arg\\,max}_{‸}', 'argmax'), s('f(x)', '\\operatorname{‸}', 'operator name'),
        ],
    },
    {
        id: 'physics',
        title: 'Physics and units',
        symbols: [
            s('ℏ', '\\hbar', 'h bar reduced planck'), s('°', '\\degree', 'degree'), s('℃', '\\celsius', 'celsius'),
            s('Å', '\\AA', 'angstrom'), s('Ω', '\\ohm', 'ohm'), s('µ', '\\micro', 'micro'),
            s('d', '\\mathrm{d}', 'upright d differential'), s('dx', '\\dd{‸}', 'differential dd'),
            s('d/dx', '\\dv{‸}{x}', 'derivative dv'), s('∂/∂x', '\\pdv{‸}{x}', 'partial derivative pdv'),
            s('𝐯', '\\vb{‸}', 'bold vector vb'), s('v⃗', '\\va{‸}', 'arrow vector va'),
            s('x̂', '\\vu{‸}', 'unit vector vu'), s('∇·', '\\div', 'divergence'),
            s('∇×', '\\curl', 'curl'), s('∇', '\\grad', 'gradient'), s('∇²', '\\laplacian', 'laplacian'),
            s('|x|', '\\abs{‸}', 'absolute value abs'), s('‖x‖', '\\norm{‸}', 'norm'),
            s('⟨x⟩', '\\expval{‸}', 'expectation value'), s('m s⁻¹', '\\,\\mathrm{m\\,s^{-1}}', 'unit metre second'),
        ],
    },
    {
        id: 'statistics',
        title: 'Statistics',
        symbols: [
            s('𝔼', '\\mathbb{E}[‸]', 'expectation expected value'), s('Var', '\\operatorname{Var}(‸)', 'variance'),
            s('Cov', '\\operatorname{Cov}(‸)', 'covariance'), s('ℙ', '\\mathbb{P}(‸)', 'probability'),
            s('P(A|B)', 'P(‸ \\mid ‸)', 'conditional probability'), s('x̄', '\\bar{x}', 'sample mean'),
            s('σ²', '\\sigma^2', 'variance sigma squared'), s('𝒩', '\\mathcal{N}(\\mu, \\sigma^2)', 'normal distribution gaussian'),
            s('∼', '\\sim', 'distributed as'), s('(n k)', '\\binom{‸}{‸}', 'binomial choose'),
            s('θ̂', '\\hat{\\theta}', 'estimator'),
        ],
    },
    {
        id: 'chemistry',
        title: 'Chemistry',
        symbols: [
            s('H₂O', '\\ce{H2O}', 'water ce'), s('A→B', '\\ce{‸ -> ‸}', 'reaction arrow'),
            s('A⇌B', '\\ce{‸ <=> ‸}', 'equilibrium'), s('SO₄²⁻', '\\ce{SO4^2-}', 'ion charge sulfate'),
            s('↑', '\\ce{ ^}', 'gas'), s('↓', '\\ce{ v}', 'precipitate'), s('ce', '\\ce{‸}', 'chemistry formula'),
        ],
    },
];

const WORD = /[A-Za-z]+/g;

// The searchable names of a symbol: its command's words (\mathbb{R} →
// mathbb, r) and its keywords.
function terms(symbol) {
    return [...(symbol.insert.match(WORD) ?? []), ...symbol.words.split(/\s+/)]
        .filter(Boolean).map(term => term.toLowerCase());
}

/**
 * Symbols matching a search, best first: a command starting with the
 * query (alpha), then a keyword starting with it (approximately), then
 * either containing it; or the glyph itself. Each symbol once.
 *
 * @param {string} query
 * @param {object[]} [sections]
 * @returns {object[]} symbols, each with its section's id
 */
export function searchSymbols(query, sections = SECTIONS) {
    const q = query.trim().replace(/^\\/, '').toLowerCase();
    if (!q)
        return [];
    const ranked = [];
    for (const section of sections) {
        for (const symbol of section.symbols) {
            const command = (symbol.insert.match(/^\\([A-Za-z]+)/)?.[1] ?? '').toLowerCase();
            const all = terms(symbol);
            let rank;
            if (command === q || symbol.glyph === query.trim())
                rank = 0;
            else if (command.startsWith(q))
                rank = 1;
            else if (all.some(term => term.startsWith(q)))
                rank = 2;
            else if (all.some(term => term.includes(q)) || symbol.words.toLowerCase().includes(q))
                rank = 3;
            else
                continue;
            ranked.push({rank, order: ranked.length, symbol: {...symbol, section: section.id}});
        }
    }
    ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
    const seen = new Set();
    return ranked.map(r => r.symbol).filter(symbol => {
        const key = symbol.insert;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
