# Tour typefaces

Both fonts are self-hosted so the page needs no third-party requests (`font-src 'self'`).

| File | Source | Licence |
| --- | --- | --- |
| `archivo-variable.woff2` | Archivo by Omnibus-Type, from `@fontsource-variable/archivo` 5.3.0 (`archivo-latin-standard-normal.woff2`) | SIL OFL 1.1, [OFL-Archivo.txt](OFL-Archivo.txt) |
| `b612-mono-400.woff2` | B612 Mono by the B612 Project (Airbus/Intactile), from `@fontsource/b612-mono` 5.3.0 (`b612-mono-latin-400-normal.woff2`) | SIL OFL 1.1, [OFL-B612.txt](OFL-B612.txt) |

Neither licence declares a Reserved Font Name. To keep the download small, both files were reduced with fontTools 4.66:
Archivo's axes were limited to weight 400–700 and width 100–125 (`varLib.instancer`), and both fonts were subset to
Basic Latin, Latin-1 and common punctuation, arrows and math signs (`U+0020-007E, U+00A0-00FF, U+0131, U+0152-0153,
U+2010-2015, U+2018-201F, U+2022, U+2026, U+2032-2033, U+2039-203A, U+2190-2193, U+2212, U+2248, U+2264-2265`), keeping
the `kern`, `liga`, `calt`, `tnum`, `lnum`, `case`, `ccmp`, `locl`, `mark` and `mkmk` features.
