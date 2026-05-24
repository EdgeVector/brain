---
type: concept
title: Parity concept — unicode title café 你好 🧠
tags: [unicode, i18n]
---
Body contains unicode glyphs: café, naïve, 你好世界, مرحبا, и привет.
Plus an emoji or two for good measure: 🧠✨📚.

The round-trip must preserve the bytes exactly — fold_db stores the
body as opaque UTF-8.
