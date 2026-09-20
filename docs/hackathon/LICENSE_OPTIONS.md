# License options for the public edition

Status: pending owner decision. No license has been applied to the private
repository or to the export. The hackathon requires a public repository with a
detectable open-source license file; the license choice is the owner's.

## Comparison for this case

| Option | What it grants | Patent grant | Copyleft | Judge and tooling recognition | Notes for Cividian |
| --- | --- | --- | --- | --- | --- |
| MIT | Use, copy, modify, distribute, sublicense, with attribution | None explicit | No | Universal | Shortest and most familiar. No patent protection either way. |
| Apache-2.0 | Same as MIT plus an explicit patent license from contributors; requires NOTICE preservation and marking of modified files | Yes, with termination on patent litigation | No | Universal; GitHub detects it | Recommended: broad acceptance, explicit patent terms, and a NOTICE file for third-party attributions. |
| BUSL-1.1 (with a change date and additional use grant) | Source-available; production use limited until the change date, then converts to an open license (commonly Apache-2.0) | Depends on the change license | Not until conversion | Not OSI-approved; some judges and license detectors do not treat it as open source | Protects commercial use of the product, but risks failing the "open-source license" requirement. Not recommended for the submission. |

Recommendation, pending owner approval: Apache-2.0 for the public edition
only. The private Cividian repository keeps its private, all-rights-reserved
status; the license applies to the files the owner chooses to publish.

## How to apply (owner action)

1. Copy the official license text into `LICENSE` at the export root.
   Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0.txt (canonical
   text; copy it verbatim). MIT: appendix below.
2. For Apache-2.0, add a `NOTICE` file containing the product name, copyright
   line, and the third-party attributions from `THIRD_PARTY_NOTICES.md`.
3. Set `"license": "Apache-2.0"` (or `"MIT"`) in the export's `package.json`.
4. Optionally add the short license header to source files; not required.

## Appendix: MIT license text

```
MIT License

Copyright (c) 2026 Owen Crabbe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Appendix: Apache-2.0 header block

Use with the canonical license text from apache.org in `LICENSE`.

```
Copyright 2026 Owen Crabbe

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Prepared candidate on 2026-09-20

The exporter now stages canonical Apache text as `LICENSE.proposed` and
third-party attributions as `NOTICE.proposed`. This is a review package, not
a license grant. The export package stays UNLICENSED. After explicit owner
authorization, `--license-approved=Apache-2.0` applies LICENSE, NOTICE, package
metadata, README text, and manifest license labels consistently on every
re-export. The private repository's licensing is unchanged.
