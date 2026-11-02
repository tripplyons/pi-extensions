# Iced renderer patches

These are crates.io sources for iced_wgpu 0.14.0 and iced_tiny_skia 0.14.1,
matching pi-desk's lockfile. Upstream: https://github.com/iced-rs/iced.
Each copy includes iced's MIT license. Cargo registry metadata and nested
lockfiles are omitted; Cargo.toml.orig is retained for comparison.

Local changes are limited to src/text.rs: round the text origin to whole
physical pixels after all transforms, before glyph rasterization. This adapts
Overseer's snap_to_pixel rule (commit cf6e271) to iced's normal text pipeline.
It covers paragraphs, editors, and cached/raw text without changing fonts,
shaping, glyph advances, layout, clipping, or hit testing. Individual glyph
advances remain the font shaper's responsibility.

Both GPU and software backends are patched. Display scale, zoom, and scrolling
already flow through their transforms; no app-global scale state is needed.

When upgrading iced, compare the upstream text pipelines and reapply the origin
rounding after transforms. Run the pixel_origin_tests library tests for each
renderer package, then pi-desk's tests and npm test.

A visual check on standard and Retina displays is still needed to assess
sharpness and the small position steps during smooth scrolling or zoom.
