# Break ideas: licences

`ideas.json` holds short break ideas from two projects. Each idea's
`source` names its project, and `sources` in the file records the commit
it was taken from. Froonty chose which ideas to keep and fixed the wording
of a few (grammar, full stops). `tools/import-break-ideas.py` in Froonty's
repository lists every decision and every change, original next to kept.

## Stretchly (`"source": "stretchly"`)

- **Source:** <https://github.com/hovancik/stretchly>, commit
  `3cb3af2d480c352ed903007426fd86e1226bd6fc` (2026-10-15), files
  `app/utils/defaultMicrobreakIdeas.js` and `app/utils/defaultBreakIdeas.js`.
- **Licence:** BSD-2-Clause. Its conditions require this notice to go with
  every copy. Stretchly's `LICENSE` file, verbatim:

```
Copyright (c) 2016-, Jan Hovancik
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Safe Eyes (`"source": "safeeyes"`)

- **Source:** <https://github.com/slgobinath/safeeyes>, commit
  `4637d80ae59ab1fc0d980431ebd95fe63a60d5df` (2026-10-13), file
  `safeeyes/config/safeeyes.json`: the English names of `short_breaks` and
  `long_breaks`.
- **Licence:** GPL-3.0-or-later, as `pyproject.toml` declares it. Its
  source headers say "either version 3 of the License, or (at your option)
  any later version". Froonty has the same licence (GNU GPL version 3 or
  later, Froonty's `LICENSE`), so these texts need no separate notice.
- **Copyright:** Gobinath Loganathan and the Safe Eyes contributors. The
  source headers say "Copyright (C) 2016 Gobinath", and `pyproject.toml`
  names Gobinath Loganathan as the author.
