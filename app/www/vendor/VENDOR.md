# vendor 来源台账

同日配套发布(2025-12-22)的 @xterm 6.0 全家桶,版本必须整体升降、禁止混搭:

| 文件 | 来源(npm, jsdelivr lib/ 构建) | 版本 | 许可 |
|---|---|---|---|
| xterm.js / xterm.css | @xterm/xterm | 6.0.0(核心内建 DEC 2026 同步输出) | MIT |
| addon-fit.js | @xterm/addon-fit | 0.11.0 | MIT |
| addon-webgl.js | @xterm/addon-webgl | 0.19.0 | MIT |
| addon-unicode-graphemes.js | @xterm/addon-unicode-graphemes | 0.4.0(grapheme 群集宽度,activeVersion='15-graphemes') | MIT |
| addon-unicode11.js | @xterm/addon-unicode11 | 0.9.0(graphemes 失效时的兜底) | MIT |
| ../fonts/CascadiaMono.woff2 | microsoft/cascadia-code release v2404.23 | 2404.23 | SIL OFL 1.1 |

UMD 全局名(逐字核实):Terminal(core 散播 globalThis)/ FitAddon.FitAddon / WebglAddon.WebglAddon /
UnicodeGraphemesAddon.UnicodeGraphemesAddon / Unicode11Addon(6.x 散播 globalThis,直接是类)。
