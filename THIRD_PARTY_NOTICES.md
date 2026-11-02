# Third-party notices

mcf-linter-spark is licensed under the MIT License (see `LICENSE`). It includes or is
derived from the following third-party material. The `THIRD_PARTY_NOTICES.md` of a release and
of the VSCode extension also lists the licenses of the JavaScript packages bundled into them.

## vanilla-mcdoc

On first use mcf-linter-spark downloads the `symbols.json` that the `generated` branch of
[vanilla-mcdoc](https://github.com/SpyglassMC/vanilla-mcdoc) exports, the schema of NBT and
data pack JSON that it checks against, and caches it on the user's machine. vanilla-mcdoc
is licensed under the MIT License, Copyright (c) 2022 SpyglassMC.

## Spyglass and Datapack Helper Plus

mcf-linter-spark contains no code from these projects. Its diagnostics and their messages are
written to match theirs.

- Spyglass: https://github.com/SpyglassMC/Spyglass, MIT License,
  Copyright (c) 2019-2025 SPGoding and SpyglassMC contributors
- Datapack Helper Plus (datapack-language-server): MIT License,
  Copyright (c) 2019-2020 SPGoding
- datapack-linter: MIT License, Copyright (c) 2020-2024 chen

## Minecraft data

mcf-linter-spark does not include data from Minecraft. On first use it downloads the command
tree, the registries, the block states, and the lists of the vanilla data pack's
resources and tags for the game version from the summary of
[mcmeta](https://github.com/misode/mcmeta) by misode, which is generated with the
data generator of the Minecraft: Java Edition server, and caches them on the user's
machine. mcf-linter-spark is not an official Minecraft product and is not approved by or
associated with Mojang or Microsoft.
